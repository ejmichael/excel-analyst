import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { DashboardData, DashboardFilter, DashboardWidget, ValidationFailedDetails, WidgetResult } from '../../types/api.js';
import { SandboxError, type SandboxSession } from '../sandbox/sandbox.js';
import { quoteIdent, widgetOutput } from './widgets.js';

/**
 * POST /datasets/:id/dashboard/data. Filters never call a model and never become SQL text: the widgets' SQL still
 * reads the table `data`, and for the request `data` is a filtered view of the whole table
 * (`WITH data AS (SELECT * FROM data WHERE ...)`). The WHERE uses column names from the dashboard's own filters,
 * quoted here, and the values only as bound parameters; dates are parsed and written back by the server.
 */

export const WIDGET_ROW_CAP = 50;
const MAX_VALUES = 50;

export const dashboardDataBody = z.strictObject({
  filters: z
    .array(
      z.strictObject({
        filter_id: z.string().min(1).max(200),
        from: z.string().max(20).nullable().optional(),
        to: z.string().max(20).nullable().optional(),
        values: z.array(z.string().max(500)).max(MAX_VALUES, `At most ${MAX_VALUES} values.`).optional(),
      }),
    )
    .max(20),
});
export type DashboardDataBody = z.infer<typeof dashboardDataBody>;

export type ResolvedFilter =
  | { kind: 'date_range'; column: string; from: string | null; to: string | null }
  | { kind: 'category'; column: string; values: string[] };

/** A real calendar date in YYYY-MM-DD, written back by the server (or null for a bad one). */
function isoDate(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d.toISOString().slice(0, 10);
}

/** The request's filter values checked against the dashboard's filters; every problem is a 422 field error. */
export function resolveFilters(dashboard: DashboardFilter[], body: DashboardDataBody): ResolvedFilter[] {
  const fields: ValidationFailedDetails['fields'] = [];
  const out: ResolvedFilter[] = [];
  const seen = new Set<string>();
  body.filters.forEach((f, i) => {
    const at = (key: string, message: string) => fields.push({ location: 'body', path: `filters.${i}${key ? `.${key}` : ''}`, message });
    const known = dashboard.find((d) => d.id === f.filter_id);
    if (!known) return at('filter_id', 'This filter is not part of this dashboard.');
    if (seen.has(f.filter_id)) return at('filter_id', 'This filter appears twice.');
    seen.add(f.filter_id);
    if (known.kind === 'date_range') {
      if (f.values !== undefined) return at('values', 'A date filter takes from and to, not a list of values.');
      const from = f.from ? isoDate(f.from) : null;
      const to = f.to ? isoDate(f.to) : null;
      if (f.from && !from) return at('from', 'Use a date as YYYY-MM-DD.');
      if (f.to && !to) return at('to', 'Use a date as YYYY-MM-DD.');
      if (from && to && from > to) return at('from', 'The start date is after the end date.');
      if (from || to) out.push({ kind: 'date_range', column: known.column, from, to });
      return;
    }
    if (f.from != null || f.to != null) return at('from', 'A category filter takes a list of values, not dates.');
    // An empty list means no restriction from this filter.
    if (f.values && f.values.length > 0) out.push({ kind: 'category', column: known.column, values: [...new Set(f.values)] });
  });
  if (fields.length > 0) throw new AppError('validation_failed', 'Some filters are not valid.', { fields } satisfies ValidationFailedDetails);
  return out;
}

/** The WHERE predicate and its parameters ($1, $2, ...). Column names come from the dashboard; values are only bound. */
export function scopePredicate(filters: ResolvedFilter[]): { where: string; params: string[] } {
  const params: string[] = [];
  const bind = (v: string) => {
    params.push(v);
    return `$${params.length}`;
  };
  const parts = filters.map((f) => {
    const col = quoteIdent(f.column);
    if (f.kind === 'date_range') {
      const day = `CAST(${col} AS DATE)`;
      const bounds = [`${col} IS NOT NULL`];
      if (f.from) bounds.push(`${day} >= CAST(${bind(f.from)} AS DATE)`);
      if (f.to) bounds.push(`${day} <= CAST(${bind(f.to)} AS DATE)`);
      return `(${bounds.join(' AND ')})`;
    }
    return `(CAST(${col} AS VARCHAR) IN (${f.values.map(bind).join(', ')}))`;
  });
  return { where: parts.join(' AND '), params };
}

/** The widget's SQL with `data` restricted to the scope (its own CTEs, if any, follow ours). */
export function scopedSql(sql: string, where: string): string {
  if (!where) return sql;
  const scope = `data AS (SELECT * FROM data WHERE ${where})`;
  if (/^\s*with\s+recursive\b/i.test(sql)) throw new SandboxError('rejected', 'Recursive queries cannot be filtered.');
  const lead = /^\s*with\b/i.exec(sql);
  return lead ? `WITH ${scope}, ${sql.slice(lead[0].length).trimStart()}` : `WITH ${scope} ${sql}`;
}

const WIDGET_TIMEOUT = 'This widget took longer than 10 seconds and was stopped.';
const WIDGET_FAILED = 'This widget could not be calculated.';

/** Every widget, one after the other in one sandbox (each with its own 10 s limit). A failing widget returns error. */
export async function runDashboardData(session: SandboxSession, widgets: DashboardWidget[], filters: ResolvedFilter[]): Promise<DashboardData> {
  const { where, params } = scopePredicate(filters);
  const count = async (sql: string, p: string[]) => Number((await session.query(sql, { maxRows: 1, params: p })).rows[0]?.n ?? 0);
  const rowsTotal = await count('SELECT count(*) AS n FROM data', []);
  const rowsInScope = where ? await count(scopedSql('SELECT count(*) AS n FROM data', where), params) : rowsTotal;
  const results: WidgetResult[] = [];
  for (const w of [...widgets].sort((a, b) => a.position - b.position)) {
    try {
      const result = await session.query(scopedSql(w.sql, where), { maxRows: WIDGET_ROW_CAP, params: where ? params : [] });
      const out = widgetOutput(w, result, WIDGET_ROW_CAP);
      results.push({ widget_id: w.id, columns: out.columns, rows: result.rows.slice(0, WIDGET_ROW_CAP), total_rows: result.rowCount, truncated: out.truncated, checks: out.checks, error: null });
    } catch (err) {
      if (!(err instanceof SandboxError)) throw err;
      results.push({ widget_id: w.id, columns: [], rows: [], total_rows: 0, truncated: false, checks: [], error: err.kind === 'timeout' ? WIDGET_TIMEOUT : WIDGET_FAILED });
    }
  }
  return { rows_total: rowsTotal, rows_in_scope: rowsInScope, widgets: results };
}
