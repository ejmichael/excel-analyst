import { randomUUID } from 'node:crypto';
import { type FollowUp, type LlmClient, LlmError, type LlmUsage } from '../../llm/client.js';
import {
  DASHBOARD_MAX_TOKENS,
  DASHBOARD_SYSTEM,
  dashboardPlanSchema,
  dashboardRepairMessage,
  dashboardWidgetSchema,
  PLAN_DASHBOARD_TOOL,
  type PlannedWidget,
} from '../../llm/prompts/dashboard.js';
import type { DashboardFilter, DashboardWidget } from '../../types/api.js';
import { overlappingPieAsBar } from '../analysis/chartSafety.js';
import { type QueryResult, type SandboxSession, withSandbox } from '../sandbox/sandbox.js';
import type { DashboardPlan } from './storage.js';
import { buildDashboardUser, checkWidget, type DashboardColumn, labelOf, quoteIdent, sampleRows } from './widgets.js';

/**
 * Plans a dataset's dashboard (Part W2): one planner-model call (plus at most one shared repair call), every widget
 * validated and run by the server, invalid filters dropped; when fewer than MIN_WIDGETS survive or the model fails,
 * a dashboard built in code without the model. No result row is ever sent to the model. Nothing here is logged except
 * through recordLlm (ids, tokens, timings, fixed categories).
 */

export const MIN_WIDGETS = 4;
export const MIN_FALLBACK_WIDGETS = 2;
export const FAILED_MESSAGE = 'We could not build a dashboard for this file. Try asking your own questions instead.';
const NOT_FILTERABLE = new Set(['identifier', 'free_text', 'email', 'phone', 'sa_id_number', 'person_name', 'address']);

export type DashboardPurpose = 'dashboard_plan' | 'dashboard_repair';

export interface PlanInput {
  datasetName: string;
  rowCount: number;
  columns: DashboardColumn[];
  csv: Buffer;
}

export interface PlanDeps {
  llm: LlmClient;
  /** One call per model call, successful or not (an llm usage event). Must not throw. */
  recordLlm: (purpose: DashboardPurpose, usage: LlmUsage, meta: Record<string, string | number | boolean | null>) => Promise<void>;
  sandbox?: typeof withSandbox;
}

/** One planned widget and what happened to it (model text: kept out of logs; used by tests and the real-model report). */
export interface WidgetTrace {
  title: string;
  type: string;
  width: string;
  sql: string;
  outcome: 'kept' | 'repaired' | string;
  error?: string;
}

export interface PlanOutcome {
  status: 'ready' | 'failed';
  fallback: boolean;
  error_message: string | null;
  plan: DashboardPlan;
  /** Fixed categories only, for logs and the real-model report. */
  report: { planned: number; kept: number; repaired: number; dropped: Record<string, number>; modelFailed: boolean; trace: WidgetTrace[] };
}

// ---------- filters ----------

const isDate = (c: DashboardColumn) => c.data_type === 'date' || c.data_type === 'datetime';
const filterable = (c: DashboardColumn) => !c.is_pii && !NOT_FILTERABLE.has(c.semantic) && !isDate(c);

/** The filter bar from the chosen columns, checked against the file; invalid choices are dropped silently. */
export async function buildFilters(session: SandboxSession, columns: DashboardColumn[], dateColumn: string | null, filterColumns: string[]): Promise<DashboardFilter[]> {
  const filters: DashboardFilter[] = [];
  const date = dateColumn ? columns.find((c) => c.sql_name === dateColumn && isDate(c)) : undefined;
  if (date) {
    const col = `CAST(${quoteIdent(date.sql_name)} AS DATE)`;
    const r = (await session.query(`SELECT CAST(min(${col}) AS VARCHAR) AS lo, CAST(max(${col}) AS VARCHAR) AS hi FROM data`, { maxRows: 1 })).rows[0];
    if (r?.lo && r.hi) filters.push({ id: 'date', kind: 'date_range', column: date.sql_name, label: labelOf(date), options: [], min: String(r.lo), max: String(r.hi) });
  }
  const seen = new Set<string>();
  for (const name of filterColumns) {
    const c = columns.find((x) => x.sql_name === name);
    if (!c || seen.has(name) || !filterable(c)) continue;
    seen.add(name);
    const col = quoteIdent(c.sql_name);
    const values = (await session.query(`SELECT DISTINCT CAST(${col} AS VARCHAR) AS v FROM data WHERE ${col} IS NOT NULL ORDER BY v LIMIT 51`, { maxRows: 51 })).rows.map((r) =>
      String(r.v),
    );
    if (values.length < 2 || values.length > 50) continue;
    filters.push({ id: `cat:${c.sql_name}`, kind: 'category', column: c.sql_name, label: labelOf(c), options: values, min: null, max: null });
  }
  return filters.slice(0, 6);
}

// ---------- the fallback dashboard (no model) ----------

