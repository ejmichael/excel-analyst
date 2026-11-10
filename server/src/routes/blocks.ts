import { Router, type Response } from 'express';
import { z } from 'zod';
import { AppError, notFound, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { getObject } from '../lib/storage.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';
import { llm } from '../llm/client.js';
import { askRateLimit } from '../middleware/rateLimit.js';
import { requireUuidParam, validate, validQuery } from '../middleware/validate.js';
import { ask, AskLlmFailure } from '../services/analysis/ask.js';
import { BLOCK_COLUMNS, type BlockRow, getOwnBlock, toBlock } from '../services/blocks.js';
import { type ColumnRow, type DatasetRow, getColumns, getOwnDataset } from '../services/datasets.js';
import { assertWithinLimit } from '../services/limits.js';
import { SandboxError, withSandbox } from '../services/sandbox/sandbox.js';
import { recordLlmUsage, recordUsage } from '../services/usageEvents.js';
import type { Ack, AskRequest, Block, BlockFeedbackRequest, CellValue, ColumnDataType, Deleted, Paged, SourceRows } from '../types/api.js';

export const blocksRouter = Router();

const CHART_TYPES = ['table', 'bar', 'line', 'area', 'pie', 'kpi'] as const;

/** A ready dataset and its normalised file, or 404 / 410 / 409 in the contract's order. */
async function readyDataset(token: string, userId: string, id: string): Promise<{ dataset: DatasetRow; columns: ColumnRow[]; csv: Buffer }> {
  const db = supabaseForUser(token);
  const dataset = await getOwnDataset(db, userId, id);
  if (dataset.status === 'expired') throw new AppError('dataset_expired', 'The source file was removed after the retention period.');
  if (dataset.status !== 'ready') throw new AppError('dataset_not_ready', 'This file is not ready yet.');
  const csv = dataset.normalised_path ? await getObject(dataset.normalised_path) : null;
  if (!csv) throw new AppError('dataset_expired', 'The source file is no longer available.');
  return { dataset, columns: await getColumns(db, id), csv };
}

// ---------- POST /datasets/:id/ask ----------

const askBody = z.strictObject({
  question: z.string().trim().min(3).max(500),
  chart_hint: z.enum(CHART_TYPES).optional(),
  source: z.enum(['user', 'suggested']).optional(),
});

blocksRouter.post('/datasets/:id/ask', askRateLimit, requireUuidParam(), validate({ body: askBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const body = req.body as AskRequest;
  const datasetId = req.params.id as string;
  // Order: dataset is the caller's (404), ready (409) and not expired (410), then the monthly limit (402).
  const { dataset, columns, csv } = await readyDataset(token, userId, datasetId);
  await assertWithinLimit(userId, 'max_questions_per_month');

  // The pipeline is not tied to the request: if the client disconnects, it still finishes and saves the block.
  let outcome: Awaited<ReturnType<typeof ask>>;
  try {
    outcome = await ask(
      {
        ownerId: userId,
        datasetId,
        datasetName: dataset.name,
        rowCount: dataset.row_count ?? 0,
        columns,
        csv,
        question: body.question,
        chartHint: body.chart_hint,
        source: body.source ?? 'user',
      },
      { llm: llm(), recordLlm: (purpose, usage, meta) => recordLlmUsage(userId, purpose, usage, meta) },
    );
  } catch (err) {
    if (err instanceof AskLlmFailure) {
      throw new AppError('llm_failed', 'We could not get an answer right now. Nothing was saved; please try again.');
    }
    throw err;
  }
  if (outcome.kind === 'cannot_answer') throw new AppError('cannot_answer', outcome.message);

  const { data: row, error } = await supabaseAdmin()
    .from('blocks')
    .insert({ owner_id: userId, dataset_id: datasetId, ...outcome.block })
    .select(BLOCK_COLUMNS)
    .single<BlockRow>();
  throwIfDbError('blocks: insert', error);
  // Counted only once the block is saved.
  await recordUsage(userId, 'question', { block_id: row!.id, dataset_id: datasetId, flagged: row!.status === 'flagged' });
  ok(res, toBlock(row!), 201);
});

// ---------- GET /datasets/:id/blocks, GET /blocks/:id ----------

const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

blocksRouter.get('/datasets/:id/blocks', requireUuidParam(), validate({ query: pageQuery }), async (req, res) => {
  const { userId, token } = authOf(req);
  const q = validQuery<z.infer<typeof pageQuery>>(req);
  const db = supabaseForUser(token);
  await getOwnDataset(db, userId, req.params.id as string); // 404 if not the caller's; works when expired
  const { data, count, error } = await db
    .from('blocks')
    .select(BLOCK_COLUMNS, { count: 'exact' })
    .eq('owner_id', userId)
    .eq('dataset_id', req.params.id as string)
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1)
    .returns<BlockRow[]>();
  throwIfDbError('blocks: list', error);
  const page: Paged<Block> = { items: (data ?? []).map(toBlock), total: count ?? 0, limit: q.limit, offset: q.offset };
  ok(res, page);
});

blocksRouter.get('/blocks/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  ok(res, toBlock(await getOwnBlock(supabaseForUser(token), userId, req.params.id as string)));
});

// ---------- GET /blocks/:id/source-rows ----------

const sourceQuery = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    eq_column: z.string().min(1).max(100).optional(),
    eq_value: z.string().max(500).optional(),
  })
  .refine((q) => (q.eq_column === undefined) === (q.eq_value === undefined), {
    message: 'Send eq_column and eq_value together, or neither.',
    path: ['eq_column'],
  });

