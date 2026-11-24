import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { dashboardDataBody, resolveFilters, runDashboardData, scopedSql, scopePredicate } from '../../src/services/dashboard/data.js';
import { withSandbox } from '../../src/services/sandbox/sandbox.js';
import type { DashboardFilter, DashboardWidget } from '../../src/types/api.js';

// 12 tickets: opened over three months, three priorities, two teams; one ticket has no date.
const TICKETS = [
  ['T1', '2026-08-03', 'high', 'Ops'],
  ['T2', '2026-08-15', 'low', 'Ops'],
  ['T3', '2026-08-30', 'medium', 'Sales'],
  ['T4', '2026-09-01', 'high', 'Sales'],
  ['T5', '2026-09-10', 'high', 'Ops'],
  ['T6', '2026-09-20', 'low', 'Ops'],
  ['T7', '2026-09-30', 'medium', 'Sales'],
  ['T8', '2026-10-01', 'low', 'Ops'],
  ['T9', '2026-10-05', 'high', 'Sales'],
  ['T10', '2026-10-31', 'medium', 'Ops'],
  ['T11', '', 'high', 'Ops'],
  ["x' OR '1'='1", '2026-10-02', "'); DROP TABLE data; --", 'Ops'],
];
const csv = Buffer.from(
  `ticket,opened,priority,team\n${TICKETS.map((r) => r.map((v) => (/[,"']/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')}\n`,
);
const columns = [
  { sql_name: 'ticket', data_type: 'text' as const },
  { sql_name: 'opened', data_type: 'date' as const },
  { sql_name: 'priority', data_type: 'text' as const },
  { sql_name: 'team', data_type: 'text' as const },
];
const FILTERS: DashboardFilter[] = [
  { id: 'date', kind: 'date_range', column: 'opened', label: 'Opened', options: [], min: '2026-08-03', max: '2026-10-31' },
  { id: 'cat:priority', kind: 'category', column: 'priority', label: 'Priority', options: ['high', 'low', 'medium'], min: null, max: null },
  { id: 'cat:team', kind: 'category', column: 'team', label: 'Team', options: ['Ops', 'Sales'], min: null, max: null },
];
const widget = (id: string, sql: string, vf: Record<string, string>, type: DashboardWidget['chart']['type'] = 'kpi'): DashboardWidget => ({
  id,
  position: Number(id.slice(1)),
  title: id,
  width: 'quarter',
  sql,
  chart: { type, x: null, y: Object.keys(vf).slice(-1), series: null, orientation: 'vertical', stacked: false, value_format: vf as never },
});
const WIDGETS = [
  widget('w0', 'SELECT count(*) AS tickets FROM data', { tickets: 'integer' }),
  widget('w1', 'SELECT "priority", count(*) AS n FROM data GROUP BY 1 ORDER BY 1', { priority: 'text', n: 'integer' }, 'bar'),
  widget('w2', 'WITH t AS (SELECT * FROM data WHERE "team" = \'Ops\') SELECT count(*) AS ops FROM t', { ops: 'integer' }),
];

const run = (filters: Array<Record<string, unknown>>, widgets = WIDGETS) =>
  withSandbox({ csv, columns }, (s) => runDashboardData(s, widgets, resolveFilters(FILTERS, dashboardDataBody.parse({ filters }))));
const kpiOf = (d: Awaited<ReturnType<typeof run>>, id: string) => Object.values(d.widgets.find((w) => w.widget_id === id)!.rows[0]!)[0];

// Hand counts over TICKETS with a plain loop.
const handCount = (keep: (r: string[]) => boolean) => TICKETS.filter(keep).length;

describe('dashboard filters restrict the rows the widgets read', () => {
  it('no filters: the unfiltered numbers, rows_in_scope = rows_total', async () => {
    const d = await run([]);
    expect(d).toMatchObject({ rows_total: 12, rows_in_scope: 12 });
    expect(kpiOf(d, 'w0')).toBe(12);
    expect(kpiOf(d, 'w2')).toBe(handCount((r) => r[3] === 'Ops'));
  });

  it('a date range keeps from..to inclusive and drops rows without a date', async () => {
    const d = await run([{ filter_id: 'date', from: '2026-09-01', to: '2026-09-30' }]);
    const hand = handCount((r) => r[1]! >= '2026-09-01' && r[1]! <= '2026-09-30');
    expect(hand).toBe(4);
    expect(d.rows_in_scope).toBe(hand);
    expect(kpiOf(d, 'w0')).toBe(hand);
    // Only a start date: open-ended, still without the undated ticket.
    expect((await run([{ filter_id: 'date', from: '2026-10-01' }])).rows_in_scope).toBe(handCount((r) => r[1]! >= '2026-10-01'));
  });

  it('a category keeps rows whose value is in the list', async () => {
    const d = await run([{ filter_id: 'cat:priority', values: ['high', 'low'] }]);
    expect(d.rows_in_scope).toBe(handCount((r) => r[2] === 'high' || r[2] === 'low'));
    expect(d.widgets[1]!.rows).toEqual([
      { priority: 'high', n: 5 },
      { priority: 'low', n: 3 },
    ]);
  });

  it('filters combine with AND, also with a widget that has its own WITH', async () => {
    const d = await run([
      { filter_id: 'date', from: '2026-08-01', to: '2026-09-30' },
      { filter_id: 'cat:team', values: ['Ops'] },
    ]);
    const hand = handCount((r) => r[1]! >= '2026-08-01' && r[1]! <= '2026-09-30' && r[3] === 'Ops');
    expect(hand).toBe(4);
    expect(d.rows_in_scope).toBe(hand);
    expect(kpiOf(d, 'w2')).toBe(hand);
  });

  it('an empty value list and an empty date range mean no restriction', async () => {
    expect((await run([{ filter_id: 'cat:team', values: [] }, { filter_id: 'date', from: null, to: null }])).rows_in_scope).toBe(12);
  });

  it.each([["x' OR '1'='1"], ["'); DROP TABLE data; --"], ['%'], ['Ops" OR 1=1 --']])('the value %j is plain text and runs nothing', async (v) => {
    const d = await run([{ filter_id: 'cat:priority', values: [v] }]);
    expect(d.rows_in_scope).toBe(handCount((r) => r[2] === v));
    // The table is still there.
    expect((await run([])).rows_total).toBe(12);
  });

  it('values are bound parameters, and column names come from the dashboard', () => {
    const { where, params } = scopePredicate([{ filter_id: 'cat:priority', label: 'Priority', kind: 'category', column: 'priority', values: ["x' OR '1'='1"] }]);
    expect(where).toBe('(CAST("priority" AS VARCHAR) IN ($1))');
    expect(params).toEqual(["x' OR '1'='1"]);
    expect(scopedSql('WITH a AS (SELECT 1 AS x) SELECT x FROM a', 'p')).toBe('WITH data AS (SELECT * FROM data WHERE p), a AS (SELECT 1 AS x) SELECT x FROM a');
    expect(scopedSql('SELECT 1', '')).toBe('SELECT 1');
  });
});

