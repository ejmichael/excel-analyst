import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, setPlan, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { dashboardsIdle } from '../../src/services/dashboard/job.js';
import { openWorkbook, readSheetRows } from '../../src/services/parsing/xlsx.js';
import { profilingIdle } from '../../src/services/profiling.js';
import type { Block, Dashboard, DashboardData, Dataset, DatasetDetail, PublicReport, Report, ReportDetail, ShareLink, SourceRows, Workspace } from '../../src/types/api.js';

/**
 * Saving the dashboard to a report (Part W3) against real Supabase. The model is mocked only to plan the dashboard;
 * saving itself never calls it (checked). Figures are hand-checked against plain loops over the rows below.
 */
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
      return { output: req.schema.parse(plan), usage };
    }),
  };
  return { ...actual, llm: () => fake };
});
const { llm } = await import('../../src/llm/client.js');

const app = createApp();
const api = (p: string) => `/api/v1${p}`;

// 24 orders over two months in three stores; three refunds; one order without a date.
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

let a: TestUser; // practice plan: the main user
let b: TestUser; // another user
let f: TestUser; // free plan: one report a month
let wsA: string;
let wsF: string;
let dsA: string;
let dsN: string; // a's second file: no dashboard at first, then planning / not ready / expired
let dsF: string;
let dash: Dashboard;
let dashF: Dashboard;

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
async function planned(u: TestUser, ds: string): Promise<Dashboard> {
  await request(app).post(api(`/datasets/${ds}/dashboard`)).set(bearer(u)).send().expect(202);
  await dashboardsIdle();
  return (await request(app).get(api(`/datasets/${ds}/dashboard`)).set(bearer(u)).expect(200)).body.data as Dashboard;
}
const save = (u: TestUser, ds: string, body: Record<string, unknown>) => request(app).post(api(`/datasets/${ds}/dashboard/save-to-report`)).set(bearer(u)).send(body);
const data = (u: TestUser, ds: string, filters: unknown[]) => request(app).post(api(`/datasets/${ds}/dashboard/data`)).set(bearer(u)).send({ filters });
const detail = async (u: TestUser, id: string) => (await request(app).get(api(`/reports/${id}`)).set(bearer(u)).expect(200)).body.data as ReportDetail;
const sourceRows = async (u: TestUser, blockId: string, query = '') =>
  (await request(app).get(api(`/blocks/${blockId}/source-rows?limit=200${query}`)).set(bearer(u)).expect(200)).body.data as SourceRows;
const ids = (d: Dashboard, ...titles: string[]) => titles.map((t) => d.widgets.find((w) => w.title === t)!.id);
const allIds = (d: Dashboard) => [...d.widgets].sort((x, y) => x.position - y.position).map((w) => w.id);
const countRows = async (table: string, owner: string) =>
  (await supabaseAdmin().from(table).select('id', { count: 'exact', head: true }).eq('owner_id', owner)).count ?? 0;
const events = async (owner: string, kind: string) =>
  (await supabaseAdmin().from('usage_events').select('id', { count: 'exact', head: true }).eq('owner_id', owner).eq('kind', kind)).count ?? 0;
const first = (blk: Block) => Object.values(blk.rows[0]!)[0];

beforeAll(async () => {
  [a, b, f] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
  await setPlan(a.id, 'practice');
  [wsA, , wsF] = await Promise.all([consent(a), consent(b), consent(f)]);
  [dsA, dsN, dsF] = await Promise.all([uploadReady(a, wsA, 'orders.csv'), uploadReady(a, wsA, 'orders-2.csv'), uploadReady(f, wsF, 'orders.csv')]);
  dash = await planned(a, dsA);
  dashF = await planned(f, dsF);
  expect(dash.status).toBe('ready');
  expect(dash.widgets).toHaveLength(6);
}, 180_000);

afterAll(async () => {
  await dashboardsIdle();
  await profilingIdle();
  await deleteTestUsers();
});

