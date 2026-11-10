import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError, notFound, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { getObject, putObject, rawPath, removeObjects } from '../lib/storage.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';
import { uploadRateLimit } from '../middleware/rateLimit.js';
import { requireUuidParam, validate, validQuery } from '../middleware/validate.js';
import {
  type ColumnRow,
  DATASET_COLUMNS,
  type DatasetRow,
  getColumns,
  getDetail,
  getOwnDataset,
  toDataset,
} from '../services/datasets.js';
import { assertWithinLimit } from '../services/limits.js';
import { checkFileContent } from '../services/parsing/content.js';
import { PII_SEMANTICS, placeholderFor } from '../services/parsing/pii.js';
import { enqueueProfiling } from '../services/profiling.js';
import { recordUsage } from '../services/usageEvents.js';
import type {
  ColumnDataType,
  ColumnSemantic,
  DatasetPreview,
  Deleted,
  Paged,
  ReparseRequest,
  UpdateDatasetRequest,
} from '../types/api.js';

export const datasetsRouter = Router();

const MB = 1024 * 1024;
const round2 = (n: number) => Math.ceil(n * 100) / 100;

const SEMANTICS = [
  'none', 'currency_zar', 'percentage', 'identifier', 'category', 'email', 'phone', 'sa_id_number', 'person_name', 'address', 'free_text',
] as const satisfies readonly ColumnSemantic[];

// ---------- POST /datasets ----------

/**
 * Reads the multipart body. A file above the hard ceiling stops the read early; we still finish the
 * other checks in the contract's order, so the oversize flag is returned rather than thrown.
 */
function receive(req: Request, res: Response): Promise<{ tooLarge: boolean }> {
  const handler = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { files: 1, fields: 5, fieldSize: 4096, parts: 8, fileSize: env().MAX_UPLOAD_MB * MB },
  }).single('file');
  return new Promise((resolve, reject) => {
    handler(req, res, (err: unknown) => {
      if (!err) return resolve({ tooLarge: false });
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return resolve({ tooLarge: true });
        return reject(new AppError('validation_failed', 'Send one file in the "file" field, plus workspace_id and an optional name.'));
      }
      // Not multipart, or the stream broke.
      return reject(new AppError('validation_failed', 'Send the upload as multipart/form-data.'));
    });
  });
}

const uploadFields = z.strictObject({
  workspace_id: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
});

/** The original name with any path removed, trimmed, at most 200 characters. Never used in a storage path. */
function cleanFilename(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  return base.trim().slice(0, 200) || 'upload';
}

function defaultName(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]{1,10}$/, '').trim();
  return (withoutExt || filename).slice(0, 200).trim() || 'Untitled dataset';
}

