import { parse } from 'csv-parse/sync';
import type { PlannedWidget } from '../../llm/prompts/dashboard.js';
import type { BlockCheck, ColumnDataType, ColumnSemantic, ResultColumn } from '../../types/api.js';
import { MAX_PROMPT_COLUMNS, MAX_SAMPLE_ROWS, promptCell } from '../analysis/prompts.js';
import { maskValue } from '../parsing/pii.js';
import { type QueryResult, SandboxError, type SandboxSession } from '../sandbox/sandbox.js';

/**
 * The dashboard planner's input and the server's checks on each planned widget (LLM_PROMPTS section 5). The model sees
 * the schema, column statistics and at most 5 masked sample rows; it never sees a result row. Every widget is run here.
 */

export interface DashboardColumn {
  name: string;
  display_name: string | null;
  sql_name: string;
  data_type: ColumnDataType;
  semantic: ColumnSemantic;
  is_pii: boolean;
  null_count: number;
  distinct_count: number;
  min_value: string | null;
  max_value: string | null;
}

export const labelOf = (c: Pick<DashboardColumn, 'name' | 'display_name'>) => c.display_name ?? c.name;
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The first rows of the normalised CSV, for masking into the prompt. */
export function sampleRows(csv: Buffer): Array<Record<string, string>> {
  return parse(csv, { columns: true, to: MAX_SAMPLE_ROWS, relax_column_count: true }) as Array<Record<string, string>>;
}

/** The user message of LLM_PROMPTS section 5. PII values are masked and their min..max left out. */
export function buildDashboardUser(input: { datasetName: string; rowCount: number; columns: DashboardColumn[]; sampleRows: Array<Record<string, string>> }): string {
  const columns = input.columns.slice(0, MAX_PROMPT_COLUMNS);
  const lines = columns.map((c) => {
    const range = !c.is_pii && c.min_value !== null && c.max_value !== null ? `${promptCell(c.min_value)}..${promptCell(c.max_value)}` : '';
    return `${c.sql_name} | ${promptCell(labelOf(c))} | ${c.data_type} | ${c.semantic} | ${c.is_pii ? 'pii' : 'no'} | ${c.distinct_count} | ${c.null_count} | ${range}`;
  });
  const table = [columns.map((c) => c.sql_name).join(' | ')];
  for (const row of input.sampleRows.slice(0, MAX_SAMPLE_ROWS)) {
    table.push(columns.map((c) => promptCell(maskValue(row[c.sql_name] ?? '', c))).join(' | '));
  }
  return [
    `Dataset: ${promptCell(input.datasetName)} (${input.rowCount} rows)`,
    'Columns (sql_name | label | type | meaning | pii | distinct | empty | min..max):',
    ...lines,
    '<data>',
    ...table,
    '</data>',
  ].join('\n');
}

// ---------- the PII rule: personal-data columns only inside COUNT or COUNT(DISTINCT) ----------

type Node = Record<string, unknown>;

/** True when the parse tree uses a PII column (or *) anywhere outside count(...) or a plain IS [NOT] NULL test of it. */
export function usesPiiOutsideCount(tree: unknown, pii: Set<string>): boolean {
  if (pii.size === 0) return false;
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v === null || typeof v !== 'object') return false;
    const n = v as Node;
    if (n.class === 'FUNCTION' && String(n.function_name ?? '').toLowerCase() === 'count') return false;
    // W2b: a null check on the column itself only says whether a value is there (for example
    // count(*) FILTER (WHERE "email" IS NOT NULL)); any other use still counts.
    if (
      n.class === 'OPERATOR' &&
      (n.type === 'OPERATOR_IS_NULL' || n.type === 'OPERATOR_IS_NOT_NULL') &&
      Array.isArray(n.children) &&
      n.children.length === 1 &&
      (n.children[0] as Node)?.class === 'COLUMN_REF'
    ) {
      return false;
    }
    if (n.class === 'COLUMN_REF' && Array.isArray(n.column_names)) {
      if (pii.has(String(n.column_names.at(-1)).toLowerCase())) return true;
    }
    if (n.class === 'STAR') return true;
    return Object.values(n).some(walk);
  };
  return walk(tree);
}

// ---------- checks on one widget ----------

export type WidgetCheck =
  | { ok: true; result: QueryResult }
  | { ok: false; kind: 'sql'; error: string }
  | { ok: false; kind: 'check'; reason: 'params' | 'chart_columns' | 'missing_value_format' | 'kpi_shape' | 'empty' | 'pii' };

const NUMERIC_TYPE = /^(BIGINT|HUGEINT|UBIGINT|UHUGEINT|INTEGER|SMALLINT|TINYINT|UINTEGER|USMALLINT|UTINYINT|DECIMAL|DOUBLE|FLOAT|REAL)/;

/**
 * Runs and checks one planned widget in the sandbox (validation, read-only, resource limits, 10 s). A failure to parse
 * or run is kind 'sql' (repairable, with DuckDB's error text, which never holds row data); anything else is a check
 * failure and the widget is dropped.
 */
export async function checkWidget(session: SandboxSession, w: PlannedWidget, piiColumns: Set<string>): Promise<WidgetCheck> {
  // Bound parameters are the server's (filters); a widget must not have its own.
  if (/\$\d/.test(w.sql)) return { ok: false, kind: 'check', reason: 'params' };
  let result: QueryResult;
  try {
    result = await session.query(w.sql, { maxRows: 51 });
    if (usesPiiOutsideCount(await session.parseTree(w.sql), piiColumns)) return { ok: false, kind: 'check', reason: 'pii' };
  } catch (err) {
    if (err instanceof SandboxError) return { ok: false, kind: 'sql', error: err.message };
    throw err;
  }
  const names = new Set(result.columns.map((c) => c.name));
  const named = [w.chart.x, w.chart.series, ...w.chart.y].filter((x): x is string => x !== null);
  if (named.some((x) => !names.has(x))) return { ok: false, kind: 'check', reason: 'chart_columns' };
  if (result.columns.some((c) => !w.chart.value_format[c.name])) return { ok: false, kind: 'check', reason: 'missing_value_format' };
  if (result.rowCount === 0) return { ok: false, kind: 'check', reason: 'empty' };
  if (w.chart.type === 'kpi' && (result.rowCount !== 1 || result.columns.length !== 1 || !NUMERIC_TYPE.test(result.columns[0]!.type))) {
    return { ok: false, kind: 'check', reason: 'kpi_shape' };
  }
  return { ok: true, result };
}

/** A widget's result columns and checks, as returned to the client. */
export function widgetOutput(w: Pick<PlannedWidget, 'chart'>, result: QueryResult, cap: number): { columns: ResultColumn[]; checks: BlockCheck[]; truncated: boolean } {
  const truncated = result.rowCount > cap;
  return {
    columns: result.columns.map((c) => ({ name: c.name, format: w.chart.value_format[c.name] ?? 'text' })),
    truncated,
    checks: [
      { type: 'sql_read_only', ok: true, label: 'The query only reads your data' },
      truncated
        ? { type: 'result_not_truncated', ok: false, label: `Only the first ${cap} rows of the result are shown`, actual: result.rowCount }
        : { type: 'result_not_truncated', ok: true, label: 'The widget includes every row of the result' },
    ],
  };
}
