import { z } from 'zod';
import type {
  ColumnSemantic,
  Dataset,
  DatasetDetail,
  DatasetPreview,
  ParseOptions,
  PlanLimitDetails,
} from '../types';
import { MOCK_PLAN_LIMITS, cheapestPlanAllowing, sastMonthStart, sastTimestamp, type MockUser } from './data';
import {
  AMBIGUOUS,
  AMBIGUOUS_DATES_WARNING,
  CARD_SALES,
  FIXTURE_TEMPLATES,
  WEBSTORE,
  BANK,
  applyDateOrder,
  buildColumns,
  maskColumn,
  rawSamplesFor,
  type DatasetTemplate,
} from './datasetFixtures';
import { seedDemoBlocks } from './blocks';

export interface MockDataset {
  detail: DatasetDetail;
  template_key: string | null;
  /** While profiling: when it finishes (epoch ms). */
  profiling_until: number | null;
  final_status: 'ready' | 'failed';
  final_error: string | null;
  final_error_details: PlanLimitDetails | null;
}

/** How long a mock upload or reparse stays in 'profiling'. */
export const MOCK_PROFILING_MS = 4500;
const HARD_CEILING_MB = 50;
const PII_SEMANTICS = new Set<ColumnSemantic>(['email', 'phone', 'sa_id_number', 'person_name', 'address']);

type Result = { status: number; body: unknown };
const ok = (data: unknown, status = 200): Result => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, details?: unknown): Result => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

function validationFailed(error: z.ZodError, location: 'body' | 'query' = 'body'): Result {
  const fields = error.issues.map((i) => ({ location, path: i.path.join('.'), message: i.message }));
  return fail(422, 'validation_failed', 'Some fields are not valid.', { fields });
}

function summary(detail: DatasetDetail): Dataset {
  const { columns: _c, parse_options: _p, sheet_names: _s, preamble_lines: _l, excluded_rows: _e, suggestions: _q, ...rest } =
    detail;
  return rest;
}

function addDays(iso: string, days: number): string {
  return sastTimestamp(new Date(new Date(iso).getTime() + days * 86_400_000));
}

function fromTemplate(template: DatasetTemplate, workspaceId: string, createdAt: string, name?: string): DatasetDetail {
  return {
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    name: name ?? template.name,
    original_filename: template.original_filename,
    file_type: template.file_type,
    size_bytes: template.size_bytes,
    row_count: template.row_count,
    status: 'ready',
    error_message: null,
    error_details: null,
    warnings: [...template.warnings],
    expires_at: null,
    created_at: createdAt,
    columns: buildColumns(template.columns),
    parse_options: { ...template.parse_options },
    sheet_names: [...template.sheet_names],
    preamble_lines: [...template.preamble_lines],
    excluded_rows: template.excluded_rows,
    suggestions: [...template.suggestions],
  };
}

function templateFor(key: string | null): DatasetTemplate | undefined {
  return FIXTURE_TEMPLATES.find((t) => t.key === key);
}

/** Moves a profiling dataset on once its time is up, like the server's background job finishing. */
function settle(ds: MockDataset, user: MockUser): void {
  const d = ds.detail;
  if (d.status !== 'profiling' || ds.profiling_until === null || Date.now() < ds.profiling_until) return;
  ds.profiling_until = null;
  d.status = ds.final_status;
  d.error_message = ds.final_error;
  d.error_details = ds.final_error_details;
  if (ds.final_status === 'ready') {
    d.expires_at = sastTimestamp(new Date(Date.now() + MOCK_PLAN_LIMITS[user.plan].retention_days * 86_400_000));
    d.suggestions = [...(templateFor(ds.template_key)?.suggestions ?? [])];
  }
}

function datasetsOf(user: MockUser): MockDataset[] {
  user.datasets ??= [];
  user.datasets.forEach((ds) => settle(ds, user));
  return user.datasets;
}

/** The parts of a dataset the block routes need, after settling any finished profiling. Null if not found. */
export function datasetSnapshot(user: MockUser, id: string) {
  const ds = datasetsOf(user).find((d) => d.detail.id === id);
  return ds ? { status: ds.detail.status, columns: ds.detail.columns, row_count: ds.detail.row_count } : null;
}

