import { z } from 'zod';
import type {
  BlockCheck,
  CellValue,
  ChartSpec,
  Dashboard,
  DashboardData,
  DashboardFilter,
  DashboardFilterValue,
  DashboardWidget,
  DatasetDetail,
  ResultColumn,
  ValueFormat,
  WidgetResult,
} from '../types';
import { sastTimestamp } from './data';

/**
 * Mock dashboards (GET/POST /datasets/:id/dashboard, POST .../dashboard/data). The mock server works the widgets out
 * from its own example rows, so a filter really changes the results; the real server runs each widget's SQL.
 *
 * - Webstore orders (fixture 02): a planned dashboard, 8 widgets (kpi, bar, pie, line, table), a date filter and two
 *   category filters; one widget always fails, and the refunds table is empty when only paid orders are chosen.
 * - Office expenses (fixture 04): planning fails.
 * - Any other file: the basic dashboard the server builds without the model (`fallback: true`).
 * A planning dashboard turns ready (or failed) on the third poll.
 */

type Row = Record<string, CellValue>;
type Result = { status: number; body: unknown };
const ok = (data: unknown, status = 200): Result => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, details?: unknown): Result => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

/** GETs while planning before the outcome shows: the third poll returns it. */
export const MOCK_PLANNING_POLLS = 3;
/** The contract's limit on planning requests per dataset per day. */
export const MOCK_PLANS_PER_DAY = 5;
const MAX_ROWS = 50;

export interface MockDashboardState {
  dashboard: Dashboard;
  /** The outcome once planning ends. */
  outcome: 'ready' | 'failed';
  polls: number;
  plans_today: number;
}

interface WidgetDef {
  widget: Omit<DashboardWidget, 'id' | 'position'>;
  /** Works the result out from the rows left after the filters (mock only). */
  run: (rows: Row[]) => { columns: ResultColumn[]; rows: Row[] } | { error: string };
}

const spec = (type: ChartSpec['type'], x: string | null, y: string[], value_format: Record<string, ValueFormat>, extra: Partial<ChartSpec> = {}): ChartSpec => ({
  type,
  x,
  y,
  series: null,
  orientation: 'vertical',
  stacked: false,
  value_format,
  ...extra,
});

const money = (n: number) => Math.round(n * 100) / 100;
const num = (v: CellValue) => (typeof v === 'number' ? v : 0);
const total = (rows: Row[], column: string) => money(rows.reduce((s, r) => s + num(r[column] ?? null), 0));

