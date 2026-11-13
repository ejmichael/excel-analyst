import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, setPlan, step, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { profilingIdle } from '../../src/services/profiling.js';
import type { Block, Dataset, DatasetDetail, Paged, SourceRows, Workspace } from '../../src/types/api.js';

/**
 * Block endpoints against real Supabase and the real sandbox. The model is mocked and steered by the question:
 *   "FAIL_LLM ..."  -> the planner times out (502, nothing saved)
 *   "CANNOT ..."    -> can_answer false (422 cannot_answer)
 *   "FORMULA ..."   -> a plan over the formula-test dataset
 *   anything else   -> net sales by store over fixture 01, with a source filter and a reconcile
 */
vi.mock('../../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/client.js')>();
  const usage = (model: string) => ({ model, inputTokens: 200, outputTokens: 40, costUsd: 0.0012 });
  const chart = (x: string, y: string, vf: Record<string, string>) => ({ type: 'bar', x, y: [y], series: null, orientation: 'vertical', stacked: false, value_format: vf });
  const fake = {
    provider: 'openrouter' as const,
    modelFor: (role: string) => (role === 'planner' ? 'test/planner' : 'test/fast'),
    callTool: vi.fn(async (req: { tool: { name: string }; user: string; role: string; schema: { parse: (v: unknown) => unknown } }) => {
      const question = /^Question: (.*)$/m.exec(req.user)?.[1] ?? '';
      if (req.tool.name === 'plan_analysis') {
        if (question.startsWith('FAIL_LLM')) throw new actual.LlmError('timeout', 'slow');
        if (question.startsWith('CANNOT')) return { output: { can_answer: false, reason_if_not: 'This file has no profit column.' }, usage: usage('test/planner') };
        if (question.startsWith('FORMULA')) {
          return {
            output: {
              can_answer: true,
              title: 'Items and amounts',
              sql: 'SELECT "item", "amount" FROM data ORDER BY "amount" DESC',
              source_filter_sql: null,
              chart: chart('item', 'amount', { item: 'text', amount: 'zar' }),
              reconcile: null,
              narrative_instructions: 'List the top item.',
            },
            usage: usage('test/planner'),
          };
        }
        return {
          output: {
            can_answer: true,
            title: 'Net sales by store',
            sql: 'SELECT "store", ROUND(SUM("net_amount"), 2) AS net FROM data WHERE "card_type" <> \'AMEX\' GROUP BY "store" ORDER BY net DESC',
            source_filter_sql: '"card_type" <> \'AMEX\'',
            chart: chart('store', 'net', { store: 'text', net: 'zar' }),
            reconcile: { column: 'net', aggregation: 'sum', total_sql: 'SELECT SUM("net_amount") FROM data WHERE "card_type" <> \'AMEX\'' },
            narrative_instructions: 'Mention the top store.',
          },
          usage: usage('test/planner'),
        };
      }
      const first = /Result columns \(name \| format\): ([^ |]+)/.exec(req.user)?.[1] ?? 'x';
      return {
        output: { narrative_template: `{{r0.${first}}} comes first of {{rows}}.`, follow_ups: ['What about last month?'] },
        usage: usage('test/fast'),
      };
    }),
  };
  return { ...actual, llm: () => fake };
});

const app = createApp();
const api = (p: string) => `/api/v1${p}`;
const FIXTURES = new URL('../../../fixtures/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')).files['01_card_sales_semicolon_win1252.csv'];

let a: TestUser; // practice: owner of the datasets
let b: TestUser; // free: cross-user checks and the question limit
let ws: string;
let cardId: string;
let formulaId: string;
let block: Block;

async function consent(u: TestUser): Promise<string> {
  return step('accept terms and read the default workspace', async () => {
    await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
    return ((await request(app).get(api('/workspaces')).set(bearer(u)).expect(200)).body.data as Workspace[])[0]!.id;
  });
}

