import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toBlock, type BlockRow } from '../../src/services/blocks.js';
import type { ResolvedFilter } from '../../src/services/dashboard/data.js';
import { dashboardCaption, defaultReportTitle, pickWidgets, saveToReportBody } from '../../src/services/dashboard/save.js';
import type { DashboardWidget } from '../../src/types/api.js';

/** Part W3: saving the dashboard to a report. The route, figures and transaction are in test/integration/dashboard-save.test.ts. */

const DOCS = new URL('../../../docs/', import.meta.url);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the contract', () => {
  it('lists the endpoint, its paragraph and the types', () => {
    const contract = readFileSync(new URL('API_CONTRACT.md', DOCS), 'utf8');
    const types = readFileSync(new URL('api-types.ts', DOCS), 'utf8');
    expect(contract).toContain('| POST `/datasets/:id/dashboard/save-to-report` | `SaveDashboardToReportRequest` |');
    expect(contract).toContain('**Saving a dashboard to a report.** No model is called.');
    expect(types).toContain('export interface SaveDashboardToReportRequest {');
    expect(types).toContain("export type BlockSource = 'user' | 'suggested' | 'template' | 'dashboard';");
    expect(types).toContain('filters: DashboardFilterValue[] | null;');
    expect(readFileSync(new URL('../server/src/types/api.ts', DOCS), 'utf8').replace(/\r/g, '')).toBe(types.replace(/\r/g, ''));
  });
});

describe('the request body', () => {
  const ok = { filters: [], widget_ids: [id(1), id(2)] };
  it('accepts the documented shape', () => {
    expect(saveToReportBody.safeParse(ok).success).toBe(true);
    expect(saveToReportBody.safeParse({ ...ok, report_id: id(9) }).success).toBe(true);
    expect(saveToReportBody.parse({ ...ok, title: '  Week 41  ' }).title).toBe('Week 41');
  });
  it.each([
    ['an unknown field', { ...ok, figures: [1] }],
    ['SQL', { ...ok, sql: 'SELECT 1' }],
    ['no filters', { widget_ids: [id(1)] }],
    ['no widgets', { filters: [], widget_ids: [] }],
    ['31 widgets', { filters: [], widget_ids: Array.from({ length: 31 }, (_, i) => id(i)) }],
    ['a duplicate', { filters: [], widget_ids: [id(1), id(1)] }],
    ['a bad id', { filters: [], widget_ids: ['1'] }],
    ['a blank title', { ...ok, title: '  ' }],
    ['a long title', { ...ok, title: 'x'.repeat(121) }],
    ['a title with report_id', { ...ok, report_id: id(9), title: 'x' }],
    ['an unknown filter field', { ...ok, filters: [{ filter_id: 'date', sql: 'TRUE' }] }],
  ])('rejects %s', (_, body) => {
    expect(saveToReportBody.safeParse(body).success).toBe(false);
  });
});

describe('widgets', () => {
  const w = (n: number): DashboardWidget => ({
    id: id(n),
    position: n,
    title: `W${n}`,
    width: 'quarter',
    sql: 'SELECT 1 AS n',
    chart: { type: 'kpi', x: null, y: ['n'], series: null, orientation: 'vertical', stacked: false, value_format: { n: 'integer' } },
  });
  it('keeps the request order, and an unknown id is a 422 naming its position', () => {
    expect(pickWidgets([w(1), w(2), w(3)], [id(3), id(1)]).map((x) => x.title)).toEqual(['W3', 'W1']);
    try {
      pickWidgets([w(1)], [id(1), id(7)]);
      expect.unreachable();
    } catch (err) {
      expect((err as { details: unknown }).details).toEqual({ fields: [{ location: 'body', path: 'widget_ids.1', message: 'This widget is not part of this dashboard.' }] });
    }
  });
});

