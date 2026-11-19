import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { profilingIdle } from '../../src/services/profiling.js';
import { computeQuality } from '../../src/services/quality.js';
import type { Dataset, DatasetDetail, DatasetPreview, DatasetQuality, Workspace } from '../../src/types/api.js';

/** The Data tab's rows and the Quality tab's score (Part W1) against real Supabase. No model is called for either. */
vi.mock('../../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/client.js')>();
  const fake = {
    provider: 'openrouter' as const,
    modelFor: () => 'test/mock-fast',
    callTool: vi.fn(async () => ({
      output: { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, why: 'w' })) },
      usage: { model: 'test/mock-fast', inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })),
  };
  return { ...actual, llm: () => fake };
});
// A spy around the real quality engine, to see when it runs.
vi.mock('../../src/services/quality.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/quality.js')>();
  return { ...actual, computeQuality: vi.fn(actual.computeQuality) };
});

const app = createApp();
const api = (p: string) => `/api/v1${p}`;

// 12 rows: an item (text), an email (PII), an amount with one empty cell, a date; "Tea" appears in three spellings.
const ROWS = [
  ['Tea', 'thandi@example.com', '5.50', '2026-10-03'],
  ['Coffee', 'sipho@example.com', '', '2026-10-01'],
  ['CAKE', 'lerato@example.com', '7.25', '2026-10-02'],
  ['tea', 'pieter@example.com', '1.00', '2026-10-05'],
  ["50% off_today 'x'; DROP TABLE data; --", 'anna@example.com', '3.00', '2026-10-06'],
  ['Teapot', 'ben@example.com', '9.00', '2026-10-04'],
  ['Muffin', 'chris@example.com', '4.00', '2026-10-07'],
  ['Scone', 'dineo@example.com', '6.00', '2026-10-08'],
  ['Bagel', 'eve@example.com', '2.00', '2026-10-09'],
  ['Roll', 'femi@example.com', '8.00', '2026-10-10'],
  ['Pie', 'gugu@example.com', '10.00', '2026-10-11'],
  ['TEA', 'hanna@example.com', '11.00', '2026-10-12'],
];
const CSV = Buffer.from(`Item,Email,Amount,Day\n${ROWS.map((r) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')}\n`);

let a: TestUser;
let b: TestUser;
let ds: string;
let detail: DatasetDetail;

async function consent(u: TestUser): Promise<string> {
  await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
  return ((await request(app).get(api('/workspaces')).set(bearer(u)).expect(200)).body.data as Workspace[])[0]!.id;
}