async function uploadReady(u: TestUser, workspace: string, buffer: Buffer, filename: string): Promise<string> {
  const res = await request(app).post(api('/datasets')).set(bearer(u)).field('workspace_id', workspace).attach('file', buffer, filename).expect(201);
  const id = (res.body.data as Dataset).id;
  for (let i = 0; i < 240; i++) {
    const d = (await request(app).get(api(`/datasets/${id}`)).set(bearer(u)).expect(200)).body.data as DatasetDetail;
    if (d.status === 'ready') return id;
    if (d.status === 'failed') throw new Error(`profiling failed: ${d.error_message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('profiling did not finish');
}

const askQ = (u: TestUser, datasetId: string, question: string) => request(app).post(api(`/datasets/${datasetId}/ask`)).set(bearer(u)).send({ question });
const countEvents = async (userId: string, kind: string) =>
  (await supabaseAdmin().from('usage_events').select('id', { count: 'exact', head: true }).eq('owner_id', userId).eq('kind', kind)).count ?? 0;

beforeAll(async () => {
  [a, b] = await Promise.all([createTestUser(), createTestUser()]);
  await setPlan(a.id, 'practice');
  [ws] = await Promise.all([consent(a), consent(b)]);
  cardId = await uploadReady(a, ws, readFileSync(new URL('01_card_sales_semicolon_win1252.csv', FIXTURES)), 'card.csv');
  const formula = ['Item,Amount', `"=HYPERLINK(""http://x"",""click"")",10.50`, '+27 82 555 1234,9.00', '-3+3,8.00', '@SUM(A1),7.00', 'Tea,6.00', 'Coffee,5.00'].join('\n');
  formulaId = await uploadReady(a, ws, Buffer.from(formula), 'formula.csv');
}, 180_000);

afterAll(async () => {
  await profilingIdle();
  await deleteTestUsers();
});

describe('POST /datasets/:id/ask', () => {
  it('answers (201) with numbers from the data, saves the block, then counts the question', async () => {
    const before = await countEvents(a.id, 'question');
    const res = await askQ(a, cardId, '  What were net sales by store?  ');
    expect(res.status).toBe(201);
    block = res.body.data as Block;
    expect(block).toMatchObject({ question: 'What were net sales by store?', title: 'Net sales by store', status: 'ok', source: 'user', has_source_rows: true, dataset_id: cardId });
    const total = block.rows.reduce((s, r) => s + Math.round((r.net as number) * 100), 0) / 100;
    expect(block.checks.find((c) => c.type === 'total_reconciles')).toMatchObject({ ok: true });
    expect(block.narrative).toMatch(/comes first of 3\.$/);
    expect(total).toBeGreaterThan(0);
    expect(await countEvents(a.id, 'question')).toBe(before + 1);
    const { data: saved } = await supabaseAdmin().from('blocks').select('narrative_template, source_filter_sql, model, reconcile').eq('id', block.id).single();
    expect(saved).toMatchObject({ narrative_template: '{{r0.store}} comes first of {{rows}}.', model: 'test/planner' });
    expect(saved!.source_filter_sql).toContain('card_type');
    // Two llm events (plan, narrate) with tokens and cost.
    const { data: llm } = await supabaseAdmin().from('usage_events').select('model, input_tokens, cost_usd, meta').eq('owner_id', a.id).eq('kind', 'llm');
    expect(llm!.filter((e) => ['plan', 'narrate'].includes((e.meta as { purpose: string }).purpose)).length).toBeGreaterThanOrEqual(2);
  });

  it('cannot_answer is 422 with the reason and counts no question', async () => {
    const before = await countEvents(a.id, 'question');
    const res = await askQ(a, cardId, 'CANNOT what was the profit?');
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({ code: 'cannot_answer', message: 'This file has no profit column.' });
    expect(await countEvents(a.id, 'question')).toBe(before);
  });

  it('a model failure is 502, saves no block, counts no question, but records the llm call', async () => {
    const blocksBefore = (await supabaseAdmin().from('blocks').select('id', { count: 'exact', head: true }).eq('owner_id', a.id)).count;
    const questionsBefore = await countEvents(a.id, 'question');
    const llmBefore = await countEvents(a.id, 'llm');
    const res = await askQ(a, cardId, 'FAIL_LLM what happened?');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('llm_failed');
    expect((await supabaseAdmin().from('blocks').select('id', { count: 'exact', head: true }).eq('owner_id', a.id)).count).toBe(blocksBefore);
    expect(await countEvents(a.id, 'question')).toBe(questionsBefore);
    expect(await countEvents(a.id, 'llm')).toBe(llmBefore + 1);
  });

  it('validates the body', async () => {
    expect((await askQ(a, cardId, 'hi')).status).toBe(422);
    expect((await request(app).post(api(`/datasets/${cardId}/ask`)).set(bearer(a)).send({ question: 'What sold?', extra: 1 })).status).toBe(422);
    expect((await request(app).post(api(`/datasets/${cardId}/ask`)).set(bearer(a)).send({ question: 'x'.repeat(501) })).status).toBe(422);
  });

  it('409 when the dataset is not ready, 410 when expired', async () => {
    const { data: row } = await supabaseAdmin()
      .from('datasets')
      .insert({ owner_id: a.id, workspace_id: ws, name: 'Still reading', original_filename: 'x.csv', file_type: 'csv', size_bytes: 1, storage_path: `${a.id}/none/raw.csv`, status: 'failed' })
      .select('id')
      .single();
    const notReady = await askQ(a, row!.id, 'What were sales?');
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('dataset_not_ready');
    await supabaseAdmin().from('datasets').update({ status: 'expired' }).eq('id', row!.id);
    const expired = await askQ(a, row!.id, 'What were sales?');
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('dataset_expired');
    // History of an expired dataset is still served.
    expect((await request(app).get(api(`/datasets/${row!.id}/blocks`)).set(bearer(a))).status).toBe(200);
  });

  it('402 with PlanLimitDetails when the monthly question limit is reached', async () => {
    const bws = await consent(b);
    const bData = await uploadReady(b, bws, Buffer.from('Item,Amount\nTea,5\nCoffee,6\nCake,7\n'), 'tiny.csv');
    await supabaseAdmin().from('usage_events').insert(Array.from({ length: 20 }, () => ({ owner_id: b.id, kind: 'question', meta: {} })));
    const res = await askQ(b, bData, 'What sold most?');
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'plan_limit', details: { limit_key: 'max_questions_per_month', limit: 20, used: 20, upgrade_to: 'solo' } });
  });
});

describe('reading blocks', () => {
  it('lists a dataset\'s blocks newest first and returns one block', async () => {
    const page = (await request(app).get(api(`/datasets/${cardId}/blocks?limit=10`)).set(bearer(a)).expect(200)).body.data as Paged<Block>;
    expect(page.items[0]!.id).toBe(block.id);
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect((await request(app).get(api(`/blocks/${block.id}`)).set(bearer(a)).expect(200)).body.data.id).toBe(block.id);
  });
});

describe('GET /blocks/:id/source-rows', () => {
  it('returns the rows behind the answer, unmasked, with the true total', async () => {
    const res = await request(app).get(api(`/blocks/${block.id}/source-rows?limit=5`)).set(bearer(a)).expect(200);
    const body = res.body.data as SourceRows;
    expect(body.rows).toHaveLength(5);
    expect(body.total).toBe(expected.data_rows); // the fixture has no AMEX rows, so the filter keeps every row
    expect(body.columns.map((c) => c.label)).toEqual(expected.column_names);
    expect(body).toMatchObject({ limit: 5, offset: 0 });
  });

  it('narrows to one value of a column (bound and cast to the column type)', async () => {
    const top = block.rows[0]!.store as string;
    const res = await request(app)
      .get(api(`/blocks/${block.id}/source-rows`))
      .query({ eq_column: 'store', eq_value: top, limit: 200 })
      .set(bearer(a))
      .expect(200);
    const body = res.body.data as SourceRows;
    expect(body.rows.every((r) => r.store === top)).toBe(true);
    const net = Math.round(body.rows.reduce((s, r) => s + Math.round((r.net_amount as number) * 100), 0)) / 100;
    expect(net).toBeCloseTo(expected.net_by_store[top], 2);
    const byDate = await request(app).get(api(`/blocks/${block.id}/source-rows`)).query({ eq_column: 'transaction_date', eq_value: '2026-10-01' }).set(bearer(a)).expect(200);
    expect((byDate.body.data as SourceRows).rows.every((r) => r.transaction_date === '2026-10-01')).toBe(true);
  });

  it('rejects a bad eq_column, a half pair, and a value of the wrong type with 422', async () => {
    const bad = await request(app).get(api(`/blocks/${block.id}/source-rows`)).query({ eq_column: 'nope', eq_value: 'x' }).set(bearer(a));
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields[0]).toMatchObject({ location: 'query', path: 'eq_column' });
    expect((await request(app).get(api(`/blocks/${block.id}/source-rows`)).query({ eq_column: 'store' }).set(bearer(a))).status).toBe(422);
    const typed = await request(app).get(api(`/blocks/${block.id}/source-rows`)).query({ eq_column: 'transaction_date', eq_value: 'not a date' }).set(bearer(a));
    expect(typed.status).toBe(422);
    expect(typed.body.error.details.fields[0].path).toBe('eq_value');
  });

  it('is 404 for a block without a source filter', async () => {
    const res = await askQ(a, formulaId, 'FORMULA which items?');
    expect(res.status).toBe(201);
    expect(res.body.data.has_source_rows).toBe(false);
    expect((await request(app).get(api(`/blocks/${res.body.data.id}/source-rows`)).set(bearer(a))).status).toBe(404);
  });
});

describe('GET /blocks/:id/export.csv', () => {
  it('is UTF-8 with BOM, an attachment, neutralises formula cells and keeps numbers as numbers', async () => {
    const asked = await askQ(a, formulaId, 'FORMULA which items?');
    const exportsBefore = await countEvents(a.id, 'export');
    const res = await request(app).get(api(`/blocks/${asked.body.data.id}/export.csv`)).set(bearer(a)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="items-and-amounts-\d{4}-\d{2}-\d{2}\.csv"$/);
    const body = res.body as Buffer;
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = body.toString('utf8').slice(1);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('item,amount');
    expect(lines).toContain(`"'=HYPERLINK(""http://x"",""click"")",10.5`);
    expect(lines).toContain(`'+27 82 555 1234,9`);
    expect(lines).toContain(`'-3+3,8`);
    expect(lines).toContain(`'@SUM(A1),7`);
    expect(lines).toContain('Tea,6');
    expect(await countEvents(a.id, 'export')).toBe(exportsBefore + 1);
  });
});