/** Example files for the demo account, so every state can be seen without uploading. */
export function seedDemoDatasets(user: MockUser): void {
  const ws = user.workspaces.find((w) => w.is_default);
  if (!ws) return;
  const retention = MOCK_PLAN_LIMITS[user.plan].retention_days;
  const make = (template: DatasetTemplate, createdAt: string): MockDataset => {
    const detail = fromTemplate(template, ws.id, createdAt);
    detail.expires_at = addDays(createdAt, retention);
    return { detail, template_key: template.key, profiling_until: null, final_status: 'ready', final_error: null, final_error_details: null };
  };

  const ambiguous = make(AMBIGUOUS, '2026-10-28T09:12:00+02:00');
  applyDateOrder(ambiguous.detail, AMBIGUOUS, 'dmy');

  const failed = make(CARD_SALES, '2026-10-25T10:40:00+02:00');
  Object.assign(failed.detail, {
    name: 'Card sales full year',
    original_filename: 'card_sales_full_year.csv',
    size_bytes: 4_380_000,
    row_count: null,
    status: 'failed',
    error_message: 'Your plan allows 20 000 rows; this file has 48 210.',
    error_details: { limit_key: 'max_rows', limit: 20_000, used: 48_210, upgrade_to: 'solo' },
    expires_at: null,
    columns: [],
    suggestions: [],
  } satisfies Partial<DatasetDetail>);
  failed.final_status = 'failed';
  failed.final_error = failed.detail.error_message;
  failed.final_error_details = failed.detail.error_details;

  const expired = make(CARD_SALES, '2026-08-20T08:00:00+02:00');
  Object.assign(expired.detail, {
    name: 'Card sales August',
    original_filename: 'card_sales_august.csv',
    status: 'expired',
    row_count: 228,
    expires_at: addDays('2026-08-20T08:00:00+02:00', retention),
    suggestions: [],
  } satisfies Partial<DatasetDetail>);

  // Still being read: becomes ready a few polls after you sign in.
  const profiling = make(CARD_SALES, sastTimestamp());
  Object.assign(profiling.detail, { status: 'profiling', expires_at: null, suggestions: [] } satisfies Partial<DatasetDetail>);
  profiling.profiling_until = Date.now() + MOCK_PROFILING_MS + 2000;

  seedDemoBlocks(user, profiling.detail.id, expired.detail.id);
  user.datasets = [
    expired,
    make(BANK, '2026-10-21T14:05:00+02:00'),
    make(WEBSTORE, '2026-10-22T16:30:00+02:00'),
    failed,
    ambiguous,
    profiling,
  ];
}

function uploadsThisMonth(user: MockUser): number {
  const monthStart = sastMonthStart();
  return datasetsOf(user).filter((ds) => ds.detail.created_at.slice(0, 10) >= monthStart).length;
}

export function countUploadsThisMonth(user: MockUser): number {
  return uploadsThisMonth(user);
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** A rough reading of an unknown CSV: header and row count only. Real parsing is the server's job. */
function genericTemplate(file: File, text: string): DatasetTemplate {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0] ?? '';
  const delimiter = ([',', ';', '\t', '|'] as const).reduce((best, d) =>
    header.split(d).length > header.split(best).length ? d : best,
  );
  const names = header.split(delimiter).map((n, i) => n.replace(/^"|"$/g, '').trim() || `Column ${i + 1}`);
  const firstRow = (lines[1] ?? '').split(delimiter);
  return {
    key: 'generic',
    file_type: 'csv',
    original_filename: file.name,
    name: file.name.replace(/\.[^.]+$/, ''),
    size_bytes: file.size,
    row_count: Math.max(0, lines.length - 1),
    columns: names.map((name, i) => ({
      name,
      type: 'text' as const,
      distinct: Math.max(1, lines.length - 1),
      samples: [firstRow[i]?.replace(/^"|"$/g, '').trim() ?? ''],
    })),
    parse_options: { sheet_name: null, header_row: 1, delimiter, decimal_separator: '.', date_format: 'dmy' },
    sheet_names: [],
    preamble_lines: [],
    excluded_rows: 0,
    warnings: ['Mock mode only reads the header of files that are not in fixtures/; all columns are shown as text.'],
    suggestions: [],
  };
}