async function waitReady(u: TestUser, id: string): Promise<DatasetDetail> {
  for (let i = 0; i < 240; i++) {
    const d = (await request(app).get(api(`/datasets/${id}`)).set(bearer(u)).expect(200)).body.data as DatasetDetail;
    if (d.status === 'ready') return d;
    if (d.status === 'failed') throw new Error(`profiling failed: ${d.error_message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('profiling did not finish');
}

const preview = (query: string, u: TestUser = a) => request(app).get(api(`/datasets/${ds}/preview${query}`)).set(bearer(u));
async function data(query: string): Promise<DatasetPreview> {
  const res = await preview(query);
  expect(res.status, res.text).toBe(200);
  return res.body.data as DatasetPreview;
}
const quality = (u: TestUser = a, id = ds) => request(app).get(api(`/datasets/${id}/quality`)).set(bearer(u));
const storedQuality = async () =>
  (await supabaseAdmin().from('datasets').select('quality').eq('id', ds).single<{ quality: DatasetQuality | null }>()).data!.quality;
async function setStatus(status: string): Promise<void> {
  const { error } = await supabaseAdmin().from('datasets').update({ status }).eq('id', ds);
  if (error) throw new Error(error.code);
}

beforeAll(async () => {
  [a, b] = await Promise.all([createTestUser(), createTestUser()]);
  const [wsA] = await Promise.all([consent(a), consent(b)]);
  const res = await request(app).post(api('/datasets')).set(bearer(a)).field('workspace_id', wsA).attach('file', CSV, 'cafe.csv').expect(201);
  ds = (res.body.data as Dataset).id;
  detail = await waitReady(a, ds);
}, 120_000);

afterAll(async () => {
  await profilingIdle();
  await deleteTestUsers();
});

describe('GET /datasets/:id/preview', () => {
  it('without the new parameters: the same rows as before, plus matched_rows = total_rows', async () => {
    const p = await data('');
    expect(Object.keys(p).sort()).toEqual(['columns', 'matched_rows', 'rows', 'total_rows']);
    expect(p.total_rows).toBe(12);
    expect(p.matched_rows).toBe(12);
    expect(p.rows).toHaveLength(12);
    expect(p.rows[0]).toEqual({ item: 'Tea', email: 'thandi@example.com', amount: 5.5, day_col: '2026-10-03' }); // "day" is a reserved word, so its sql_name is day_col
    expect(p.rows[1]!.amount).toBeNull();
    // offset=0 with nothing else is the same request; dir without sort is ignored.
    expect(await data('?offset=0')).toEqual(p);
    expect(await data('?dir=desc')).toEqual(p);
  });

  it('PII columns behave exactly as before: the owner sees their own values, in every mode', async () => {
    expect(detail.columns.find((c) => c.sql_name === 'email')!.is_pii).toBe(true);
    const plain = (await data('')).rows.map((r) => r.email);
    expect(plain[0]).toBe('thandi@example.com');
    expect((await data('?sort=item')).rows.map((r) => r.email).sort()).toEqual([...plain].sort());
  });

  it('offset and limit page consistently', async () => {
    const all = (await data('?sort=amount&limit=200')).rows;
    const pages = [
      ...(await data('?sort=amount&limit=5')).rows,
      ...(await data('?sort=amount&limit=5&offset=5')).rows,
      ...(await data('?sort=amount&limit=5&offset=10')).rows,
    ];
    expect(pages).toEqual(all);
    expect((await data('?offset=10&limit=5')).rows.map((r) => r.item)).toEqual(['Pie', 'TEA']);
    expect((await data('?offset=50')).rows).toEqual([]);
  });

  it('sort ascending and descending, nulls last both ways', async () => {
    expect((await data('?sort=amount')).rows.map((r) => r.amount)).toEqual([1, 2, 3, 4, 5.5, 6, 7.25, 8, 9, 10, 11, null]);
    expect((await data('?sort=amount&dir=desc')).rows.map((r) => r.amount)).toEqual([11, 10, 9, 8, 7.25, 6, 5.5, 4, 3, 2, 1, null]);
    expect((await data('?sort=day_col&dir=desc')).rows[0]!.day_col).toBe('2026-10-12');
  });

  it.each(['nope', 'Item', '"item"', 'item; DROP TABLE data', "amount' OR '1'='1", 'amount desc'])('sort=%j is 422', async (sort) => {
    const res = await preview(`?sort=${encodeURIComponent(sort)}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.fields[0]).toMatchObject({ location: 'query', path: 'sort' });
  });

  it('q finds text case-insensitively in any text column, and matched_rows counts the matches', async () => {
    const p = await data('?q=TEA');
    expect(p.rows.map((r) => r.item)).toEqual(['Tea', 'tea', 'Teapot', 'TEA']);
    expect(p.matched_rows).toBe(4);
    expect(p.total_rows).toBe(12);
    // The email column is text too (the owner's own data).
    expect((await data('?q=SIPHO')).rows.map((r) => r.item)).toEqual(['Coffee']);
    // Amounts are numbers, not text, so they are not searched.
    expect((await data('?q=7.25')).matched_rows).toBe(0);
    expect(await data('?q=tea&limit=1&offset=1')).toMatchObject({ matched_rows: 4, rows: [{ item: 'tea' }] });
  });

  it.each([
    ['%', 1],
    ['_', 1],
    ["'", 1],
    ["'; DROP TABLE data; --", 1],
    ['t_a', 0],
    ['%%', 0],
  ])('q=%j is plain text (%d match), and the data is still there afterwards', async (q, n) => {
    expect((await data(`?q=${encodeURIComponent(q)}`)).matched_rows).toBe(n);
    expect((await data('')).total_rows).toBe(12);
  });

  it('q of 101 characters is 422; 100 is fine; empty means no filter', async () => {
    expect((await preview(`?q=${'x'.repeat(101)}`)).status).toBe(422);
    expect((await data(`?q=${'x'.repeat(100)}`)).matched_rows).toBe(0);
    expect((await data('?q=')).matched_rows).toBe(12);
  });

  it('bad numbers and unknown parameters are 422', async () => {
    for (const q of ['?offset=-1', '?offset=abc', '?limit=201', '?dir=up&sort=item', '?order=item']) expect((await preview(q)).status, q).toBe(422);
  });

  it('another user’s dataset is 404', async () => {
    expect((await preview('?sort=item', b)).status).toBe(404);
    expect((await preview('', b)).status).toBe(404);
  });
});