function groupBy(rows: Row[], column: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const k = String(row[column] ?? '');
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

/** A mock row's date: the file's own date where it has one, else spread over October so a date filter does something. */
const DAY_COLUMN = '__day';
function withDays(detail: DatasetDetail, rows: Row[], spread: boolean): Row[] {
  const date = dateColumn(detail);
  return rows.map((row, i) => {
    const own = date ? row[date.sql_name] : null;
    const day = !spread && typeof own === 'string' && /^\d{4}-\d{2}-\d{2}/.test(own)
      ? own.slice(0, 10)
      : `2026-10-${String((i % 31) + 1).padStart(2, '0')}`;
    return { ...row, [DAY_COLUMN]: day };
  });
}

const dateColumn = (detail: DatasetDetail) => detail.columns.find((c) => c.data_type === 'date' || c.data_type === 'datetime') ?? null;
const categoryColumns = (detail: DatasetDetail) =>
  detail.columns.filter((c) => c.data_type === 'text' && !c.is_pii && (c.semantic === 'category' || c.distinct_count <= 12));

function webstoreWidgets(): WidgetDef[] {
  return [
    {
      widget: { title: 'Orders', width: 'quarter', sql: 'SELECT count(*) AS orders FROM data', chart: spec('kpi', null, ['orders'], { orders: 'integer' }) },
      run: (rows) => ({ columns: [{ name: 'orders', format: 'integer' }], rows: [{ orders: rows.length }] }),
    },
    {
      widget: { title: 'Revenue', width: 'quarter', sql: 'SELECT sum(total) AS revenue FROM data', chart: spec('kpi', null, ['revenue'], { revenue: 'zar' }) },
      run: (rows) => ({ columns: [{ name: 'revenue', format: 'zar' }], rows: [{ revenue: rows.length ? total(rows, 'total') : null }] }),
    },
    {
      widget: {
        title: 'Share of orders refunded',
        width: 'quarter',
        sql: "SELECT avg(CASE WHEN payment_status = 'refunded' THEN 1 ELSE 0 END) AS refunded_share FROM data",
        chart: spec('kpi', null, ['refunded_share'], { refunded_share: 'percent' }),
      },
      run: (rows) => ({
        columns: [{ name: 'refunded_share', format: 'percent' }],
        rows: [{ refunded_share: rows.length ? rows.filter((r) => r.payment_status === 'refunded').length / rows.length : null }],
      }),
    },
    {
      widget: {
        title: 'Average delivery time',
        width: 'quarter',
        sql: 'SELECT avg(delivery_days) AS delivery_days FROM data',
        chart: spec('kpi', null, ['delivery_days'], { delivery_days: 'number' }),
      },
      run: () => ({ error: 'Binder Error: column "delivery_days" not found' }),
    },
    {
      widget: {
        title: 'Revenue by product',
        width: 'half',
        sql: 'SELECT product, sum(total) AS revenue FROM data GROUP BY product ORDER BY revenue DESC',
        chart: spec('bar', 'product', ['revenue'], { revenue: 'zar' }, { orientation: 'horizontal' }),
      },
      run: (rows) => ({
        columns: [{ name: 'product', format: 'text' }, { name: 'revenue', format: 'zar' }],
        rows: [...groupBy(rows, 'product')].map(([product, group]) => ({ product, revenue: total(group, 'total') })).sort((a, b) => b.revenue - a.revenue),
      }),
    },
    {
      widget: {
        title: 'Orders by payment status',
        width: 'half',
        sql: 'SELECT payment_status, count(*) AS orders FROM data GROUP BY payment_status ORDER BY orders DESC',
        chart: spec('pie', 'payment_status', ['orders'], { orders: 'integer' }),
      },
      run: (rows) => ({
        columns: [{ name: 'payment_status', format: 'text' }, { name: 'orders', format: 'integer' }],
        rows: [...groupBy(rows, 'payment_status')].map(([payment_status, group]) => ({ payment_status, orders: group.length })).sort((a, b) => b.orders - a.orders),
      }),
    },
    {
      widget: {
        title: 'Revenue by day',
        width: 'full',
        sql: 'SELECT CAST(created_at AS DATE) AS day, sum(total) AS revenue FROM data GROUP BY day ORDER BY day',
        chart: spec('line', 'day', ['revenue'], { day: 'date', revenue: 'zar' }),
      },
      run: (rows) => ({
        columns: [{ name: 'day', format: 'date' }, { name: 'revenue', format: 'zar' }],
        rows: [...groupBy(rows, DAY_COLUMN)].sort(([a], [b]) => a.localeCompare(b)).map(([day, group]) => ({ day, revenue: total(group, 'total') })),
      }),
    },
    {
      widget: {
        title: 'Refunded orders',
        width: 'full',
        sql: "SELECT order_id, CAST(created_at AS DATE) AS day, product, total FROM data WHERE payment_status = 'refunded' ORDER BY total DESC",
        chart: spec('table', null, ['total'], { day: 'date', total: 'zar' }),
      },
      run: (rows) => ({
        columns: [{ name: 'order_id', format: 'text' }, { name: 'day', format: 'date' }, { name: 'product', format: 'text' }, { name: 'total', format: 'zar' }],
        rows: rows
          .filter((r) => r.payment_status === 'refunded')
          .sort((a, b) => num(b.total ?? null) - num(a.total ?? null))
          .map((r) => ({ order_id: r.order_id ?? null, day: r[DAY_COLUMN] ?? null, product: r.product ?? null, total: r.total ?? null })),
      }),
    },
  ];
}

/** The basic dashboard: a row count, rows by the first category, and the first rows. */
function fallbackWidgets(detail: DatasetDetail): WidgetDef[] {
  const category = categoryColumns(detail)[0];
  const shown = detail.columns.filter((c) => !c.is_pii).slice(0, 4);
  const defs: WidgetDef[] = [
    {
      widget: { title: 'Rows', width: 'quarter', sql: 'SELECT count(*) AS row_count FROM data', chart: spec('kpi', null, ['row_count'], { row_count: 'integer' }) },
      run: (rows) => ({ columns: [{ name: 'row_count', format: 'integer' }], rows: [{ row_count: rows.length }] }),
    },
  ];
  if (category) {
    const name = category.sql_name;
    defs.push({
      widget: {
        title: `Rows by ${(category.display_name ?? category.name).toLowerCase()}`,
        width: 'full',
        sql: `SELECT ${name}, count(*) AS row_count FROM data GROUP BY ${name} ORDER BY row_count DESC`,
        chart: spec('bar', name, ['row_count'], { row_count: 'integer' }),
      },
      run: (rows) => ({
        columns: [{ name, format: 'text' }, { name: 'row_count', format: 'integer' }],
        rows: [...groupBy(rows, name)].map(([value, group]) => ({ [name]: value || null, row_count: group.length })).sort((a, b) => b.row_count - a.row_count),
      }),
    });
  }
  defs.push({
    widget: {
      title: 'The first rows',
      width: 'full',
      sql: `SELECT ${shown.map((c) => c.sql_name).join(', ')} FROM data`,
      chart: spec('table', null, [], {}),
    },
    run: (rows) => ({
      columns: shown.map((c) => ({
        name: c.sql_name,
        format: c.semantic === 'currency_zar' ? 'zar' : c.data_type === 'integer' ? 'integer' : c.data_type === 'decimal' ? 'number' : c.data_type === 'date' || c.data_type === 'datetime' ? 'date' : 'text',
      })),
      rows: rows.map((r) => Object.fromEntries(shown.map((c) => [c.sql_name, r[c.sql_name] ?? null]))),
    }),
  });
  return defs;
}

function widgetDefs(detail: DatasetDetail, templateKey: string | null): WidgetDef[] {
  return templateKey === '02' ? webstoreWidgets() : fallbackWidgets(detail);
}

function filtersFor(detail: DatasetDetail, rows: Row[]): DashboardFilter[] {
  const filters: DashboardFilter[] = [];
  const date = dateColumn(detail);
  if (date) {
    const days = rows.map((r) => String(r[DAY_COLUMN])).sort();
    filters.push({ id: 'date', kind: 'date_range', column: date.sql_name, label: date.display_name ?? date.name, options: [], min: days[0] ?? null, max: days.at(-1) ?? null });
  }
  for (const c of categoryColumns(detail).slice(0, 2)) {
    const options = [...new Set(rows.map((r) => r[c.sql_name]).filter((v): v is string => typeof v === 'string' && v !== ''))].sort();
    filters.push({ id: `cat:${c.sql_name}`, kind: 'category', column: c.sql_name, label: c.display_name ?? c.name, options: options.slice(0, 50), min: null, max: null });
  }
  return filters;
}

function planned(detail: DatasetDetail, templateKey: string | null, rows: Row[], previous: Dashboard | null): Dashboard {
  const fallback = templateKey !== '02';
  const date = dateColumn(detail);
  return {
    id: previous?.id ?? crypto.randomUUID(),
    dataset_id: detail.id,
    status: 'ready',
    error_message: null,
    fallback,
    reading: {
      text:
        templateKey === '02'
          ? 'online orders, one row per order, with the order total in rand, the product, payment status and province'
          : `a table with one row per record${date ? `, dated by ${(date.display_name ?? date.name).toLowerCase()}` : ''}`,
      date_column: date?.sql_name ?? null,
    },
    filters: filtersFor(detail, rows),
    widgets: widgetDefs(detail, templateKey).map((d, i) => ({ ...d.widget, id: `${detail.id}-w${i + 1}`, position: i + 1 })),
    created_at: sastTimestamp(),
  };
}

const filterValue = z.strictObject({
  filter_id: z.string().min(1),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  values: z.array(z.string()).optional(),
});
const dataRequest = z.strictObject({ filters: z.array(filterValue) });
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function invalid(path: string, message: string): Result {
  return fail(422, 'validation_failed', 'Some fields are not valid.', { fields: [{ location: 'body', path, message }] });
}

/** Like the server: AND of every filter; a date range is inclusive and leaves out rows without a date. */
function applyFilters(rows: Row[], dashboard: Dashboard, filters: DashboardFilterValue[]): Row[] {
  return filters.reduce((kept, f) => {
    const filter = dashboard.filters.find((x) => x.id === f.filter_id)!;
    if (filter.kind === 'date_range') {
      return kept.filter((r) => {
        const day = r[DAY_COLUMN];
        if (typeof day !== 'string') return false;
        return (!f.from || day >= f.from) && (!f.to || day <= f.to);
      });
    }
    const values = new Set(f.values ?? []);
    return kept.filter((r) => values.has(String(r[filter.column] ?? '')));
  }, rows);
}

function checksFor(truncated: boolean): BlockCheck[] {
  return [
    { type: 'sql_read_only', ok: true, label: 'The query only reads your file' },
    truncated
      ? { type: 'result_not_truncated', ok: false, label: 'Only the first 50 result rows are shown', detail: 'The result has more rows than a widget shows.' }
      : { type: 'result_not_truncated', ok: true, label: 'Every result row is shown' },
  ];
}

export interface DashboardRouteInput {
  method: string;
  sub: '/dashboard' | '/dashboard/data';
  detail: DatasetDetail;
  templateKey: string | null;
  rows: Row[];
  state: MockDashboardState | undefined;
  setState: (state: MockDashboardState) => void;
  body: unknown;
}

export function routeDashboard({ method, sub, detail, templateKey, rows: fileRows, state, setState, body }: DashboardRouteInput): Result | null {
  // The webstore example's order times all fall on one day; spread them so the date filter and the line have days.
  const rows = withDays(detail, fileRows, templateKey === '02');

  if (sub === '/dashboard' && method === 'GET') {
    if (!state) return fail(404, 'not_found', 'No dashboard yet.');
    if (state.dashboard.status === 'planning') {
      state.polls += 1;
      if (state.polls >= MOCK_PLANNING_POLLS) {
        state.dashboard =
          state.outcome === 'ready'
            ? planned(detail, templateKey, rows, state.dashboard)
            : {
                ...state.dashboard,
                status: 'failed',
                error_message: 'Analyst could not find enough in this file to chart. Try asking a question instead.',
              };
      }
    }
    return ok(state.dashboard);
  }

  if (sub === '/dashboard' && method === 'POST') {
    if (detail.status === 'expired') return fail(410, 'dataset_expired', 'The source file was removed.');
    if (detail.status !== 'ready') return fail(409, 'dataset_not_ready', 'The dataset is not ready.');
    // Like the server: a dashboard already planning is returned unchanged.
    if (state?.dashboard.status === 'planning') return ok(state.dashboard, 202);
    if ((state?.plans_today ?? 0) >= MOCK_PLANS_PER_DAY) {
      return fail(429, 'rate_limited', 'A dashboard can be planned 5 times a day for each file. Try again tomorrow.');
    }
    const dashboard: Dashboard = {
      id: crypto.randomUUID(),
      dataset_id: detail.id,
      status: 'planning',
      error_message: null,
      fallback: false,
      reading: { text: '', date_column: null },
      filters: [],
      widgets: [],
      created_at: sastTimestamp(),
    };
    setState({ dashboard, outcome: templateKey === '04' ? 'failed' : 'ready', polls: 0, plans_today: (state?.plans_today ?? 0) + 1 });
    return ok(dashboard, 202);
  }

  if (sub === '/dashboard/data' && method === 'POST') {
    if (!state) return fail(404, 'not_found', 'No dashboard yet.');
    const dashboard = state.dashboard;
    if (dashboard.status !== 'ready') return fail(409, 'dashboard_not_ready', 'The dashboard is not ready.');
    const parsed = dataRequest.safeParse(body ?? {});
    if (!parsed.success) return invalid(parsed.error.issues[0]?.path.join('.') ?? 'filters', 'Not valid.');
    for (const [i, f] of parsed.data.filters.entries()) {
      const filter = dashboard.filters.find((x) => x.id === f.filter_id);
      if (!filter) return invalid(`filters.${i}.filter_id`, 'This filter is not on the dashboard.');
      if (filter.kind === 'date_range') {
        if (f.values) return invalid(`filters.${i}.values`, 'A date filter takes from and to.');
        if ((f.from && !isoDate.test(f.from)) || (f.to && !isoDate.test(f.to))) return invalid(`filters.${i}`, 'Use YYYY-MM-DD.');
        if (f.from && f.to && f.from > f.to) return invalid(`filters.${i}.from`, 'From must be on or before To.');
      } else if ((f.values?.length ?? 0) > MAX_ROWS) {
        return invalid(`filters.${i}.values`, 'At most 50 values.');
      }
    }
    const inScope = applyFilters(rows, dashboard, parsed.data.filters);
    const defs = widgetDefs(detail, templateKey);
    const widgets: WidgetResult[] = dashboard.widgets.map((w, i) => {
      const out = defs[i]?.run(inScope) ?? { error: 'Unknown widget.' };
      if ('error' in out) return { widget_id: w.id, columns: [], rows: [], total_rows: 0, truncated: false, checks: [], error: out.error };
      const truncated = out.rows.length > MAX_ROWS;
      return {
        widget_id: w.id,
        columns: out.columns,
        rows: out.rows.slice(0, MAX_ROWS),
        total_rows: out.rows.length,
        truncated,
        checks: checksFor(truncated),
        error: null,
      };
    });
    const data: DashboardData = { rows_total: rows.length, rows_in_scope: inScope.length, widgets };
    return ok(data);
  }

  return null;
}