describe('POST /blocks/:id/feedback', () => {
  it('stores a feedback usage event with the note', async () => {
    const res = await request(app).post(api(`/blocks/${block.id}/feedback`)).set(bearer(a)).send({ kind: 'looks_wrong', note: 'The total looks too high.' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { received: true } });
    const { data } = await supabaseAdmin().from('usage_events').select('meta').eq('owner_id', a.id).eq('kind', 'feedback');
    expect(data!.map((e) => e.meta)).toContainEqual({ block_id: block.id, kind: 'looks_wrong', note: 'The total looks too high.' });
    expect((await request(app).post(api(`/blocks/${block.id}/feedback`)).set(bearer(a)).send({ kind: 'other' })).status).toBe(422);
    expect((await request(app).post(api(`/blocks/${block.id}/feedback`)).set(bearer(a)).send({ kind: 'looks_wrong', note: 'x'.repeat(501) })).status).toBe(422);
  });
});

describe("another user's blocks and datasets are 404 on every endpoint", () => {
  it('ask, list, get, source rows, export, feedback, delete', async () => {
    const as = (r: request.Test) => r.set(bearer(b));
    expect((await as(request(app).post(api(`/datasets/${cardId}/ask`))).send({ question: 'What sold?' })).status).toBe(404);
    expect((await as(request(app).get(api(`/datasets/${cardId}/blocks`)))).status).toBe(404);
    expect((await as(request(app).get(api(`/blocks/${block.id}`)))).status).toBe(404);
    expect((await as(request(app).get(api(`/blocks/${block.id}/source-rows`)))).status).toBe(404);
    expect((await as(request(app).get(api(`/blocks/${block.id}/export.csv`)))).status).toBe(404);
    expect((await as(request(app).post(api(`/blocks/${block.id}/feedback`))).send({ kind: 'looks_wrong' })).status).toBe(404);
    expect((await as(request(app).delete(api(`/blocks/${block.id}`)))).status).toBe(404);
    expect((await request(app).get(api(`/blocks/${block.id}`)).set(bearer(a))).status).toBe(200);
  });
});

