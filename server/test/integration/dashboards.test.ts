import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, setPlan, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { dashboardsIdle } from '../../src/services/dashboard/job.js';
import { STALE_MESSAGE } from '../../src/services/dashboard/storage.js';
import { profilingIdle } from '../../src/services/profiling.js';
import type { Dashboard, DashboardData, Dataset, DatasetDetail, Workspace } from '../../src/types/api.js';

/**
 * The dashboard (Part W2) against real Supabase with a mocked model. The mock plans six widgets over the orders file
 * below; `gate` holds planning open so a second POST can arrive while it runs; `planMode` switches to a model failure.
 */
let gate: Promise<void> = Promise.resolve();
let planMode: 'good' | 'fail' = 'good';
vi.mock('../../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/client.js')>();
  const usage = { model: 'test/planner', inputTokens: 900, outputTokens: 700, costUsd: 0.012 };
  const k = (title: string, sql: string, alias: string, format = 'integer') => ({
    title,
    sql,
    width: 'quarter',
    chart: { type: 'kpi', x: null, y: [alias], series: null, orientation: 'vertical', stacked: false, value_format: { [alias]: format } },
  });
  const plan = {
    reading: 'One row per order; the date column is order_date; the main amount is amount.',
    date_column: 'order_date',
    filter_columns: ['store', 'status'],
    widgets: [
      k('Orders', 'SELECT count(*) AS orders FROM data', 'orders'),
      k('Customers', 'SELECT count(DISTINCT "email") AS customers FROM data', 'customers'),
      k('Revenue', 'SELECT round(sum("amount"), 2) AS revenue FROM data', 'revenue', 'zar'),
      k('Refunded share', 'SELECT avg(CASE WHEN "status" = \'refunded\' THEN 1.0 ELSE 0 END) AS share FROM data', 'share', 'percent'),
      {
        title: 'Revenue by store',
        sql: 'SELECT "store", round(sum("amount"), 2) AS revenue FROM data GROUP BY 1 ORDER BY 1',
        width: 'half',
        chart: { type: 'bar', x: 'store', y: ['revenue'], series: null, orientation: 'vertical', stacked: false, value_format: { store: 'text', revenue: 'zar' } },
      },
      {
        title: 'Orders per month',
        sql: 'SELECT CAST(date_trunc(\'month\', "order_date") AS DATE) AS month, count(*) AS orders FROM data GROUP BY 1 ORDER BY 1',
        width: 'full',
        chart: { type: 'line', x: 'month', y: ['orders'], series: null, orientation: 'vertical', stacked: false, value_format: { month: 'date', orders: 'integer' } },
      },
    ],
  };
  const fake = {
    provider: 'openrouter' as const,
    modelFor: (role: string) => (role === 'planner' ? 'test/planner' : 'test/fast'),
    callTool: vi.fn(async (req: { tool: { name: string }; schema: { parse: (v: unknown) => unknown } }) => {
      if (req.tool.name === 'suggest_questions') {
        return { output: { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, why: 'w' })) }, usage };
      }
      await gate;
      if (planMode === 'fail') throw new actual.LlmError('server', 'The model call failed (HTTP 500).', undefined, 500);
      return { output: req.schema.parse(plan), usage };
    }),
  };
  return { ...actual, llm: () => fake };
});

const app = createApp();
const api = (p: string) => `/api/v1${p}`;

// 24 orders over two months in three stores; two refunds; one order without a date.
const STORES = ['Durban', 'Cape Town', 'Pretoria'];
const ORDERS = Array.from({ length: 24 }, (_, i) => ({
  id: String(5000 + i),
  date: i === 23 ? '' : `2026-${i < 12 ? '09' : '10'}-${String((i % 12) + 1).padStart(2, '0')}`,
  store: STORES[i % 3]!,
  status: i % 9 === 0 ? 'refunded' : 'paid',
  amount: 100 + i * 5.25,
  email: `buyer${i % 20}@example.com`,
}));
const CSV = Buffer.from(
  `Order ID,Order date,Store,Status,Amount,Email\n${ORDERS.map((o) => [o.id, o.date, o.store, o.status, o.amount.toFixed(2), o.email].join(',')).join('\n')}\n`,
);
const round2 = (n: number) => Math.round(n * 100) / 100;

let a: TestUser;
let b: TestUser;
let c: TestUser; // its own data-call rate-limit bucket
let wsA: string;
let dsA: string;
let dsA2: string; // stale run, readiness and body checks (dsA uses up its 5 plans a day)
let dsC: string;