datasetsRouter.post('/datasets', uploadRateLimit, async (req, res) => {
  const { userId, token } = authOf(req);
  const { tooLarge } = await receive(req, res);

  const fields = uploadFields.safeParse(req.body ?? {});
  if (!fields.success) {
    throw new AppError('validation_failed', 'Some fields are not valid.', {
      fields: fields.error.issues.map((i) => ({ location: 'body', path: i.path.join('.'), message: i.message })),
    });
  }
  const file = req.file;
  if (!file && !tooLarge) {
    throw new AppError('validation_failed', 'Choose a file to upload.', {
      fields: [{ location: 'body', path: 'file', message: 'Required' }],
    });
  }

  // Order of checks per the contract: workspace, monthly limit, plan size, hard ceiling, content.
  const { data: ws, error: wsError } = await supabaseForUser(token)
    .from('workspaces')
    .select('id')
    .eq('id', fields.data.workspace_id)
    .eq('owner_id', userId)
    .maybeSingle();
  throwIfDbError('datasets: workspace', wsError);
  if (!ws) throw notFound('Workspace not found.');

  await assertWithinLimit(userId, 'max_datasets_per_month');
  // Above the hard ceiling no plan helps, so that is 413 rather than an upgrade prompt.
  if (tooLarge) throw new AppError('file_too_large', `Files can be at most ${env().MAX_UPLOAD_MB} MB.`);
  await assertWithinLimit(userId, 'max_file_mb', round2(file!.size / MB));

  const { fileType, ext } = checkFileContent(file!.buffer);
  const id = randomUUID();
  const originalFilename = cleanFilename(file!.originalname);
  const path = rawPath(userId, id, ext);
  await putObject(path, file!.buffer, ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');

  const { data: row, error } = await supabaseAdmin()
    .from('datasets')
    .insert({
      id,
      owner_id: userId,
      workspace_id: fields.data.workspace_id,
      name: fields.data.name ?? defaultName(originalFilename),
      original_filename: originalFilename,
      file_type: fileType,
      size_bytes: file!.size,
      storage_path: path,
      status: 'profiling',
    })
    .select(DATASET_COLUMNS)
    .single<DatasetRow>();
  if (error) {
    await removeObjects([path]).catch(() => undefined);
    throwIfDbError('datasets: insert', error);
  }
  // Counted when the upload is accepted; not refunded if profiling later fails.
  await recordUsage(userId, 'upload', { dataset_id: id, size_bytes: file!.size, file_type: fileType });
  ok(res, toDataset(row!), 201);
  enqueueProfiling({ datasetId: id, ownerId: userId, overrides: {} });
});

// ---------- GET /datasets ----------

const listQuery = z.strictObject({
  workspace_id: z.uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

datasetsRouter.get('/datasets', validate({ query: listQuery }), async (req, res) => {
  const { userId, token } = authOf(req);
  const q = validQuery<z.infer<typeof listQuery>>(req);
  const db = supabaseForUser(token);
  const { data: ws, error: wsError } = await db
    .from('workspaces')
    .select('id')
    .eq('id', q.workspace_id)
    .eq('owner_id', userId)
    .maybeSingle();
  throwIfDbError('datasets: workspace', wsError);
  if (!ws) throw notFound('Workspace not found.');
  const { data, count, error } = await db
    .from('datasets')
    .select(DATASET_COLUMNS, { count: 'exact' })
    .eq('owner_id', userId)
    .eq('workspace_id', q.workspace_id)
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1)
    .returns<DatasetRow[]>();
  throwIfDbError('datasets: list', error);
  const page: Paged<ReturnType<typeof toDataset>> = {
    items: (data ?? []).map(toDataset),
    total: count ?? 0,
    limit: q.limit,
    offset: q.offset,
  };
  ok(res, page);
});

// ---------- GET /datasets/:id ----------

datasetsRouter.get('/datasets/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  ok(res, await getDetail(supabaseForUser(token), userId, req.params.id as string));
});

// ---------- PATCH /datasets/:id ----------

const patchBody = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    columns: z
      .array(
        z.strictObject({
          id: z.uuid(),
          display_name: z.string().trim().min(1).max(120).nullable().optional(),
          semantic: z.enum(SEMANTICS).optional(),
          is_pii: z.boolean().optional(),
          vat_included: z.boolean().nullable().optional(),
        }),
      )
      .max(500)
      .optional(),
  })
  .refine((b) => b.name !== undefined || (b.columns !== undefined && b.columns.length > 0), {
    message: 'Send a name or at least one column change.',
  });

/** Up to 5 distinct non-empty values per requested column, read from the normalised file. */
async function realSamples(path: string | null, sqlNames: string[]): Promise<Map<string, string[]>> {
  const result = new Map(sqlNames.map((n) => [n, [] as string[]]));
  if (!path || sqlNames.length === 0) return result;
  const file = await getObject(path);
  if (!file) return result;
  const parser = Readable.from([file]).pipe(parse({ columns: true, relax_column_count: true }));
  try {
    let rows = 0;
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      let done = true;
      for (const name of sqlNames) {
        const list = result.get(name)!;
        const v = row[name] ?? '';
        if (list.length < 5 && v !== '' && !list.includes(v)) list.push(v);
        if (list.length < 5) done = false;
      }
      if (done || ++rows >= 10_000) break;
    }
  } finally {
    parser.destroy();
  }
  return result;
}