describe('GET /datasets/:id/quality', () => {
  it('computes on the first call, stores it, and the second call does not recompute', async () => {
    const spy = vi.mocked(computeQuality);
    spy.mockClear();
    const first = await quality();
    expect(first.status, first.text).toBe(200);
    const q = first.body.data as DatasetQuality;
    expect(q).toMatchObject({ dataset_id: ds, rows_checked: 12 });
    expect(q.parts.map((p) => p.key)).toEqual(['missing', 'duplicates', 'types', 'odd_values', 'consistency']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await storedQuality()).toEqual(q);

    expect((await quality().expect(200)).body.data).toEqual(q);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('finds this file’s issues; examples are empty for the PII column and at most 3 elsewhere', async () => {
    const q = (await quality().expect(200)).body.data as DatasetQuality;
    const ids = q.issues.map((i) => [i.id, i.affected_rows]);
    expect(ids).toContainEqual(['missing_values:amount', 1]);
    // "Tea", "tea" and "TEA" once each: one kept, two minority spellings.
    expect(ids).toContainEqual(['inconsistent_case:item', 2]);
    for (const i of q.issues) {
      expect(i.examples.length).toBeLessThanOrEqual(3);
      if (i.column === 'email') expect(i.examples).toEqual([]);
    }
  });

  it('a column change (meaning, PII flag or label) clears the stored result; the next call recomputes', async () => {
    const col = detail.columns.find((c) => c.sql_name === 'item')!;
    await quality().expect(200);
    expect(await storedQuality()).not.toBeNull();
    await request(app).patch(api(`/datasets/${ds}`)).set(bearer(a)).send({ columns: [{ id: col.id, display_name: 'Product' }] }).expect(200);
    expect(await storedQuality()).toBeNull();
    const spy = vi.mocked(computeQuality);
    spy.mockClear();
    const q = (await quality().expect(200)).body.data as DatasetQuality;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(q.issues.find((i) => i.id === 'inconsistent_case:item')!.title).toContain('"Product"');
  });

  it('reparse clears it', async () => {
    await quality().expect(200);
    expect(await storedQuality()).not.toBeNull();
    await request(app).post(api(`/datasets/${ds}/reparse`)).set(bearer(a)).send({}).expect(202);
    expect(await storedQuality()).toBeNull();
    detail = await waitReady(a, ds);
    await profilingIdle();
  });

  it('another user’s dataset and an unknown id are 404', async () => {
    expect((await quality(b)).status).toBe(404);
    expect((await quality(a, randomUUID())).status).toBe(404);
  });

  it('not ready is 409, expired is 410', async () => {
    try {
      await setStatus('profiling');
      const r = await quality();
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('dataset_not_ready');
      await setStatus('expired');
      const e = await quality();
      expect(e.status).toBe(410);
      expect(e.body.error.code).toBe('dataset_expired');
    } finally {
      await setStatus('ready');
    }
  });
});