async function consent(u: TestUser): Promise<string> {
  await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
  return ((await request(app).get(api('/workspaces')).set(bearer(u)).expect(200)).body.data as Workspace[])[0]!.id;
}
async function uploadReady(u: TestUser, ws: string, name: string): Promise<string> {
  const id = ((await request(app).post(api('/datasets')).set(bearer(u)).field('workspace_id', ws).attach('file', CSV, name).expect(201)).body.data as Dataset).id;
  for (let i = 0; i < 240; i++) {
    const d = (await request(app).get(api(`/datasets/${id}`)).set(bearer(u)).expect(200)).body.data as DatasetDetail;
    if (d.status === 'ready') return id;
    if (d.status === 'failed') throw new Error(`profiling failed: ${d.error_message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('profiling did not finish');
}
const getDash = (u: TestUser, ds: string) => request(app).get(api(`/datasets/${ds}/dashboard`)).set(bearer(u));
const plan = (u: TestUser, ds: string) => request(app).post(api(`/datasets/${ds}/dashboard`)).set(bearer(u)).send();
const data = (u: TestUser, ds: string, filters: unknown[] = []) => request(app).post(api(`/datasets/${ds}/dashboard/data`)).set(bearer(u)).send({ filters });
async function planned(u: TestUser, ds: string): Promise<Dashboard> {
  await plan(u, ds).expect(202);
  await dashboardsIdle();
  return (await getDash(u, ds).expect(200)).body.data as Dashboard;
}
const kpi = (d: DashboardData, dash: Dashboard, title: string) => {
  const w = dash.widgets.find((x) => x.title === title)!;
  return Object.values(d.widgets.find((r) => r.widget_id === w.id)!.rows[0]!)[0];
};

beforeAll(async () => {
  [a, b, c] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
  await setPlan(a.id, 'practice');
  const ws = await Promise.all([consent(a), consent(b), consent(c)]);
  wsA = ws[0];
  [dsA, dsA2, dsC] = await Promise.all([uploadReady(a, wsA, 'orders.csv'), uploadReady(a, wsA, 'orders-2.csv'), uploadReady(c, ws[2], 'orders.csv')]);
}, 120_000);

afterAll(async () => {
  await dashboardsIdle();
  await profilingIdle();
  await deleteTestUsers();
});

describe('planning the dashboard', () => {
  it('GET is 404 before the first POST, and for another user’s or an unknown dataset', async () => {
    expect((await getDash(a, dsA)).status).toBe(404);
    expect((await getDash(b, dsA)).status).toBe(404);
    expect((await getDash(a, randomUUID())).status).toBe(404);
    expect((await plan(b, dsA)).status).toBe(404);
  });

  it('POST returns 202 planning; a second POST while planning returns the same dashboard', async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const first = (await plan(a, dsA).expect(202)).body.data as Dashboard;
    expect(first).toMatchObject({ dataset_id: dsA, status: 'planning', fallback: false, widgets: [], filters: [] });
    const second = (await plan(a, dsA).expect(202)).body.data as Dashboard;
    expect(second).toEqual(first);
    expect(((await getDash(a, dsA).expect(200)).body.data as Dashboard).status).toBe('planning');
    release();
    await dashboardsIdle();
    const ready = (await getDash(a, dsA).expect(200)).body.data as Dashboard;
    expect(ready).toMatchObject({ id: first.id, status: 'ready', fallback: false, error_message: null });
    expect(ready.widgets.map((w) => w.title)).toEqual(['Orders', 'Customers', 'Revenue', 'Refunded share', 'Revenue by store', 'Orders per month']);
    expect(ready.reading).toEqual({ text: 'One row per order; the date column is order_date; the main amount is amount.', date_column: 'order_date' });
    expect(ready.filters.map((f) => [f.id, f.options, f.min, f.max])).toEqual([
      ['date', [], '2026-09-01', '2026-10-11'],
      ['cat:store', ['Cape Town', 'Durban', 'Pretoria'], null, null],
      ['cat:status', ['paid', 'refunded'], null, null],
    ]);
    // Logged for cost: one dashboard_plan llm event, no question counted.
    const { data: events } = await supabaseAdmin().from('usage_events').select('kind, meta').eq('owner_id', a.id);
    expect((events ?? []).filter((e) => e.kind === 'llm' && (e.meta as { purpose: string }).purpose === 'dashboard_plan')).toHaveLength(1);
    expect((events ?? []).filter((e) => e.kind === 'question')).toHaveLength(0);
  });

  it('regenerating replaces the old dashboard (new widgets)', async () => {
    const before = (await getDash(a, dsA).expect(200)).body.data as Dashboard;
    const after = await planned(a, dsA);
    expect(after.id).toBe(before.id);
    expect(after.created_at > before.created_at).toBe(true);
    expect(after.widgets.map((w) => w.id)).not.toEqual(before.widgets.map((w) => w.id));
  });

  it('a model failure gives the fallback dashboard', async () => {
    planMode = 'fail';
    try {
      const d = await planned(a, dsA);
      expect(d).toMatchObject({ status: 'ready', fallback: true });
      expect(d.widgets[0]!.title).toBe('Number of records');
    } finally {
      planMode = 'good';
    }
    await planned(a, dsA); // the 5th plan on dsA today
  });

  it('a run left planning for more than 3 minutes is read as failed', async () => {
    await planned(a, dsA2);
    const old = new Date(Date.now() - 4 * 60_000).toISOString();
    await supabaseAdmin().from('dashboards').update({ status: 'planning', created_at: old }).eq('dataset_id', dsA2);
    const d = (await getDash(a, dsA2).expect(200)).body.data as Dashboard;
    expect(d).toMatchObject({ status: 'failed', error_message: STALE_MESSAGE });
    // The client can start again.
    expect(((await plan(a, dsA2).expect(202)).body.data as Dashboard).status).toBe('planning');
    await dashboardsIdle();
  });

  it('needs a ready dataset: 409 while profiling, 410 when expired', async () => {
    for (const [status, code] of [['profiling', 409], ['expired', 410]] as const) {
      await supabaseAdmin().from('datasets').update({ status }).eq('id', dsA2);
      try {
        expect((await plan(a, dsA2)).status).toBe(code);
      } finally {
        await supabaseAdmin().from('datasets').update({ status: 'ready' }).eq('id', dsA2);
      }
    }
  });

  it('POST takes no body', async () => {
    expect((await request(app).post(api(`/datasets/${dsA2}/dashboard`)).set(bearer(a)).send({ widgets: [] })).status).toBe(422);
  });

  it('a reparse deletes the dashboard (W2b), so the client plans a fresh one', async () => {
    await planned(a, dsA2);
    expect((await getDash(a, dsA2)).status).toBe(200);
    await request(app).post(api(`/datasets/${dsA2}/reparse`)).set(bearer(a)).send({}).expect(202);
    expect((await getDash(a, dsA2)).status).toBe(404);
    const { count } = await supabaseAdmin().from('dashboards').select('id', { count: 'exact', head: true }).eq('dataset_id', dsA2);
    expect(count).toBe(0);
    await profilingIdle();
  });
});

describe('POST /datasets/:id/dashboard/data', () => {
  let dash: Dashboard;
  beforeAll(async () => {
    dash = (await getDash(a, dsA).expect(200)).body.data as Dashboard;
    expect(dash.status).toBe('ready');
  });

  it('no filters: every widget, figures equal a plain loop over the rows', async () => {
    const d = (await data(a, dsA).expect(200)).body.data as DashboardData;
    expect(d).toMatchObject({ rows_total: 24, rows_in_scope: 24 });
    expect(kpi(d, dash, 'Orders')).toBe(ORDERS.length);
    expect(kpi(d, dash, 'Customers')).toBe(new Set(ORDERS.map((o) => o.email)).size);
    expect(kpi(d, dash, 'Revenue')).toBe(round2(ORDERS.reduce((s, o) => s + o.amount, 0)));
    expect(kpi(d, dash, 'Refunded share')).toBeCloseTo(ORDERS.filter((o) => o.status === 'refunded').length / ORDERS.length, 10);
    const byStore = d.widgets.find((w) => w.widget_id === dash.widgets[4]!.id)!;
    for (const store of STORES) {
      expect(byStore.rows.find((r) => r.store === store)!.revenue).toBe(round2(ORDERS.filter((o) => o.store === store).reduce((s, o) => s + o.amount, 0)));
    }
    expect(byStore.checks.map((x) => [x.type, x.ok])).toEqual([
      ['sql_read_only', true],
      ['result_not_truncated', true],
    ]);
  });

  it('a date filter and a category filter, alone and combined, restrict the rows', async () => {
    const sept = (await data(a, dsA, [{ filter_id: 'date', from: '2026-09-01', to: '2026-09-30' }]).expect(200)).body.data as DashboardData;
    expect(sept.rows_in_scope).toBe(ORDERS.filter((o) => o.date.startsWith('2026-09')).length);
    const durban = (await data(a, dsA, [{ filter_id: 'cat:store', values: ['Durban'] }]).expect(200)).body.data as DashboardData;
    expect(durban.rows_in_scope).toBe(ORDERS.filter((o) => o.store === 'Durban').length);
    expect(kpi(durban, dash, 'Revenue')).toBe(round2(ORDERS.filter((o) => o.store === 'Durban').reduce((s, o) => s + o.amount, 0)));
    const both = (
      await data(a, dsA, [
        { filter_id: 'date', from: '2026-10-01', to: '2026-10-31' },
        { filter_id: 'cat:store', values: ['Durban', 'Pretoria'] },
      ]).expect(200)
    ).body.data as DashboardData;
    const hand = ORDERS.filter((o) => o.date.startsWith('2026-10') && (o.store === 'Durban' || o.store === 'Pretoria'));
    expect(both.rows_in_scope).toBe(hand.length);
    expect(kpi(both, dash, 'Orders')).toBe(hand.length);
  });

  it.each([["x' OR '1'='1"], ["'); DROP TABLE data; --"]])('the category value %j matches nothing and runs nothing', async (v) => {
    const d = (await data(a, dsA, [{ filter_id: 'cat:store', values: [v] }]).expect(200)).body.data as DashboardData;
    expect(d.rows_in_scope).toBe(0);
    expect(((await data(a, dsA).expect(200)).body.data as DashboardData).rows_total).toBe(24);
  });

  it.each([
    ['an unknown filter_id', [{ filter_id: 'cat:email', values: ['x'] }]],
    ['a malformed date', [{ filter_id: 'date', from: '2026-9-1' }]],
    ['from after to', [{ filter_id: 'date', from: '2026-10-02', to: '2026-10-01' }]],
    ['51 values', [{ filter_id: 'cat:store', values: Array.from({ length: 51 }, (_, i) => `s${i}`) }]],
    ['a value list on a date filter', [{ filter_id: 'date', values: ['2026-10-01'] }]],
  ])('%s is 422', async (_name, filters) => {
    const res = await data(a, dsA, filters);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('another user’s dataset or dashboard is 404', async () => {
    expect((await data(b, dsA)).status).toBe(404);
    expect((await data(a, dsC)).status).toBe(404);
  });

  it('a dashboard that is not ready is 409 dashboard_not_ready', async () => {
    await supabaseAdmin().from('dashboards').update({ status: 'failed' }).eq('dataset_id', dsA);
    try {
      const res = await data(a, dsA);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('dashboard_not_ready');
    } finally {
      await supabaseAdmin().from('dashboards').update({ status: 'ready' }).eq('dataset_id', dsA);
    }
  });

  it('one widget failing does not fail the response', async () => {
    const broken = { ...dash.widgets[0]!, sql: 'SELECT nope FROM data' };
    const { data: row } = await supabaseAdmin().from('dashboards').select('plan').eq('dataset_id', dsA).single<{ plan: { widgets: unknown[] } }>();
    const original = row!.plan;
    await supabaseAdmin().from('dashboards').update({ plan: { ...original, widgets: [broken, ...original.widgets.slice(1)] } }).eq('dataset_id', dsA);
    try {
      const d = (await data(a, dsA).expect(200)).body.data as DashboardData;
      expect(d.widgets[0]).toMatchObject({ widget_id: broken.id, error: 'This widget could not be calculated.' });
      expect(d.widgets.slice(1).every((w) => w.error === null)).toBe(true);
    } finally {
      await supabaseAdmin().from('dashboards').update({ plan: original }).eq('dataset_id', dsA);
    }
  });
});

describe('rate limits', () => {
  it('the 61st data call in a minute is 429 with Retry-After', async () => {
    await planned(c, dsC);
    // 60 quick calls in parallel (each refused as 422 after the limiter counted it), then the 61st.
    const first = await Promise.all(Array.from({ length: 60 }, () => data(c, dsC, [{ filter_id: 'nope' }])));
    expect(first.every((r) => r.status === 422)).toBe(true);
    const limited = await data(c, dsC);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  }, 120_000);

  it('the 6th plan on one dataset in a day is 429', async () => {
    // c planned dsC once above; four more succeed (each returns the planning one or starts again), the 6th is refused.
    for (let i = 0; i < 4; i++) {
      expect((await plan(c, dsC)).status).toBe(202);
      await dashboardsIdle();
    }
    const sixth = await plan(c, dsC);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('rate_limited');
  }, 60_000);
});