const kpi = (title: string, sql: string, alias: string, format: 'integer' | 'zar' | 'number'): PlannedWidget => ({
  title,
  sql,
  width: 'quarter',
  chart: { type: 'kpi', x: null, y: [alias], series: null, orientation: 'vertical', stacked: false, value_format: { [alias]: format } },
});

/** Candidate widgets built from the column list (quoted identifiers from that list; nothing from the model). */
export function fallbackWidgets(columns: DashboardColumn[]): { widgets: PlannedWidget[]; categories: string[]; dateColumn: string | null } {
  const widgets: PlannedWidget[] = [kpi('Number of records', 'SELECT count(*) AS "records" FROM data', 'records', 'integer')];
  const id = columns.find((c) => c.semantic === 'identifier');
  if (id) widgets.push(kpi(`Distinct ${labelOf(id)}`.slice(0, 60), `SELECT count(DISTINCT ${quoteIdent(id.sql_name)}) AS "distinct_values" FROM data`, 'distinct_values', 'integer'));
  const amounts = columns.filter((c) => !c.is_pii && (c.semantic === 'currency_zar' || c.data_type === 'decimal')).slice(0, 2);
  for (const c of amounts) {
    widgets.push(kpi(`Total ${labelOf(c)}`.slice(0, 60), `SELECT round(sum(${quoteIdent(c.sql_name)}), 2) AS "total" FROM data`, 'total', c.semantic === 'currency_zar' ? 'zar' : 'number'));
  }
  const categories = columns.filter((c) => filterable(c) && c.data_type === 'text' && c.distinct_count >= 2 && c.distinct_count <= 50).slice(0, 3);
  for (const c of categories) {
    const col = quoteIdent(c.sql_name);
    widgets.push({
      title: `Records by ${labelOf(c)}`.slice(0, 60),
      sql: `SELECT ${col} AS "value", count(*) AS "records" FROM data WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
      width: 'half',
      chart: { type: 'bar', x: 'value', y: ['records'], series: null, orientation: 'horizontal', stacked: false, value_format: { value: 'text', records: 'integer' } },
    });
  }
  const date = columns.find(isDate);
  if (date) {
    const col = quoteIdent(date.sql_name);
    widgets.push({
      title: `Records per month by ${labelOf(date)}`.slice(0, 60),
      sql: `SELECT CAST(date_trunc('month', ${col}) AS DATE) AS "month", count(*) AS "records" FROM data WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY 1`,
      width: 'full',
      chart: { type: 'line', x: 'month', y: ['records'], series: null, orientation: 'vertical', stacked: false, value_format: { month: 'date', records: 'integer' } },
    });
  }
  return { widgets, categories: categories.map((c) => c.sql_name), dateColumn: date?.sql_name ?? null };
}

function fallbackReading(columns: DashboardColumn[], categories: string[], dateColumn: string | null): string {
  const names = categories.map((n) => labelOf(columns.find((c) => c.sql_name === n)!));
  const by = names.length > 0 ? ` and breaks them down by ${names.join(', ')}` : '';
  const time = dateColumn ? ' and by month' : '';
  return `Built from the file's columns without the model: it counts the records${by}${time}.`.slice(0, 300);
}

// ---------- planning ----------

const toWidget = (w: PlannedWidget, position: number): DashboardWidget => ({ id: randomUUID(), position, title: w.title, width: w.width, sql: w.sql, chart: w.chart });

export async function planDashboard(input: PlanInput, deps: PlanDeps): Promise<PlanOutcome> {
  const sandbox = deps.sandbox ?? withSandbox;
  // Columns empty in every row are not planned from: not in the prompt, the fallback or the filters. (The sandbox still
  // loads every column.)
  const columns = input.columns.filter((c) => c.distinct_count > 0);
  const safeChart = (w: PlannedWidget, rows: QueryResult['rows']): PlannedWidget => ({ ...w, chart: overlappingPieAsBar(w.chart, rows, input.rowCount) });
  const pii = new Set(input.columns.filter((c) => c.is_pii).map((c) => c.sql_name.toLowerCase()));
  const report: PlanOutcome['report'] = { planned: 0, kept: 0, repaired: 0, dropped: {}, modelFailed: false, trace: [] };
  const drop = (reason: string) => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + 1;
  };

  const request = {
    role: 'planner' as const,
    system: DASHBOARD_SYSTEM,
    user: buildDashboardUser({ datasetName: input.datasetName, rowCount: input.rowCount, columns, sampleRows: sampleRows(input.csv) }),
    tool: PLAN_DASHBOARD_TOOL,
    schema: dashboardPlanSchema,
    maxTokens: DASHBOARD_MAX_TOKENS,
    temperature: 0, // sent only to models that accept it (config/models.ts)
  };
  async function callModel(purpose: DashboardPurpose, req: typeof request & { followUps?: FollowUp[] }, meta: Record<string, string | number | boolean | null> = {}) {
    const t = Date.now();
    try {
      const result = await deps.llm.callTool(req);
      await deps.recordLlm(purpose, result.usage, { ms: Date.now() - t, ...meta });
      return result.output;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      const usage = err.usage ?? { model: deps.llm.modelFor('planner'), inputTokens: null, outputTokens: null, costUsd: null };
      await deps.recordLlm(purpose, usage, { ms: Date.now() - t, error: err.kind, ...meta });
      return null;
    }
  }

  return sandbox({ csv: input.csv, columns: input.columns }, async (session) => {
    const plan = await callModel('dashboard_plan', request);
    let kept: PlannedWidget[] = [];
    let filters: DashboardFilter[] = [];
    let reading = '';

    if (plan) {
      report.planned = plan.widgets.length;
      reading = plan.reading.trim();
      // Each widget on its own: a malformed one is dropped, the others are checked.
      const slots: Array<{ w: PlannedWidget; ok: boolean; sqlError?: string; trace: WidgetTrace }> = [];
      for (const raw of plan.widgets) {
        const parsed = dashboardWidgetSchema.safeParse(raw);
        if (!parsed.success) {
          drop('malformed');
          report.trace.push({ title: String((raw as { title?: unknown })?.title ?? ''), type: '?', width: '?', sql: '', outcome: 'malformed' });
          continue;
        }
        const trace: WidgetTrace = { title: parsed.data.title, type: parsed.data.chart.type, width: parsed.data.width, sql: parsed.data.sql, outcome: 'kept' };
        report.trace.push(trace);
        const check = await checkWidget(session, parsed.data, pii);
        if (check.ok) slots.push({ w: safeChart(parsed.data, check.result.rows), ok: true, trace });
        else if (check.kind === 'sql') {
          trace.error = check.error;
          slots.push({ w: parsed.data, ok: false, sqlError: check.error, trace });
        } else {
          trace.outcome = check.reason;
          drop(check.reason);
        }
      }

      // One shared repair call for the widgets whose SQL did not parse or run.
      const failing = slots.map((s, i) => ({ s, i })).filter(({ s }) => !s.ok);
      if (failing.length > 0) {
        const repairMessage = dashboardRepairMessage(failing.map(({ s, i }) => ({ n: i + 1, title: s.w.title, sql: s.w.sql, error: s.sqlError! })));
        const followUps: FollowUp[] = [
          { role: 'assistant', content: JSON.stringify({ ...plan, widgets: slots.map((s) => s.w) }) },
          { role: 'user', content: repairMessage },
        ];
        const repaired = await callModel('dashboard_repair', { ...request, followUps }, { failing: failing.length });
        for (const { s, i } of failing) {
          const candidate = repaired ? dashboardWidgetSchema.safeParse(repaired.widgets[i]) : null;
          if (candidate?.success) {
            const check = await checkWidget(session, candidate.data, pii);
            if (check.ok) {
              s.trace.outcome = 'repaired';
              slots[i] = { w: safeChart(candidate.data, check.result.rows), ok: true, trace: s.trace };
              report.repaired++;
              continue;
            }
          }
          drop('sql_failed');
          s.trace.outcome = 'sql_failed';
          s.ok = false;
        }
      }
      kept = slots.filter((s) => s.ok).map((s) => s.w);
      filters = await buildFilters(session, columns, plan.date_column, plan.filter_columns);
    } else {
      report.modelFailed = true;
    }
    report.kept = kept.length;

    if (plan && kept.length >= MIN_WIDGETS) {
      const date = filters.find((f) => f.kind === 'date_range')?.column ?? null;
      return {
        status: 'ready' as const,
        fallback: false,
        error_message: null,
        // The date column only counts once it passed the filter checks (a date or datetime column with dates in it).
        plan: { reading: { text: reading, date_column: date }, filters, widgets: kept.map(toWidget) },
        report,
      };
    }

    // ----- the fallback, in code -----
    const built = fallbackWidgets(columns);
    const usable: PlannedWidget[] = [];
    for (const w of built.widgets) if ((await checkWidget(session, w, pii)).ok) usable.push(w);
    if (usable.length < MIN_FALLBACK_WIDGETS) {
      return { status: 'failed' as const, fallback: true, error_message: FAILED_MESSAGE, plan: { reading: { text: '', date_column: null }, filters: [], widgets: [] }, report };
    }
    const fbFilters = await buildFilters(session, columns, built.dateColumn, built.categories);
    const date = fbFilters.find((f) => f.kind === 'date_range')?.column ?? null;
    return {
      status: 'ready' as const,
      fallback: true,
      error_message: null,
      plan: { reading: { text: fallbackReading(columns, built.categories, date), date_column: date }, filters: fbFilters, widgets: usable.map(toWidget) },
      report,
    };
  });
}