export async function handleUpload(user: MockUser, form: FormData): Promise<Result> {
  const file = form.get('file');
  const workspaceId = form.get('workspace_id');
  const name = form.get('name');
  if (!(file instanceof File) || typeof workspaceId !== 'string') {
    const fields = [
      ...(file instanceof File ? [] : [{ location: 'body', path: 'file', message: 'Required' }]),
      ...(typeof workspaceId === 'string' ? [] : [{ location: 'body', path: 'workspace_id', message: 'Required' }]),
    ];
    return fail(422, 'validation_failed', 'Some fields are not valid.', { fields });
  }
  if (!user.workspaces.some((w) => w.id === workspaceId)) return fail(404, 'not_found', 'Workspace not found.');

  if (file.size > HARD_CEILING_MB * 1024 * 1024) {
    return fail(413, 'file_too_large', `The file is larger than ${HARD_CEILING_MB} MB.`);
  }
  const limits = MOCK_PLAN_LIMITS[user.plan];
  const sizeMb = Math.ceil((file.size / (1024 * 1024)) * 100) / 100;
  if (sizeMb > limits.max_file_mb) {
    const details: PlanLimitDetails = {
      limit_key: 'max_file_mb',
      limit: limits.max_file_mb,
      used: sizeMb,
      upgrade_to: cheapestPlanAllowing((l) => sizeMb <= l.max_file_mb),
    };
    return fail(402, 'plan_limit', 'File too large for your plan.', details);
  }
  const used = uploadsThisMonth(user);
  if (used >= limits.max_datasets_per_month) {
    const details: PlanLimitDetails = {
      limit_key: 'max_datasets_per_month',
      limit: limits.max_datasets_per_month,
      used,
      upgrade_to: cheapestPlanAllowing((l) => l.max_datasets_per_month > used),
    };
    return fail(402, 'plan_limit', 'Monthly upload limit reached.', details);
  }

  // Type is checked by content, not only by name.
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  const isXlsx = extension === 'xlsx' && head[0] === 0x50 && head[1] === 0x4b; // "PK" zip header
  const isText = (extension === 'csv' || extension === 'txt') && head.length > 0 && !looksBinary(head);
  if (!isXlsx && !isText) return fail(415, 'file_unsupported', 'Not a CSV or XLSX file.');

  const fixture = FIXTURE_TEMPLATES.find((t) => file.name.startsWith(`${t.key}_`));
  const template = fixture ?? (isXlsx ? null : genericTemplate(file, await file.slice(0, 256 * 1024).text()));
  const createdAt = sastTimestamp();
  const detail = template
    ? fromTemplate(template, workspaceId, createdAt, typeof name === 'string' && name.trim() ? name.trim() : undefined)
    : fromTemplate(CARD_SALES, workspaceId, createdAt, file.name.replace(/\.[^.]+$/, ''));
  Object.assign(detail, {
    original_filename: file.name,
    size_bytes: file.size,
    status: 'profiling',
    suggestions: [],
  } satisfies Partial<DatasetDetail>);
  if (fixture?.raw_dates) applyDateOrder(detail, fixture, 'dmy');

  const rowLimitHit = detail.row_count !== null && detail.row_count > limits.max_rows;
  const ds: MockDataset = {
    detail,
    template_key: fixture?.key ?? null,
    profiling_until: Date.now() + MOCK_PROFILING_MS,
    final_status: !template ? 'failed' : rowLimitHit ? 'failed' : 'ready',
    final_error: !template
      ? 'Mock mode cannot read Excel files. Try one of the CSV files in fixtures/.'
      : rowLimitHit
        ? `Your plan allows ${limits.max_rows} rows; this file has ${detail.row_count}.`
        : null,
    final_error_details:
      rowLimitHit && detail.row_count !== null
        ? {
            limit_key: 'max_rows',
            limit: limits.max_rows,
            used: detail.row_count,
            upgrade_to: cheapestPlanAllowing((l) => l.max_rows >= (detail.row_count ?? 0)),
          }
        : null,
  };
  if (ds.final_status === 'failed') {
    detail.columns = [];
    detail.row_count = null;
  }
  user.datasets = [...datasetsOf(user), ds];
  return ok(summary(detail), 201);
}

const listQuery = z.object({
  workspace_id: z.uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Name and display-name bounds are this mock's assumption; the contract does not state them.
const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  columns: z
    .array(
      z.strictObject({
        id: z.string(),
        display_name: z.string().trim().min(1).max(120).nullable().optional(),
        semantic: z
          .enum(['none', 'currency_zar', 'percentage', 'identifier', 'category', 'email', 'phone', 'sa_id_number', 'person_name', 'address', 'free_text'])
          .optional(),
        is_pii: z.boolean().optional(),
        vat_included: z.boolean().nullable().optional(),
      }),
    )
    .optional(),
});

const reparseSchema = z.strictObject({
  sheet_name: z.string().nullable().optional(),
  header_row: z.number().int().min(1).max(1000).nullable().optional(),
  delimiter: z.enum([',', ';', '\t', '|']).nullable().optional(),
  decimal_separator: z.enum(['.', ',']).nullable().optional(),
  date_format: z.enum(['dmy', 'mdy', 'ymd']).nullable().optional(),
});

function previewValue(raw: string, type: string): string | number | boolean | null {
  if (raw === '') return null;
  if (type === 'integer' || type === 'decimal') return Number(raw);
  if (type === 'boolean') return raw === 'true';
  return raw;
}

function preview(detail: DatasetDetail, limit: number): DatasetPreview {
  const total = detail.row_count ?? 0;
  const rows = Array.from({ length: Math.min(limit, total) }, (_, i) =>
    Object.fromEntries(
      detail.columns.map((c) => {
        const samples = c.sample_values.length ? c.sample_values : [''];
        return [c.sql_name, previewValue(samples[i % samples.length] ?? '', c.data_type)];
      }),
    ),
  );
  return {
    columns: detail.columns.map((c) => ({ sql_name: c.sql_name, label: c.display_name ?? c.name, data_type: c.data_type })),
    rows,
    total_rows: total,
  };
}