datasetsRouter.patch('/datasets/:id', requireUuidParam(), validate({ body: patchBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const id = req.params.id as string;
  const body = req.body as UpdateDatasetRequest;
  const db = supabaseForUser(token);
  const dataset = await getOwnDataset(db, userId, id);
  const current = new Map((await getColumns(db, id)).map((c) => [c.id, c]));

  const changes = body.columns ?? [];
  const fieldErrors: Array<{ location: 'body'; path: string; message: string }> = [];
  const seen = new Set<string>();
  changes.forEach((c, i) => {
    if (!current.has(c.id)) fieldErrors.push({ location: 'body', path: `columns.${i}.id`, message: 'This column is not part of this dataset.' });
    if (seen.has(c.id)) fieldErrors.push({ location: 'body', path: `columns.${i}.id`, message: 'This column appears twice.' });
    seen.add(c.id);
  });
  if (fieldErrors.length > 0) throw new AppError('validation_failed', 'Some fields are not valid.', { fields: fieldErrors });

  const updates = changes.map((change) => {
    const col = current.get(change.id)!;
    const semantic = change.semantic ?? col.semantic;
    let isPii = change.is_pii ?? col.is_pii;
    // A personal-data meaning flags the column unless the same request says otherwise.
    if (change.semantic !== undefined && change.is_pii === undefined && PII_SEMANTICS.has(change.semantic)) isPii = true;
    const patch: Partial<ColumnRow> = {};
    if (change.display_name !== undefined) patch.display_name = change.display_name;
    if (change.semantic !== undefined) patch.semantic = semantic;
    if (change.vat_included !== undefined) patch.vat_included = change.vat_included;
    if (isPii !== col.is_pii) patch.is_pii = isPii;
    return { col, patch, isPii, semantic };
  });

  const unmasking = updates.filter((u) => u.patch.is_pii === false).map((u) => u.col.sql_name);
  const samples = await realSamples(dataset.status === 'expired' ? null : dataset.normalised_path, unmasking);
  for (const u of updates) {
    if (u.patch.is_pii === true) {
      const count = u.col.sample_values.length || Math.min(5, u.col.distinct_count);
      u.patch.sample_values = Array.from({ length: count }, () => placeholderFor(u.semantic, u.col.name));
    } else if (u.patch.is_pii === false) {
      u.patch.sample_values = samples.get(u.col.sql_name) ?? [];
    } else if (u.isPii && u.patch.semantic !== undefined) {
      // Still PII with a new meaning: refresh the placeholder.
      u.patch.sample_values = u.col.sample_values.map(() => placeholderFor(u.semantic, u.col.name));
    }
  }

  const admin = supabaseAdmin();
  for (const u of updates) {
    if (Object.keys(u.patch).length === 0) continue;
    const { error } = await admin
      .from('dataset_columns')
      .update(u.patch)
      .eq('id', u.col.id)
      .eq('dataset_id', id)
      .eq('owner_id', userId);
    throwIfDbError('datasets: update column', error);
  }
  if (body.name !== undefined) {
    const { error } = await admin.from('datasets').update({ name: body.name }).eq('id', id).eq('owner_id', userId);
    throwIfDbError('datasets: rename', error);
  }
  ok(res, await getDetail(db, userId, id));
});

// ---------- POST /datasets/:id/reparse ----------

const reparseBody = z.strictObject({
  sheet_name: z.string().min(1).max(200).nullable().optional(),
  header_row: z.number().int().min(1).max(100_000).nullable().optional(),
  delimiter: z.enum([',', ';', '\t', '|']).nullable().optional(),
  decimal_separator: z.enum(['.', ',']).nullable().optional(),
  date_format: z.enum(['dmy', 'mdy', 'ymd']).nullable().optional(),
});

datasetsRouter.post('/datasets/:id/reparse', requireUuidParam(), validate({ body: reparseBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const id = req.params.id as string;
  const options = req.body as ReparseRequest;
  const dataset = await getOwnDataset(supabaseForUser(token), userId, id);
  if (dataset.status === 'profiling' || dataset.status === 'uploading') {
    throw new AppError('conflict', 'This file is still being read. Wait for it to finish, then try again.');
  }
  if (dataset.status === 'expired') throw new AppError('dataset_expired', 'The source file was removed after the retention period.');
  if (options.sheet_name && !dataset.sheet_names.includes(options.sheet_name)) {
    throw new AppError('validation_failed', 'Some fields are not valid.', {
      fields: [{ location: 'body', path: 'sheet_name', message: 'There is no sheet with this name in the workbook.' }],
    });
  }

  const { data: row, error } = await supabaseAdmin()
    .from('datasets')
    .update({ status: 'profiling', error_message: null, error_details: null, suggestions: [] })
    .eq('id', id)
    .eq('owner_id', userId)
    .in('status', ['ready', 'failed'])
    .select(DATASET_COLUMNS)
    .maybeSingle<DatasetRow>();
  throwIfDbError('datasets: reparse', error);
  if (!row) throw new AppError('conflict', 'This file is still being read. Wait for it to finish, then try again.');
  ok(res, toDataset(row), 202);
  enqueueProfiling({ datasetId: id, ownerId: userId, overrides: options });
});

// ---------- GET /datasets/:id/preview ----------

const previewQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) });