const CAST_TYPES: Record<ColumnDataType, string> = {
  integer: 'BIGINT',
  decimal: 'DOUBLE',
  date: 'DATE',
  datetime: 'TIMESTAMP',
  boolean: 'BOOLEAN',
  text: 'VARCHAR',
};
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

blocksRouter.get('/blocks/:id/source-rows', requireUuidParam(), validate({ query: sourceQuery }), async (req, res) => {
  const { userId, token } = authOf(req);
  const q = validQuery<z.infer<typeof sourceQuery>>(req);
  const block = await getOwnBlock(supabaseForUser(token), userId, req.params.id as string);
  if (!block.source_filter_sql || !block.dataset_id) throw notFound('This answer has no source rows.');
  const { columns, csv } = await readyDataset(token, userId, block.dataset_id);

  let where = `(${block.source_filter_sql})`;
  const params: Array<string> = [];
  if (q.eq_column !== undefined) {
    const col = columns.find((c) => c.sql_name === q.eq_column);
    if (!col) {
      throw new AppError('validation_failed', 'Some fields are not valid.', {
        fields: [{ location: 'query', path: 'eq_column', message: 'This is not a column of the dataset.' }],
      });
    }
    // eq_value is bound as a parameter and cast to the column's type in SQL; it never becomes SQL text.
    where += ` AND ${quoteIdent(col.sql_name)} = CAST($1 AS ${CAST_TYPES[col.data_type]})`;
    params.push(q.eq_value!);
  }
  const select = columns.map((c) => quoteIdent(c.sql_name)).join(', ');
  try {
    const result = await withSandbox({ csv, columns }, async (s) => {
      const rows = await s.query(`SELECT ${select} FROM data WHERE ${where} LIMIT ${q.limit} OFFSET ${q.offset}`, { params });
      const total = await s.query(`SELECT count(*) AS n FROM data WHERE ${where}`, { params });
      return { rows: rows.rows, total: Number(total.rows[0]?.n ?? 0) };
    });
    const body: SourceRows = {
      columns: columns.map((c) => ({ sql_name: c.sql_name, label: c.display_name ?? c.name })),
      rows: result.rows,
      total: result.total,
      limit: q.limit,
      offset: q.offset,
    };
    ok(res, body);
  } catch (err) {
    if (err instanceof SandboxError && q.eq_column !== undefined && /Conversion Error|Could not convert/i.test(err.message)) {
      throw new AppError('validation_failed', 'Some fields are not valid.', {
        fields: [{ location: 'query', path: 'eq_value', message: 'This value does not match the column type.' }],
      });
    }
    if (err instanceof SandboxError) throw new AppError('internal', 'We could not load the source rows for this answer.');
    throw err;
  }
});

// ---------- GET /blocks/:id/export.csv ----------

/**
 * Spreadsheet formula injection: a text cell starting with =, +, -, @ (or a tab or carriage return) is written with a
 * leading apostrophe ('=SUM(...)), which spreadsheets show as text and never run. Numbers stay numbers, including
 * negative numbers, because only string cells are prefixed.
 */
export function csvCell(value: CellValue): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'answer';

function sendCsv(res: Response, filename: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${body}`);
}

blocksRouter.get('/blocks/:id/export.csv', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const block = await getOwnBlock(supabaseForUser(token), userId, req.params.id as string);
  const names = block.columns.map((c) => c.name);
  const lines = [names.map((n) => csvCell(n)).join(','), ...block.rows.map((r) => names.map((n) => csvCell(r[n] ?? null)).join(','))];
  // Date in SAST, like every other date in the app.
  const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  const body = `${lines.join('\r\n')}\r\n`;
  // Counted once the file is built (before sending, so the count is in place when the download arrives);
  // a failure to count does not fail the download.
  await recordUsage(userId, 'export', { block_id: block.id, format: 'csv' }).catch(() => undefined);
  sendCsv(res, `${slug(block.title)}-${today}.csv`, body);
});

// ---------- POST /blocks/:id/feedback ----------

const feedbackBody = z.strictObject({ kind: z.literal('looks_wrong'), note: z.string().trim().max(500).optional() });

blocksRouter.post('/blocks/:id/feedback', requireUuidParam(), validate({ body: feedbackBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const body = req.body as BlockFeedbackRequest;
  const block = await getOwnBlock(supabaseForUser(token), userId, req.params.id as string);
  // Stored for the owner and us; never sent to a model.
  await recordUsage(userId, 'feedback', { block_id: block.id, kind: body.kind, note: body.note ?? null });
  const ack: Ack = { received: true };
  ok(res, ack);
});

// ---------- DELETE /blocks/:id ----------

blocksRouter.delete('/blocks/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const block = await getOwnBlock(supabaseForUser(token), userId, req.params.id as string);
  const admin = supabaseAdmin();
  const { count, error: pinError } = await admin
    .from('report_blocks')
    .select('id', { count: 'exact', head: true })
    .eq('block_id', block.id)
    .eq('owner_id', userId);
  throwIfDbError('blocks: pinned check', pinError);
  if ((count ?? 0) > 0) throw new AppError('conflict', 'This answer is pinned in a report. Remove it from the report first.');
  const { error } = await admin.from('blocks').delete().eq('id', block.id).eq('owner_id', userId);
  // A pin added between the check and the delete is refused by the foreign key; answer 409 then too.
  if (error?.code === '23503') throw new AppError('conflict', 'This answer is pinned in a report. Remove it from the report first.');
  throwIfDbError('blocks: delete', error);
  const deleted: Deleted = { deleted: true };
  ok(res, deleted);
});