/** Routes /datasets*. Returns null when the path is not a datasets route. */
export function routeDatasets(method: string, url: URL, user: MockUser, body: unknown): Result | null {
  const path = url.pathname.replace(/^\/api\/v1/, '');

  if (path === '/datasets' && method === 'GET') {
    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return validationFailed(parsed.error, 'query');
    const { workspace_id, limit, offset } = parsed.data;
    if (!user.workspaces.some((w) => w.id === workspace_id)) return fail(404, 'not_found', 'Workspace not found.');
    const items = datasetsOf(user)
      .filter((ds) => ds.detail.workspace_id === workspace_id)
      .map((ds) => ds.detail)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return ok({ items: items.slice(offset, offset + limit).map(summary), total: items.length, limit, offset });
  }

  const match = /^\/datasets\/([^/]+)(\/preview|\/reparse)?$/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1] ?? '');
  const ds = datasetsOf(user).find((d) => d.detail.id === id);
  if (!ds) return fail(404, 'not_found', 'Dataset not found.');
  const d = ds.detail;
  const sub = match[2];

  if (!sub && method === 'GET') return ok(d);

  if (!sub && method === 'DELETE') {
    user.datasets = datasetsOf(user).filter((x) => x !== ds);
    // Like the server: answers keep their results, but lose their link to the file.
    for (const b of user.blocks ?? []) {
      if (b.block.dataset_id === id) b.block = { ...b.block, dataset_id: null, has_source_rows: false };
    }
    return ok({ deleted: true });
  }

  if (!sub && method === 'PATCH') {
    const parsed = updateSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const { name, columns } = parsed.data;
    for (const [index, edit] of (columns ?? []).entries()) {
      if (!d.columns.some((c) => c.id === edit.id)) {
        return fail(422, 'validation_failed', 'Some fields are not valid.', {
          fields: [{ location: 'body', path: `columns.${index}.id`, message: 'This column does not exist.' }],
        });
      }
    }
    if (name !== undefined) d.name = name;
    for (const edit of columns ?? []) {
      const column = d.columns.find((c) => c.id === edit.id);
      if (!column) continue;
      if (edit.display_name !== undefined) column.display_name = edit.display_name;
      if (edit.semantic !== undefined) {
        column.semantic = edit.semantic;
        // Contract: a personal meaning turns Private on unless the request sets it.
        if (PII_SEMANTICS.has(edit.semantic) && edit.is_pii === undefined) column.is_pii = true;
      }
      if (edit.is_pii !== undefined) column.is_pii = edit.is_pii;
      const raw = rawSamplesFor(templateFor(ds.template_key), column.name);
      if (raw) maskColumn(column, raw);
      if (edit.vat_included !== undefined) column.vat_included = edit.vat_included;
    }
    return ok(d);
  }

  if (sub === '/preview' && method === 'GET') {
    if (d.status === 'expired') return fail(410, 'dataset_expired', 'The source file was removed.');
    if (d.status !== 'ready') return fail(409, 'dataset_not_ready', 'The dataset is not ready.');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    return ok(preview(d, limit));
  }

  if (sub === '/reparse' && method === 'POST') {
    if (d.status === 'expired') return fail(410, 'dataset_expired', 'The source file was removed.');
    // Like the server: a reparse while one is running is 409 conflict.
    if (d.status === 'profiling') return fail(409, 'conflict', 'This file is already being read.');
    const parsed = reparseSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const options: ParseOptions = parsed.data;
    const template = templateFor(ds.template_key);
    // Like the server: only the options sent override detection; everything else is detected again.
    const detected = template?.parse_options ?? d.parse_options;
    d.parse_options = {
      ...detected,
      ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== null && v !== undefined)),
    };
    // New column ids, with edits carried over by sql_name.
    d.columns = d.columns.map((c) => ({ ...c, id: crypto.randomUUID() }));
    if (template?.raw_dates) {
      const order = d.parse_options.date_format === 'mdy' ? 'mdy' : 'dmy';
      applyDateOrder(d, template, order);
      // The ambiguity warning stays unless the date order was sent.
      d.warnings = options.date_format ? [] : [AMBIGUOUS_DATES_WARNING];
    }
    d.status = 'profiling';
    d.error_message = null;
    d.error_details = null;
    d.suggestions = [];
    ds.profiling_until = Date.now() + MOCK_PROFILING_MS;
    return ok(summary(d), 202);
  }

  return fail(404, 'not_found', 'Not found.');
}