describe('dashboard data: each widget on its own', () => {
  it('a widget that fails returns error and the others still return', async () => {
    const broken = widget('w9', 'SELECT nope FROM data', { nope: 'integer' });
    const d = await run([], [...WIDGETS, broken]);
    expect(d.widgets.find((w) => w.widget_id === 'w9')).toMatchObject({ error: 'This widget could not be calculated.', rows: [], checks: [] });
    expect(d.widgets.filter((w) => w.error === null)).toHaveLength(3);
  });

  it('rows are capped at 50 and truncated is set honestly, with the two checks', async () => {
    const many = widget('w5', 'SELECT range AS n FROM range(60)', { n: 'integer' }, 'table');
    // range() is a table function, refused by the sandbox: it returns error instead.
    expect((await run([], [many])).widgets[0]!.error).not.toBeNull();
    const long = widget('w6', "SELECT \"ticket\" || '-' || CAST(g AS VARCHAR) AS t FROM data, (SELECT unnest(generate_series(1, 5)) AS g) AS s", { t: 'text' }, 'table');
    const r = (await run([], [long])).widgets[0]!;
    expect(r).toMatchObject({ total_rows: 60, truncated: true, error: null });
    expect(r.rows).toHaveLength(50);
    expect(r.checks.map((c) => [c.type, c.ok])).toEqual([
      ['sql_read_only', true],
      ['result_not_truncated', false],
    ]);
    const short = (await run([], WIDGETS)).widgets[1]!;
    // high, low, medium and the injection-text priority.
    expect(short).toMatchObject({ truncated: false, total_rows: 4 });
    expect(short.columns).toEqual([
      { name: 'priority', format: 'text' },
      { name: 'n', format: 'integer' },
    ]);
  });
});

describe('dashboard data: request checks (422)', () => {
  const resolve = (filters: unknown) => resolveFilters(FILTERS, dashboardDataBody.parse({ filters }));
  const fails = (filters: unknown, path: string) => {
    try {
      resolve(filters);
      throw new Error('expected 422');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(422);
      expect((err as AppError).details).toMatchObject({ fields: [{ location: 'body', path }] });
    }
  };
  it('an unknown filter_id', () => fails([{ filter_id: 'cat:email', values: ['x'] }], 'filters.0.filter_id'));
  it('a malformed or impossible date', () => {
    fails([{ filter_id: 'date', from: '01/09/2026' }], 'filters.0.from');
    fails([{ filter_id: 'date', to: '2026-02-30' }], 'filters.0.to');
  });
  it('from after to', () => fails([{ filter_id: 'date', from: '2026-10-01', to: '2026-09-01' }], 'filters.0.from'));
  it('a value list on a date filter', () => fails([{ filter_id: 'date', values: ['2026-09-01'] }], 'filters.0.values'));
  it('dates on a category filter', () => fails([{ filter_id: 'cat:team', from: '2026-09-01' }], 'filters.0.from'));
  it('the same filter twice', () => fails([{ filter_id: 'cat:team', values: ['Ops'] }, { filter_id: 'cat:team', values: ['Sales'] }], 'filters.1.filter_id'));
  it('51 values, and unknown fields, are refused by the body schema', () => {
    expect(dashboardDataBody.safeParse({ filters: [{ filter_id: 'cat:team', values: Array.from({ length: 51 }, (_, i) => `v${i}`) }] }).success).toBe(false);
    expect(dashboardDataBody.safeParse({ filters: [{ filter_id: 'cat:team', values: ['Ops'], column: 'team' }] }).success).toBe(false);
    expect(dashboardDataBody.safeParse({ filters: [], sql: 'x' }).success).toBe(false);
  });
});