describe('DELETE /blocks/:id', () => {
  it('is 409 while the block is pinned in a report, then deletes once unpinned', async () => {
    // A real report made through the API (Part 4).
    const report = (await request(app).post(api('/reports')).set(bearer(a)).send({ workspace_id: ws, title: 'Pinned', block_ids: [block.id] }).expect(201)).body.data as { id: string };
    const pinned = await request(app).delete(api(`/blocks/${block.id}`)).set(bearer(a));
    expect(pinned.status).toBe(409);
    expect(pinned.body.error.code).toBe('conflict');
    await request(app).delete(api(`/reports/${report.id}`)).set(bearer(a)).expect(200); // the report goes, the block stays
    const res = await request(app).delete(api(`/blocks/${block.id}`)).set(bearer(a)).expect(200);
    expect(res.body).toEqual({ data: { deleted: true } });
    expect((await request(app).get(api(`/blocks/${block.id}`)).set(bearer(a))).status).toBe(404);
  });
});

describe('rate limit', () => {
  it('more than 20 asks a minute is 429 with Retry-After', async () => {
    // Invalid bodies are cheap and still count against the ask limit (the limiter runs first).
    let last: request.Response | undefined;
    for (let i = 0; i < 25; i++) {
      last = await request(app).post(api(`/datasets/${cardId}/ask`)).set(bearer(a)).send({ question: 'x' });
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