function typed(value: string, type: ColumnDataType): string | number | boolean | null {
  if (value === '') return null;
  if (type === 'integer' || type === 'decimal') return Number(value);
  if (type === 'boolean') return value === 'true';
  return value;
}

datasetsRouter.get('/datasets/:id/preview', requireUuidParam(), validate({ query: previewQuery }), async (req, res) => {
  const { userId, token } = authOf(req);
  const id = req.params.id as string;
  const { limit } = validQuery<z.infer<typeof previewQuery>>(req);
  const db = supabaseForUser(token);
  const dataset = await getOwnDataset(db, userId, id);
  if (dataset.status === 'expired') throw new AppError('dataset_expired', 'The source file was removed after the retention period.');
  if (dataset.status !== 'ready') throw new AppError('dataset_not_ready', 'This file is not ready yet.');
  const file = dataset.normalised_path ? await getObject(dataset.normalised_path) : null;
  if (!file) throw new AppError('dataset_expired', 'The source file is no longer available.');

  const columns = await getColumns(db, id);
  const rows: DatasetPreview['rows'] = [];
  const parser = Readable.from([file]).pipe(parse({ columns: true, relax_column_count: true }));
  try {
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      rows.push(Object.fromEntries(columns.map((c) => [c.sql_name, typed(record[c.sql_name] ?? '', c.data_type)])));
      if (rows.length >= limit) break;
    }
  } finally {
    parser.destroy();
  }
  const preview: DatasetPreview = {
    columns: columns.map((c) => ({ sql_name: c.sql_name, label: c.display_name ?? c.name, data_type: c.data_type })),
    rows,
    total_rows: dataset.row_count ?? 0,
  };
  ok(res, preview);
});

// ---------- DELETE /datasets/:id ----------

datasetsRouter.delete('/datasets/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const id = req.params.id as string;
  const dataset = await getOwnDataset(supabaseForUser(token), userId, id);
  // Files first: if removing them fails the row stays, so the user can retry and nothing is orphaned.
  await removeObjects([dataset.storage_path, dataset.normalised_path]);
  // blocks.dataset_id is ON DELETE SET NULL, so answers survive.
  const { error } = await supabaseAdmin().from('datasets').delete().eq('id', id).eq('owner_id', userId);
  throwIfDbError('datasets: delete', error);
  const deleted: Deleted = { deleted: true };
  ok(res, deleted);
});