describe('saving with no filters', () => {
  let report: Report;
  let blocks: Block[];

  it('creates a report with one block per widget, in the requested order, and calls no model', async () => {
    const calls = vi.mocked(llm().callTool).mock.calls.length;
    const order = [...allIds(dash)].reverse();
    const res = await save(a, dsA, { filters: [], widget_ids: order }).expect(201);
    report = res.body.data as Report;
    expect(report.title).toBe('orders, dashboard');
    expect(report.block_count).toBe(6);
    expect(report.workspace_id).toBe(wsA);
    expect(report.period_label).toBeNull();
    expect(vi.mocked(llm().callTool).mock.calls.length).toBe(calls);
    const d = await detail(a, report.id);
    blocks = d.blocks.map((rb) => rb.block);
    expect(d.blocks.map((rb) => rb.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(blocks.map((blk) => blk.title)).toEqual(order.map((id) => dash.widgets.find((w) => w.id === id)!.title));
  });

  it('each block holds the rows the dashboard shows, its SQL, checks, origin and the "No filters" caption', async () => {
    const shown = (await data(a, dsA, []).expect(200)).body.data as DashboardData;
    for (const blk of blocks) {
      const w = dash.widgets.find((x) => x.title === blk.title)!;
      const r = shown.widgets.find((x) => x.widget_id === w.id)!;
      expect(blk.rows).toEqual(r.rows);
      expect(blk.columns).toEqual(r.columns);
      expect(blk.row_count).toBe(r.total_rows);
      expect(blk.sql).toBe(w.sql);
      expect(blk.chart).toEqual(w.chart);
      expect(blk.source).toBe('dashboard');
      expect(blk.question).toBe(w.title);
      expect(blk.filters).toEqual([]);
      expect(blk.narrative).toBe('From "orders". No filters.');
      expect(blk.checks.map((c) => [c.type, c.ok])).toEqual([
        ['sql_read_only', true],
        ['result_not_truncated', true],
      ]);
      expect(blk.status).toBe('ok');
      expect(blk.follow_ups).toEqual([]);
      expect(blk.has_source_rows).toBe(true);
    }
    const revenue = blocks.find((blk) => blk.title === 'Revenue')!;
    expect(first(revenue)).toBeCloseTo(round2(ORDERS.reduce((s, o) => s + o.amount, 0)), 2);
  });

  it('source rows of an unfiltered block are the whole file', async () => {
    const rows = await sourceRows(a, blocks[0]!.id);
    expect(rows.total).toBe(ORDERS.length);
  });

  it('counts one report and no question; writes one usage row for the save', async () => {
    expect(await events(a.id, 'question')).toBe(0);
    expect(await events(a.id, 'report')).toBe(1);
    const { data: rows } = await supabaseAdmin().from('usage_events').select('kind, meta').eq('owner_id', a.id).eq('kind', 'report');
    expect(rows![0]!.meta).toMatchObject({ purpose: 'dashboard_save', report_id: report.id, dataset_id: dsA, blocks: 6, filters: 0 });
  });
});

describe('saving with filters', () => {
  let blocks: Block[];
  const filters = [
    { filter_id: 'cat:store', values: ['Durban', 'Pretoria'] },
    { filter_id: 'date', from: '2026-09-01', to: '2026-09-30' },
  ];
  const inScope = ORDERS.filter((o) => (o.store === 'Durban' || o.store === 'Pretoria') && o.date >= '2026-09-01' && o.date <= '2026-09-30' && o.date !== '');

  it('block rows equal the filtered dashboard rows and a plain loop over the file', async () => {
    const res = await save(a, dsA, { filters, widget_ids: ids(dash, 'Orders', 'Revenue', 'Refunded share', 'Revenue by store'), title: '  September, two stores  ' }).expect(201);
    const report = res.body.data as Report;
    expect(report.title).toBe('September, two stores');
    blocks = (await detail(a, report.id)).blocks.map((rb) => rb.block);
    const shown = (await data(a, dsA, filters).expect(200)).body.data as DashboardData;
    for (const blk of blocks) {
      const w = dash.widgets.find((x) => x.title === blk.title)!;
      expect(blk.rows).toEqual(shown.widgets.find((x) => x.widget_id === w.id)!.rows);
    }
    // Hand-checked figures.
    expect(inScope.length).toBe(8);
    expect(first(blocks[0]!)).toBe(inScope.length);
    expect(first(blocks[1]!)).toBeCloseTo(round2(inScope.reduce((s, o) => s + o.amount, 0)), 2);
    expect(first(blocks[2]!)).toBeCloseTo(inScope.filter((o) => o.status === 'refunded').length / inScope.length, 6);
    const durban = blocks[3]!.rows.find((r) => r.store === 'Durban')!;
    expect(durban.revenue).toBeCloseTo(round2(inScope.filter((o) => o.store === 'Durban').reduce((s, o) => s + o.amount, 0)), 2);
    expect(blocks[3]!.rows.map((r) => r.store)).toEqual(['Durban', 'Pretoria']);
  });

  it('carries the filters and a caption with the file’s labels and values', () => {
    for (const blk of blocks) {
      expect(blk.filters).toEqual([
        { filter_id: 'cat:store', values: ['Durban', 'Pretoria'] },
        { filter_id: 'date', from: '2026-09-01', to: '2026-09-30' },
      ]);
      const storeLabel = dash.filters.find((x) => x.id === 'cat:store')!.label;
      expect(blk.narrative).toBe(`From "orders". Filtered to: ${storeLabel} is Durban, Pretoria; Dates from 2026-09-01 to 2026-09-30.`);
    }
  });

  it('source rows return only the rows inside the filters, and their count is the filtered row count', async () => {
    const rows = await sourceRows(a, blocks[0]!.id);
    expect(rows.total).toBe(inScope.length);
    expect(rows.rows.map((r) => String(r.order_id)).sort()).toEqual(inScope.map((o) => o.id).sort());
    // eq_column narrows further; its value is bound after the filter values.
    const durban = await sourceRows(a, blocks[0]!.id, '&eq_column=store&eq_value=Durban');
    expect(durban.total).toBe(inScope.filter((o) => o.store === 'Durban').length);
  });

  it('injection-shaped values are plain text: shown in the caption, matching nothing, running nothing', async () => {
    const evil = ["x' OR '1'='1", "'); DROP TABLE data; --"];
    const res = await save(a, dsA, { filters: [{ filter_id: 'cat:status', values: evil }], widget_ids: ids(dash, 'Orders') }).expect(201);
    const blk = (await detail(a, (res.body.data as Report).id)).blocks[0]!.block;
    const statusLabel = dash.filters.find((x) => x.id === 'cat:status')!.label;
    expect(blk.narrative).toBe(`From "orders". Filtered to: ${statusLabel} is x' OR '1'='1, '); DROP TABLE data; --.`);
    expect(first(blk)).toBe(0);
    expect((await sourceRows(a, blk.id)).total).toBe(0);
    // The file is intact.
    const all = (await data(a, dsA, []).expect(200)).body.data as DashboardData;
    expect(all.rows_total).toBe(ORDERS.length);
  });
});

describe('appending to a report', () => {
  let target: Report;

  it('puts the new blocks after the existing ones, returns 200 and counts no report', async () => {
    target = (await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Orders', 'Customers') }).expect(201)).body.data as Report;
    const reportsBefore = await events(a.id, 'report');
    const savesBefore = await events(a.id, 'dashboard_save');
    const appended = await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Revenue by store', 'Orders per month'), report_id: target.id }).expect(200);
    expect((appended.body.data as Report).block_count).toBe(4);
    const d = await detail(a, target.id);
    expect(d.blocks.map((rb) => [rb.position, rb.block.title])).toEqual([
      [0, 'Orders'],
      [1, 'Customers'],
      [2, 'Revenue by store'],
      [3, 'Orders per month'],
    ]);
    expect(await events(a.id, 'report')).toBe(reportsBefore);
    expect(await events(a.id, 'dashboard_save')).toBe(savesBefore + 1);
    expect(await events(a.id, 'report_run')).toBe(0);
  });

  it('a report with a working share link is refused (the public page reads live blocks); after revoking it, the append works', async () => {
    const link = (await request(app).post(api(`/reports/${target.id}/share-links`)).set(bearer(a)).send({ show_working: true }).expect(201)).body.data as ShareLink;
    const before = (await request(app).get(api(`/public/reports/${link.token}`)).expect(200)).body.data as PublicReport;
    const blocksBefore = await countRows('blocks', a.id);
    const res = await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Revenue'), report_id: target.id });
    expect([res.status, res.body.error.code, res.body.error.details.fields[0].path]).toEqual([422, 'validation_failed', 'report_id']);
    expect(await countRows('blocks', a.id)).toBe(blocksBefore);
    const after = (await request(app).get(api(`/public/reports/${link.token}`)).expect(200)).body.data as PublicReport;
    expect(after.blocks.map((rb) => rb.block.id)).toEqual(before.blocks.map((rb) => rb.block.id));
    expect(after.blocks.at(-1)!.block.source).toBe('dashboard');
    expect(after.blocks.at(-1)!.block.filters).toEqual([]);
    expect(after.blocks.at(-1)!.block.has_source_rows).toBe(false);
    expect(JSON.stringify(after)).not.toContain(dsA);

    await request(app).delete(api(`/share-links/${link.id}`)).set(bearer(a)).expect(200);
    await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Revenue'), report_id: target.id }).expect(200);
    expect((await detail(a, target.id)).blocks).toHaveLength(5);
  });

  it('beyond 30 answers is 422 and saves nothing', async () => {
    // Fill a report to 28 answers with plain blocks (the fixture only has 6 widgets).
    const rows = Array.from({ length: 28 }, (_, i) => ({
      owner_id: a.id,
      dataset_id: dsA,
      question: `Q${i}`,
      title: `T${i}`,
      sql: 'SELECT 1',
      columns: [],
      rows: [],
      row_count: 0,
      chart: { type: 'table', x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: {} },
      narrative_template: 'n',
      narrative: 'n',
    }));
    const { data: made } = await supabaseAdmin().from('blocks').insert(rows).select('id');
    const full = (await request(app).post(api('/reports')).set(bearer(a)).send({ workspace_id: wsA, title: 'Nearly full', block_ids: made!.map((r) => r.id) }).expect(201)).body.data as ReportDetail;
    const blocksBefore = await countRows('blocks', a.id);
    const res = await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Orders', 'Customers', 'Revenue'), report_id: full.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.fields[0].path).toBe('widget_ids');
    expect(await countRows('blocks', a.id)).toBe(blocksBefore);
    expect((await detail(a, full.id)).blocks).toHaveLength(28);
  });

  it('another user’s or a missing report is 404; a report in another workspace is 422; title with report_id is 422', async () => {
    const theirs = (await save(f, dsF, { filters: [], widget_ids: ids(dashF, 'Orders') }).expect(201)).body.data as Report;
    const blocksBefore = await countRows('blocks', a.id);
    expect((await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Orders'), report_id: theirs.id })).status).toBe(404);
    expect((await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Orders'), report_id: randomUUID() })).status).toBe(404);

    const ws2 = (await request(app).post(api('/workspaces')).set(bearer(a)).send({ name: 'Other client' }).expect(201)).body.data as Workspace;
    const { data: other, error } = await supabaseAdmin().from('reports').insert({ owner_id: a.id, workspace_id: ws2.id, title: 'Other client report' }).select('id').single();
    expect(error).toBeNull();
    const res = await save(a, dsA, { filters: [], widget_ids: ids(dash, 'Orders'), report_id: other!.id });
    expect(res.status).toBe(422);
    expect(res.body.error.details.fields[0].path).toBe('report_id');

    expect(await countRows('blocks', a.id)).toBe(blocksBefore);
  });
});

describe('atomicity', () => {
  it('a widget that errors fails the whole save, naming it, and nothing is created', async () => {
    const { data: row } = await supabaseAdmin().from('dashboards').select('plan').eq('dataset_id', dsA).single();
    const broken = { ...dash.widgets[0]!, id: randomUUID(), position: 99, title: 'Broken', sql: 'SELECT CAST("store" AS INTEGER) AS n FROM data' };
    await supabaseAdmin().from('dashboards').update({ plan: { ...row!.plan, widgets: [...row!.plan.widgets, broken] } }).eq('dataset_id', dsA);
    const [blocksBefore, reportsBefore, linksBefore] = await Promise.all([countRows('blocks', a.id), countRows('reports', a.id), countRows('report_blocks', a.id)]);
    try {
      const res = await save(a, dsA, { filters: [], widget_ids: [...ids(dash, 'Orders'), broken.id] });
      expect(res.status).toBe(422);
      expect(res.body.error.details.fields).toEqual([{ location: 'body', path: 'widget_ids.1', message: `Widget ${broken.id}: This widget could not be calculated.` }]);
      expect(await countRows('blocks', a.id)).toBe(blocksBefore);
      expect(await countRows('reports', a.id)).toBe(reportsBefore);
      expect(await countRows('report_blocks', a.id)).toBe(linksBefore);
    } finally {
      await supabaseAdmin().from('dashboards').update({ plan: row!.plan }).eq('dataset_id', dsA);
    }
  });

  it('a failure while pinning leaves no report and no blocks (the SQL function is one transaction)', async () => {
    const [blocksBefore, reportsBefore] = await Promise.all([countRows('blocks', a.id), countRows('reports', a.id)]);
    const draft = {
      title: 'x',
      sql: 'SELECT 1',
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
      chart: { type: 'table', x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: {} },
      narrative: 'n',
      checks: [],
      status: 'ok',
      filters: [],
    };
    // The second block has an invalid status, so its insert fails after the report and the first block were written.
    const { error } = await supabaseAdmin().rpc('save_dashboard_blocks', {
      p_owner_id: a.id,
      p_dataset_id: dsA,
      p_report_id: null,
      p_title: 'Half done',
      p_blocks: [draft, { ...draft, status: 'not-a-status' }],
    });
    expect(error).not.toBeNull();
    expect(await countRows('blocks', a.id)).toBe(blocksBefore);
    expect(await countRows('reports', a.id)).toBe(reportsBefore);
  });
});

describe('limits and refusals', () => {
  it('a new report over the monthly report limit is 402; blocks never use max_questions_per_month', async () => {
    // f (free: one report a month) used its report above.
    const res = await save(f, dsF, { filters: [], widget_ids: ids(dashF, 'Revenue') });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('plan_limit');
    expect(res.body.error.details.limit_key).toBe('max_reports_per_month');
    expect(await events(f.id, 'question')).toBe(0);
    expect(await events(a.id, 'question')).toBe(0);
  });

  it('dashboard blocks are not in the Ask history, and no "this month" counter includes them', async () => {
    const dashboardBlocks = (await supabaseAdmin().from('blocks').select('id', { count: 'exact', head: true }).eq('owner_id', a.id).eq('source', 'dashboard')).count ?? 0;
    expect(dashboardBlocks).toBeGreaterThan(10);
    const history = (await request(app).get(api(`/datasets/${dsA}/blocks?limit=200`)).set(bearer(a)).expect(200)).body.data as { items: Block[]; total: number };
    expect(history.items.every((blk) => blk.source !== 'dashboard')).toBe(true);
    expect(history.total).toBe(28); // only the 28 plain blocks made above
    const me = (await request(app).get(api('/me')).set(bearer(a)).expect(200)).body.data as { usage: Record<string, number> };
    expect(me.usage).toMatchObject({ questions: 0, report_runs: 0 });
    // Reports counts only new reports (the appends wrote dashboard_save, which nothing counts).
    expect(me.usage.reports).toBe(await events(a.id, 'report'));
    expect(await events(a.id, 'dashboard_save')).toBeGreaterThan(0);
    // The stored suggestions are the dataset's own, untouched by saving.
    const ds = (await request(app).get(api(`/datasets/${dsA}`)).set(bearer(a)).expect(200)).body.data as DatasetDetail;
    expect(ds.suggestions.map((s) => s.question)).toEqual(['Q0?', 'Q1?', 'Q2?', 'Q3?', 'Q4?']);
  });

  it('another user’s dataset, no dashboard, planning, not ready and expired give 404, 404, 409, 409 and 410', async () => {
    const body = { filters: [], widget_ids: ids(dash, 'Orders') };
    expect((await save(b, dsA, body)).status).toBe(404);
    expect((await save(b, randomUUID(), body)).status).toBe(404);
    expect((await save(a, dsN, body)).status).toBe(404);

    const dashN = await planned(a, dsN);
    const bodyN = { filters: [], widget_ids: ids(dashN, 'Orders') };
    const admin = supabaseAdmin();
    await admin.from('dashboards').update({ status: 'planning', created_at: new Date().toISOString() }).eq('dataset_id', dsN);
    let res = await save(a, dsN, bodyN);
    expect([res.status, res.body.error.code]).toEqual([409, 'dashboard_not_ready']);
    await admin.from('dashboards').update({ status: 'ready' }).eq('dataset_id', dsN);

    await admin.from('datasets').update({ status: 'profiling' }).eq('id', dsN);
    res = await save(a, dsN, bodyN);
    expect([res.status, res.body.error.code]).toEqual([409, 'dataset_not_ready']);
    await admin.from('datasets').update({ status: 'expired' }).eq('id', dsN);
    res = await save(a, dsN, bodyN);
    expect([res.status, res.body.error.code]).toEqual([410, 'dataset_expired']);
    await admin.from('datasets').update({ status: 'ready' }).eq('id', dsN);
  });

  it('bad bodies are 422: unknown field, duplicate or unknown widget ids, bad filters, 0 or 31 widgets', async () => {
    const one = ids(dash, 'Orders');
    // The body is checked before anything is read, so b's calls against a's file are 422 (and keep a's rate budget).
    const shape = [
      { filters: [], widget_ids: one, extra: true },
      { filters: [], widget_ids: [one[0], one[0]] },
      { filters: [], widget_ids: ['not-a-uuid'] },
      { filters: [], widget_ids: [] },
      { filters: [], widget_ids: Array.from({ length: 31 }, () => randomUUID()) },
      { widget_ids: one },
      { filters: [], widget_ids: one, title: '   ' },
      { filters: [], widget_ids: one, report_id: randomUUID(), title: 'x' },
    ];
    for (const body of shape) {
      const res = await save(b, dsA, body);
      expect([res.status, res.body.error?.code], JSON.stringify(body)).toEqual([422, 'validation_failed']);
    }
    // These need the dashboard, so they are a's.
    const bad = [
      { filters: [], widget_ids: [one[0], randomUUID()] },
      { filters: [{ filter_id: 'date', from: '2026-02-30' }], widget_ids: one },
    ];
    const before = await countRows('blocks', a.id);
    for (const body of bad) {
      const res = await save(a, dsA, body);
      expect([res.status, res.body.error?.code], JSON.stringify(body)).toEqual([422, 'validation_failed']);
    }
    expect(await countRows('blocks', a.id)).toBe(before);
  });
});

describe('the saved report with the existing report features', () => {
  it('exports to Excel, exports a block to CSV, and shares', async () => {
    const report = (await save(a, dsA, { filters: [{ filter_id: 'cat:store', values: ['Durban'] }], widget_ids: ids(dash, 'Orders', 'Revenue by store'), title: 'Durban dashboard' }).expect(201))
      .body.data as Report;
    const xlsx = await request(app)
      .get(api(`/reports/${report.id}/export.xlsx`))
      .set(bearer(a))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = openWorkbook(xlsx.body as Buffer);
    const sheets = new Map<string, string[][]>();
    for (const sheet of wb.sheets) {
      const rows: string[][] = [];
      for await (const r of readSheetRows(xlsx.body as Buffer, wb, sheet)) rows[r.n - 1] = r.cells;
      sheets.set(sheet.name, Array.from(rows, (r) => r ?? []));
    }
    console.log(`Excel sheets: ${[...sheets.keys()].join(' | ')}`);
    console.log(`Sheet "${[...sheets.keys()][2]}":\n${sheets.get([...sheets.keys()][2]!)!.map((r) => r.join(' | ')).join('\n')}`);
    expect([...sheets.keys()]).toEqual(['Summary', 'Orders', 'Revenue by store', 'Working']);
    const byStore = sheets.get('Revenue by store')!.flat();
    expect(byStore).toContain('From "orders". Filtered to: Store is Durban.');
    const durban = round2(ORDERS.filter((o) => o.store === 'Durban').reduce((s, o) => s + o.amount, 0));
    expect(byStore.map(Number)).toContain(durban);
    expect(sheets.get('Working')!.flat().join(' ')).toContain('SELECT "store", round(sum("amount"), 2) AS revenue FROM data GROUP BY 1 ORDER BY 1');

    const blk = (await detail(a, report.id)).blocks[1]!.block;
    const csv = await request(app).get(api(`/blocks/${blk.id}/export.csv`)).set(bearer(a)).expect(200);
    expect(csv.text.replace(/^﻿/, '')).toBe(`store,revenue\r\nDurban,${durban}\r\n`);

    const link = (await request(app).post(api(`/reports/${report.id}/share-links`)).set(bearer(a)).send({}).expect(201)).body.data as ShareLink;
    const pub = (await request(app).get(api(`/public/reports/${link.token}`)).expect(200)).body.data as PublicReport;
    expect(pub.blocks.map((rb) => rb.block.title)).toEqual(['Orders', 'Revenue by store']);
    expect(pub.blocks[1]!.block.rows).toEqual(blk.rows);
    expect(pub.blocks[1]!.block.sql).toBe('');
  });
});

describe('the rate limit', () => {
  it('is 20 saves per minute per user', async () => {
    // A fresh user; each call is a quick 404 (not their file) that still counts.
    const g = await createTestUser();
    await consent(g);
    const results = await Promise.all(Array.from({ length: 21 }, () => save(g, dsA, { filters: [], widget_ids: ids(dash, 'Orders') })));
    expect(results.filter((r) => r.status === 429)).toHaveLength(1);
  });
});