describe('the caption', () => {
  const cat = (label: string, values: string[]): ResolvedFilter => ({ filter_id: `cat:${label}`, label, kind: 'category', column: label, values });
  const date = (from: string | null, to: string | null): ResolvedFilter => ({ filter_id: 'date', label: 'Date', kind: 'date_range', column: 'd', from, to });

  it('is fixed text around the dataset name and the filters in force', () => {
    expect(dashboardCaption('Booking app', [])).toBe('From "Booking app". No filters.');
    expect(dashboardCaption('Booking app', [cat('Niche', ['Hair Salon', 'Spa & Nail Salon'])])).toBe('From "Booking app". Filtered to: Niche is Hair Salon, Spa & Nail Salon.');
    expect(dashboardCaption('Sales', [date('2026-10-05', '2026-10-11')])).toBe('From "Sales". Filtered to: Dates from 2026-10-05 to 2026-10-11.');
    expect(dashboardCaption('Sales', [date('2026-10-05', null)])).toBe('From "Sales". Filtered to: Dates from 2026-10-05.');
    expect(dashboardCaption('Sales', [date(null, '2026-10-11')])).toBe('From "Sales". Filtered to: Dates up to 2026-10-11.');
    expect(dashboardCaption('Sales', [cat('Store', ['Durban']), date('2026-10-05', '2026-10-11')])).toBe(
      'From "Sales". Filtered to: Store is Durban; Dates from 2026-10-05 to 2026-10-11.',
    );
  });

  it('shows injection-shaped values as plain text', () => {
    expect(dashboardCaption('x', [cat('Status', ["x' OR '1'='1", "'); DROP TABLE data; --"])])).toBe(
      `From "x". Filtered to: Status is x' OR '1'='1, '); DROP TABLE data; --.`,
    );
  });
});

describe('the default title', () => {
  it('is "<dataset name>, dashboard", cut to 120 characters', () => {
    expect(defaultReportTitle('Booking app')).toBe('Booking app, dashboard');
    const long = defaultReportTitle('n'.repeat(200));
    expect(long).toHaveLength(120);
    expect(long.endsWith(', dashboard')).toBe(true);
  });
});

describe('a saved block as returned by the API', () => {
  const row = (over: Partial<BlockRow>): BlockRow => ({
    id: 'b',
    owner_id: 'o',
    dataset_id: 'd',
    question: 'Orders',
    title: 'Orders',
    sql: 'SELECT count(*) AS n FROM data',
    source_filter_sql: null,
    columns: [],
    rows: [],
    row_count: 1,
    truncated: false,
    chart: { type: 'kpi', x: null, y: ['n'], series: null, orientation: 'vertical', stacked: false, value_format: { n: 'integer' } },
    reconcile: null,
    narrative_template: 'From "x". No filters.',
    narrative: 'From "x". No filters.',
    follow_ups: [],
    checks: [],
    status: 'ok',
    source: 'dashboard',
    model: null,
    filters: [],
    created_at: '2026-11-24T10:00:00+02:00',
    ...over,
  });
  it('has source rows while the dataset exists, and filters in the request form (no columns or labels)', () => {
    expect(toBlock(row({})).has_source_rows).toBe(true);
    expect(toBlock(row({ dataset_id: null })).has_source_rows).toBe(false);
    const filters: ResolvedFilter[] = [
      { filter_id: 'cat:store', label: 'Store', kind: 'category', column: 'store', values: ['Durban'] },
      { filter_id: 'date', label: 'Order date', kind: 'date_range', column: 'order_date', from: '2026-10-01', to: null },
    ];
    expect(toBlock(row({ filters })).filters).toEqual([
      { filter_id: 'cat:store', values: ['Durban'] },
      { filter_id: 'date', from: '2026-10-01', to: null },
    ]);
  });
  it('an ordinary answer is unchanged: filters null, source rows only with a source filter', () => {
    const ask = row({ source: 'user', filters: null });
    expect(toBlock(ask).filters).toBeNull();
    expect(toBlock(ask).has_source_rows).toBe(false);
    expect(toBlock({ ...ask, source_filter_sql: 'TRUE' }).has_source_rows).toBe(true);
  });
});
