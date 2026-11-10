import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, listOwnerObjects, setPlan, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { objectExists } from '../../src/lib/storage.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { LlmError, llm } from '../../src/llm/client.js';
import { INTERRUPTED_MESSAGE, profilingIdle, sweepInterruptedProfiling } from '../../src/services/profiling.js';
import { SUGGESTIONS_FAILED_WARNING } from '../../src/services/suggestions.js';
import type { Dataset, DatasetDetail, DatasetPreview, Me, Paged, Workspace } from '../../src/types/api.js';

// Real Supabase and storage; the LLM is mocked so no test calls the real API.
vi.mock('../../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/client.js')>();
  const questions = Array.from({ length: 5 }, (_, i) => ({ question: `Mock question ${i + 1}?`, why: 'Mocked.' }));
  const fake = {
    provider: 'openrouter' as const,
    modelFor: () => 'test/mock-fast',
    callTool: vi.fn(async () => ({
      output: { questions },
      usage: { model: 'test/mock-fast', inputTokens: 321, outputTokens: 123, costUsd: 0.000094 },
    })),
  };
  return { ...actual, llm: () => fake };
});

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const FIXTURES = new URL('../../../fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES));
const expected = JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')).files as Record<
  string,
  { data_rows: number; excluded_rows: number; column_names: string[]; pii_columns: string[]; header_line_1based: number; sums: Record<string, number> }
>;
const MB = 1024 * 1024;

let a: TestUser; // practice plan: fixtures, edits, reparse, workspace delete
let b: TestUser; // free: isolation checks
let c: TestUser; // free: limit and file-type errors
let d: TestUser; // practice_plus: hard ceiling
let aWorkspace: string;
const datasetIds: Record<string, string> = {};

async function consent(u: TestUser): Promise<string> {
  await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
  const res = await request(app).get(api('/workspaces')).set(bearer(u)).expect(200);
  return (res.body.data as Workspace[])[0]!.id;
}

function upload(u: TestUser, workspaceId: string, buffer: Buffer, filename: string, name?: string) {
  const req = request(app).post(api('/datasets')).set(bearer(u)).field('workspace_id', workspaceId);
  if (name) req.field('name', name);
  return req.attach('file', buffer, filename);
}

async function waitFor(u: TestUser, id: string, until: Array<Dataset['status']> = ['ready', 'failed']): Promise<DatasetDetail> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await request(app).get(api(`/datasets/${id}`)).set(bearer(u)).expect(200);
    const detail = res.body.data as DatasetDetail;
    if (until.includes(detail.status)) return detail;
    if (Date.now() > deadline) throw new Error(`dataset ${id} still ${detail.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const rows = (n: number) => Buffer.from(['Date,Amount', ...Array.from({ length: n }, (_, i) => `01/10/2026,${i}.50`)].join('\n'));

beforeAll(async () => {
  [a, b, c, d] = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
  await Promise.all([setPlan(a.id, 'practice'), setPlan(d.id, 'practice_plus')]);
  [aWorkspace] = await Promise.all([consent(a), consent(b), consent(c), consent(d)]);
});

afterAll(async () => {
  await profilingIdle();
  await deleteTestUsers();
});

describe('upload and profile the fixtures', () => {
  it.each(Object.keys(expected))('%s ends ready with the expected structure', async (name) => {
    const res = await upload(a, aWorkspace, fixture(name), name);
    expect(res.status).toBe(201);
    const ds = res.body.data as Dataset;
    expect(ds).toMatchObject({ status: 'profiling', workspace_id: aWorkspace, original_filename: name, file_type: 'csv', row_count: null });
    expect(ds.name).toBe(name.replace(/\.csv$/, ''));
    datasetIds[name] = ds.id;

    const detail = await waitFor(a, ds.id);
    const exp = expected[name]!;
    expect(detail.status).toBe('ready');
    expect(detail.error_message).toBeNull();
    expect(detail.row_count).toBe(exp.data_rows);
    expect(detail.excluded_rows).toBe(exp.excluded_rows);
    expect(detail.parse_options.header_row).toBe(exp.header_line_1based);
    expect(detail.columns.map((col) => col.name)).toEqual(exp.column_names);
    expect(detail.columns.filter((col) => col.is_pii).map((col) => col.name)).toEqual(exp.pii_columns);
    for (const col of detail.columns.filter((x) => x.is_pii)) {
      expect(col.sample_values.every((v) => /^\[(email|phone|id|name|address)\]$/.test(v))).toBe(true);
    }
    expect(detail.suggestions).toHaveLength(5);
    expect(detail.expires_at).not.toBeNull();
    expect(Date.parse(detail.expires_at!) - Date.now()).toBeGreaterThan(179 * 86_400_000); // practice: 180 days
    expect(await objectExists(`${a.id}/${ds.id}/raw.csv`)).toBe(true);
    expect(await objectExists(`${a.id}/${ds.id}/normalised.csv`)).toBe(true);
  });

  it('returns the list newest first, paged', async () => {
    const res = await request(app).get(api(`/datasets?workspace_id=${aWorkspace}&limit=2`)).set(bearer(a)).expect(200);
    const page = res.body.data as Paged<Dataset>;
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 0 });
    expect(page.items.map((x) => x.id)).toEqual([datasetIds['04_ambiguous_dates.csv'], datasetIds['03_bank_statement_comma_quoted.csv']]);
  });

  it('serves a typed preview that matches the expected sums', async () => {
    const id = datasetIds['03_bank_statement_comma_quoted.csv']!;
    const res = await request(app).get(api(`/datasets/${id}/preview?limit=200`)).set(bearer(a)).expect(200);
    const preview = res.body.data as DatasetPreview;
    expect(preview.total_rows).toBe(150);
    expect(preview.rows).toHaveLength(150);
    expect(preview.columns.map((x) => x.label)).toEqual(expected['03_bank_statement_comma_quoted.csv']!.column_names);
    const total = preview.rows.reduce((s, r) => s + Math.round((r.amount as number) * 100), 0) / 100;
    expect(total).toBeCloseTo(expected['03_bank_statement_comma_quoted.csv']!.sums.amount_net!, 2);
    expect(typeof preview.rows[0]!.amount).toBe('number');
    const small = await request(app).get(api(`/datasets/${id}/preview`)).set(bearer(a)).expect(200);
    expect(small.body.data.rows).toHaveLength(50);
    expect((await request(app).get(api(`/datasets/${id}/preview?limit=201`)).set(bearer(a))).status).toBe(422);
  });

  it('records the upload and the suggestions call as usage events', async () => {
    const { data } = await supabaseAdmin().from('usage_events').select('kind, model, input_tokens, output_tokens, cost_usd, meta').eq('owner_id', a.id);
    expect(data!.filter((e) => e.kind === 'upload')).toHaveLength(4);
    const llmEvents = data!.filter((e) => e.kind === 'llm');
    expect(llmEvents.length).toBeGreaterThanOrEqual(4);
    expect(llmEvents[0]).toMatchObject({ model: 'test/mock-fast', input_tokens: 321, output_tokens: 123, meta: expect.objectContaining({ purpose: 'suggest' }) });
    expect(Number(llmEvents[0]!.cost_usd)).toBeCloseTo(0.000094, 6);
    const me = (await request(app).get(api('/me')).set(bearer(a))).body.data as Me;
    expect(me.usage.uploads).toBe(4);
  });
});

describe('PATCH /datasets/:id', () => {
  it('unmasks a column, flags another as PII by meaning, and renames', async () => {
    const id = datasetIds['02_webstore_orders_utf8bom.csv']!;
    const detail = await waitFor(a, id);
    const phone = detail.columns.find((x) => x.name === 'Phone')!;
    const product = detail.columns.find((x) => x.name === 'Product')!;
    const res = await request(app)
      .patch(api(`/datasets/${id}`))
      .set(bearer(a))
      .send({
        name: 'Webstore October',
        columns: [
          { id: phone.id, is_pii: false },
          { id: product.id, semantic: 'person_name', display_name: 'Item bought' },
        ],
      })
      .expect(200);
    const updated = res.body.data as DatasetDetail;
    expect(updated.name).toBe('Webstore October');
    const newPhone = updated.columns.find((x) => x.id === phone.id)!;
    expect(newPhone.is_pii).toBe(false);
    expect(newPhone.sample_values.length).toBeGreaterThan(0);
    expect(newPhone.sample_values.every((v) => /^082 555 \d{4}$/.test(v))).toBe(true);
    const newProduct = updated.columns.find((x) => x.id === product.id)!;
    expect(newProduct).toMatchObject({ semantic: 'person_name', is_pii: true, display_name: 'Item bought' });
    expect(newProduct.sample_values.every((v) => v === '[name]')).toBe(true);
  });

  it('keeps is_pii false when the same request sets it alongside a PII meaning', async () => {
    const id = datasetIds['02_webstore_orders_utf8bom.csv']!;
    const detail = await waitFor(a, id);
    const province = detail.columns.find((x) => x.name === 'Province')!;
    const res = await request(app)
      .patch(api(`/datasets/${id}`))
      .set(bearer(a))
      .send({ columns: [{ id: province.id, semantic: 'address', is_pii: false }] })
      .expect(200);
    expect((res.body.data as DatasetDetail).columns.find((x) => x.id === province.id)).toMatchObject({ semantic: 'address', is_pii: false });
  });

  it('rejects column ids from another dataset, unknown fields and an empty body', async () => {
    const id = datasetIds['02_webstore_orders_utf8bom.csv']!;
    const other = await waitFor(a, datasetIds['04_ambiguous_dates.csv']!);
    const res = await request(app).patch(api(`/datasets/${id}`)).set(bearer(a)).send({ columns: [{ id: other.columns[0]!.id, is_pii: true }] });
    expect(res.status).toBe(422);
    expect(res.body.error.details.fields[0].path).toBe('columns.0.id');
    expect((await request(app).patch(api(`/datasets/${id}`)).set(bearer(a)).send({ name: 'x', owner_id: a.id })).status).toBe(422);
    expect((await request(app).patch(api(`/datasets/${id}`)).set(bearer(a)).send({})).status).toBe(422);
  });
});

describe('reparse', () => {
  it('re-reads month-first, keeps column edits by sql_name, and refuses while profiling', async () => {
    const id = datasetIds['04_ambiguous_dates.csv']!;
    const before = await waitFor(a, id);
    expect(before.warnings.some((w) => /day-first/.test(w))).toBe(true);
    const item = before.columns.find((x) => x.name === 'Item')!;
    await request(app).patch(api(`/datasets/${id}`)).set(bearer(a)).send({ columns: [{ id: item.id, display_name: 'Expense', vat_included: true }] }).expect(200);

    const res = await request(app).post(api(`/datasets/${id}/reparse`)).set(bearer(a)).send({ date_format: 'mdy' });
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('profiling');
    const again = await request(app).post(api(`/datasets/${id}/reparse`)).set(bearer(a)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');

    const after = await waitFor(a, id);
    expect(after.status).toBe('ready');
    expect(after.parse_options.date_format).toBe('mdy');
    const date = (x: DatasetDetail) => x.columns.find((col) => col.sql_name === 'date_col')!;
    expect([date(after).min_value, date(after).max_value]).not.toEqual([date(before).min_value, date(before).max_value]);
    expect(after.columns.find((x) => x.sql_name === 'item')).toMatchObject({ display_name: 'Expense', vat_included: true });
    const preview = (await request(app).get(api(`/datasets/${id}/preview?limit=200`)).set(bearer(a)).expect(200)).body.data as DatasetPreview;
    const total = preview.rows.reduce((s, r) => s + Math.round((r.amount as number) * 100), 0) / 100;
    expect(total).toBeCloseTo(expected['04_ambiguous_dates.csv']!.sums.amount!, 2);
  });

  it('validates the options', async () => {
    const id = datasetIds['04_ambiguous_dates.csv']!;
    await waitFor(a, id);
    expect((await request(app).post(api(`/datasets/${id}/reparse`)).set(bearer(a)).send({ delimiter: '#' })).status).toBe(422);
    expect((await request(app).post(api(`/datasets/${id}/reparse`)).set(bearer(a)).send({ sheet_name: 'Sheet1' })).status).toBe(422);
  });
});

describe('suggestions failure', () => {
  it('still ends ready, with no suggestions and a warning', async () => {
    vi.mocked(llm().callTool).mockRejectedValueOnce(new LlmError('timeout', 'slow'));
    const res = await upload(a, aWorkspace, fixture('04_ambiguous_dates.csv'), 'again.csv', 'Again');
    const detail = await waitFor(a, res.body.data.id);
    expect(detail.status).toBe('ready');
    expect(detail.suggestions).toEqual([]);
    expect(detail.warnings).toContain(SUGGESTIONS_FAILED_WARNING);
  });
});

describe('upload checks', () => {
  it('a 6 MB file on free is 402 max_file_mb', async () => {
    const big = Buffer.concat([Buffer.from('a,b\n'), Buffer.alloc(6 * MB, 'x,1\n')]);
    const res = await upload(c, (await consent(c)), big, 'big.csv');
    expect(res.status).toBe(402);
    expect(res.body.error.details).toMatchObject({ limit_key: 'max_file_mb', limit: 5, upgrade_to: 'solo' });
    expect(res.body.error.details.used).toBeGreaterThan(6);
  });

  it('a file over 50 MB is 413 even on the biggest plan', async () => {
    const huge = Buffer.alloc(51 * MB, 'a,b\n');
    const ws = await consent(d);
    const res = await upload(d, ws, huge, 'huge.csv').catch((err: Error) => err);
    // The server may close the connection while the client is still sending; then the status is not readable.
    if (res instanceof Error) {
      expect(res.message).toMatch(/EPIPE|ECONNRESET|socket hang up/);
    } else {
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
    }
    const { count } = await supabaseAdmin().from('datasets').select('id', { count: 'exact', head: true }).eq('owner_id', d.id);
    expect(count).toBe(0);
  });

  it('a PNG renamed .csv and a legacy .xls renamed .xlsx are 415', async () => {
    const ws = await consent(c);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 0)]);
    const pngRes = await upload(c, ws, png, 'photo.csv');
    expect(pngRes.status).toBe(415);
    expect(pngRes.body.error.code).toBe('file_unsupported');
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096, 0)]);
    expect((await upload(c, ws, xls, 'old.xlsx')).status).toBe(415);
  });

  it('a CSV with more rows than the free plan allows ends failed with the row message', async () => {
    const ws = await consent(c);
    const res = await upload(c, ws, rows(20_001), 'many.csv');
    expect(res.status).toBe(201);
    const detail = await waitFor(c, res.body.data.id);
    expect(detail.status).toBe('failed');
    expect(detail.error_message).toBe('Your plan allows 20 000 rows; this file has 20 001.');
  });

  it('rejects a missing file, a bad workspace id and someone else\'s workspace', async () => {
    const ws = await consent(c);
    expect((await request(app).post(api('/datasets')).set(bearer(c)).field('workspace_id', ws)).status).toBe(422);
    expect((await upload(c, 'nope', rows(3), 'x.csv')).status).toBe(422);
    expect((await upload(c, aWorkspace, rows(3), 'x.csv')).status).toBe(404);
  });
});

describe("another user's dataset is 404 on every route", () => {
  it('GET, PATCH, reparse, preview, DELETE and list', async () => {
    const id = datasetIds['01_card_sales_semicolon_win1252.csv']!;
    await waitFor(a, id);
    const as = (r: request.Test) => r.set(bearer(b));
    expect((await as(request(app).get(api(`/datasets/${id}`)))).status).toBe(404);
    expect((await as(request(app).patch(api(`/datasets/${id}`))).send({ name: 'mine' })).status).toBe(404);
    expect((await as(request(app).post(api(`/datasets/${id}/reparse`))).send({})).status).toBe(404);
    expect((await as(request(app).get(api(`/datasets/${id}/preview`)))).status).toBe(404);
    expect((await as(request(app).delete(api(`/datasets/${id}`)))).status).toBe(404);
    expect((await as(request(app).get(api(`/datasets?workspace_id=${aWorkspace}`)))).status).toBe(404);
    expect((await request(app).get(api(`/datasets/${id}`)).set(bearer(a))).body.data.name).not.toBe('mine');
  });
});

describe('retention', () => {
  it('a wrong or missing cron secret is 401', async () => {
    expect((await request(app).post(api('/internal/purge-expired')).set('x-cron-secret', 'wrong')).status).toBe(401);
    expect((await request(app).post(api('/internal/purge-expired'))).status).toBe(401);
  });

  it('purges an expired dataset: files removed, status expired, preview 410, reparse 410, detail still served', async () => {
    const id = datasetIds['01_card_sales_semicolon_win1252.csv']!;
    await supabaseAdmin().from('datasets').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', id);
    const res = await request(app).post(api('/internal/purge-expired')).set('x-cron-secret', process.env.CRON_SECRET!).expect(200);
    expect(res.body.data.purged).toBeGreaterThanOrEqual(1);
    const detail = (await request(app).get(api(`/datasets/${id}`)).set(bearer(a)).expect(200)).body.data as DatasetDetail;
    expect(detail.status).toBe('expired');
    expect(detail.columns.length).toBeGreaterThan(0);
    expect(await objectExists(`${a.id}/${id}/raw.csv`)).toBe(false);
    expect(await objectExists(`${a.id}/${id}/normalised.csv`)).toBe(false);
    const preview = await request(app).get(api(`/datasets/${id}/preview`)).set(bearer(a));
    expect(preview.status).toBe(410);
    expect(preview.body.error.code).toBe('dataset_expired');
    expect((await request(app).post(api(`/datasets/${id}/reparse`)).set(bearer(a)).send({})).status).toBe(410);
  });
});

describe('deleting', () => {
  it('DELETE /datasets/:id removes both storage objects and the row', async () => {
    const id = datasetIds['03_bank_statement_comma_quoted.csv']!;
    await waitFor(a, id);
    const res = await request(app).delete(api(`/datasets/${id}`)).set(bearer(a)).expect(200);
    expect(res.body).toEqual({ data: { deleted: true } });
    expect(await objectExists(`${a.id}/${id}/raw.csv`)).toBe(false);
    expect(await objectExists(`${a.id}/${id}/normalised.csv`)).toBe(false);
    expect((await request(app).get(api(`/datasets/${id}`)).set(bearer(a))).status).toBe(404);
  });

  it("deleting a workspace removes its datasets' files", async () => {
    const created = await request(app).post(api('/workspaces')).set(bearer(a)).send({ name: 'Client files' }).expect(201);
    const ws = created.body.data.id as string;
    const res = await upload(a, ws, fixture('04_ambiguous_dates.csv'), 'client.csv');
    const id = res.body.data.id as string;
    await waitFor(a, id);
    expect(await objectExists(`${a.id}/${id}/normalised.csv`)).toBe(true);
    await request(app).delete(api(`/workspaces/${ws}`)).set(bearer(a)).expect(200);
    expect(await objectExists(`${a.id}/${id}/raw.csv`)).toBe(false);
    expect(await objectExists(`${a.id}/${id}/normalised.csv`)).toBe(false);
    expect((await listOwnerObjects(a.id)).some((p) => p.includes(id))).toBe(false);
  });
});

describe('boot sweep', () => {
  it('marks a dataset left profiling as failed with the restart message', async () => {
    const ws = await consent(b);
    const { data } = await supabaseAdmin()
      .from('datasets')
      .insert({
        owner_id: b.id,
        workspace_id: ws,
        name: 'Interrupted',
        original_filename: 'x.csv',
        file_type: 'csv',
        size_bytes: 10,
        storage_path: `${b.id}/00000000-0000-4000-8000-000000000000/raw.csv`,
        status: 'profiling',
      })
      .select('id')
      .single();
    expect(await sweepInterruptedProfiling(b.id)).toBe(1);
    const detail = (await request(app).get(api(`/datasets/${data!.id}`)).set(bearer(b)).expect(200)).body.data as DatasetDetail;
    expect(detail).toMatchObject({ status: 'failed', error_message: INTERRUPTED_MESSAGE });
  });
});
