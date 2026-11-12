import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { type FollowUp, type LlmClient, LlmError, type LlmUsage, type ToolCallRequest } from '../../llm/client.js';
import { narratorRetryMessage, narratorSystem, NARRATOR_MAX_TOKENS, narrativeSchema, WRITE_NARRATIVE_TOOL } from '../../llm/prompts/narrator.js';
import { PLAN_ANALYSIS_TOOL, type Plan, PLANNER_MAX_TOKENS, PLANNER_SYSTEM, planSchema, repairMessage } from '../../llm/prompts/planner.js';
import type { BlockCheck, BlockSource, CellValue, ChartSpec, ChartType, ResultColumn } from '../../types/api.js';
import { type QueryResult, SandboxError, type SandboxErrorCategory, type SandboxSession, withSandbox } from '../sandbox/sandbox.js';
import { buildNarratorUser, buildPlannerUser, MAX_SAMPLE_ROWS, type PromptColumn } from './prompts.js';
import { type ReconcileSkipReason, reconcileSkipReason } from './reconcileGuard.js';
import { renderNarrative, type RenderResult } from './tokens.js';

/**
 * The life of a question (ARCHITECTURE section 3): plan -> validate and run in the sandbox (one repair) -> reconcile ->
 * narrate with tokens (one retry) -> checks. Every number in the answer comes from a query result: the narrator writes
 * tokens and the server fills them in. Nothing here is saved; the route saves the returned draft.
 */

export const STORED_ROWS = 500;
export const RECONCILE_TOLERANCE = 0.005;

export type LlmPurpose = 'plan' | 'repair' | 'narrate';

export interface AskInput {
  ownerId: string;
  datasetId: string;
  datasetName: string;
  rowCount: number;
  columns: Array<PromptColumn & { data_type: PromptColumn['data_type'] }>;
  /** The normalised CSV. */
  csv: Buffer;
  question: string;
  chartHint?: ChartType;
  source: BlockSource;
}

export interface AskDeps {
  llm: LlmClient;
  /** One call per model call, successful or not (writes an `llm` usage event). Must not throw. */
  recordLlm: (purpose: LlmPurpose, usage: LlmUsage, meta: Record<string, string | number | boolean | null>) => Promise<void>;
  sandbox?: typeof withSandbox;
}

export interface BlockDraft {
  question: string;
  title: string;
  sql: string;
  source_filter_sql: string | null;
  columns: ResultColumn[];
  rows: Array<Record<string, CellValue>>;
  row_count: number;
  truncated: boolean;
  chart: ChartSpec;
  reconcile: { column: string; aggregation: 'sum' | 'count'; total_sql: string } | null;
  narrative_template: string;
  narrative: string;
  follow_ups: string[];
  checks: BlockCheck[];
  status: 'ok' | 'flagged';
  source: BlockSource;
  model: string;
}

/**
 * `reconcileSkipped`: why a planned reconcile was discarded (the block then has no total_reconciles check), as a fixed
 * category for usage_events meta; null when there was none to discard.
 */
export type AskResult =
  | { kind: 'answered'; block: BlockDraft; reconcileSkipped: ReconcileSkipReason | null }
  | { kind: 'cannot_answer'; message: string };

/** A model call failed (after the client's own retries): the route answers 502 llm_failed and saves nothing. */
export class AskLlmFailure extends Error {
  constructor(readonly purpose: LlmPurpose) {
    super(`model call failed: ${purpose}`);
    this.name = 'AskLlmFailure';
  }
}

export const CANNOT_ANSWER_DEFAULT = 'This question cannot be answered from the columns in this file.';
export const CANNOT_BUILD_QUERY = 'We could not work out how to answer this from your file. Try asking it a different way.';

/**
 * Why a plan needed a repair, as a fixed category that is safe to log (never SQL, values or error text). Stored in the
 * usage_events meta of the repair call so patterns can be counted later.
 */
export type RepairReason =
  | 'plan_schema_invalid'
  | 'plan_incomplete'
  | 'missing_value_format'
  | 'unknown_chart_column'
  | SandboxErrorCategory
  | `source_filter_${SandboxErrorCategory}`;

type PlanEvaluation =
  | { ok: true; plan: Plan & { title: string; sql: string; chart: ChartSpec }; result: QueryResult }
  | { ok: false; error: string; reason: RepairReason }
  | { cannot: string };

/** Runs the plan's SQL and the server-side checks from LLM_PROMPTS section 2. */
async function evaluatePlan(raw: unknown, session: SandboxSession): Promise<PlanEvaluation> {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || 'plan').slice(0, 5).join(', ');
    return { ok: false, error: `the plan_analysis output did not match the schema (${where})`, reason: 'plan_schema_invalid' };
  }
  const plan = parsed.data;
  if (!plan.can_answer) return { cannot: plan.reason_if_not?.trim() || CANNOT_ANSWER_DEFAULT };
  if (!plan.title?.trim() || !plan.sql?.trim() || !plan.chart) {
    return { ok: false, error: 'title, sql and chart are required when can_answer is true', reason: 'plan_incomplete' };
  }
  let result: QueryResult;
  try {
    result = await session.query(plan.sql);
  } catch (err) {
    if (err instanceof SandboxError) return { ok: false, error: err.message, reason: err.category };
    throw err;
  }
  // The source-rows filter is model-written SQL too: it must pass the sandbox now, not first fail when the user clicks.
  if (plan.source_filter_sql?.trim()) {
    try {
      await session.query(`SELECT count(*) AS n FROM data WHERE (${plan.source_filter_sql})`);
    } catch (err) {
      if (err instanceof SandboxError) return { ok: false, error: `source_filter_sql failed: ${err.message}`, reason: `source_filter_${err.category}` };
      throw err;
    }
  }
  const names = new Set(result.columns.map((c) => c.name));
  const missing: string[] = [];
  let reason: RepairReason = 'unknown_chart_column';
  const need = (field: string, col: string | null | undefined) => {
    if (col !== null && col !== undefined && !names.has(col)) missing.push(`${field} "${col}" is not a result column`);
  };
  need('chart.x', plan.chart.x);
  plan.chart.y.forEach((y, i) => need(`chart.y[${i}]`, y));
  need('chart.series', plan.chart.series);
  need('reconcile.column', plan.reconcile?.column);
  const chartProblems = missing.length;
  for (const c of result.columns) if (!plan.chart.value_format[c.name]) missing.push(`value_format has no entry for result column "${c.name}"`);
  if (chartProblems === 0 && missing.length > 0) reason = 'missing_value_format';
  if (missing.length > 0) return { ok: false, error: missing.join('; '), reason };
  return { ok: true, plan: plan as Plan & { title: string; sql: string; chart: ChartSpec }, result };
}

const humanise = (column: string) => column.replace(/_/g, ' ');

async function reconcileCheck(session: SandboxSession, sql: string, reconcile: NonNullable<Plan['reconcile']>): Promise<BlockCheck> {
  const label = `Total of ${humanise(reconcile.column)} matches your file`;
  try {
    const expected = await session.scalar(reconcile.total_sql);
    // Sum of the breakdown column for both aggregations: per-group counts add up to the total count.
    const actual = await session.sumOf(sql, reconcile.column);
    if (expected === null || actual === null) {
      return { type: 'total_reconciles', ok: false, label: `We could not check the total of ${humanise(reconcile.column)}`, detail: 'One of the totals was empty.' };
    }
    const ok = Math.abs(expected - actual) < RECONCILE_TOLERANCE;
    return {
      type: 'total_reconciles',
      ok,
      label: ok ? label : `Total of ${humanise(reconcile.column)} does not match your file`,
      // Stored without floating-point noise (287418.5299999999 -> 287418.53); the comparison above uses the raw values.
      expected: Math.round(expected * 1e6) / 1e6,
      actual: Math.round(actual * 1e6) / 1e6,
    };
  } catch (err) {
    // A failing check query is a visible failed check, never skipped.
    return {
      type: 'total_reconciles',
      ok: false,
      label: `We could not check the total of ${humanise(reconcile.column)}`,
      detail: err instanceof SandboxError ? 'The check query did not run.' : 'The check could not be completed.',
    };
  }
}

function sampleRowsOf(csv: Buffer): Array<Record<string, string>> {
  return parse(csv, { columns: true, to: MAX_SAMPLE_ROWS, relax_column_count: true }) as Array<Record<string, string>>;
}

export async function ask(input: AskInput, deps: AskDeps): Promise<AskResult> {
  const sandbox = deps.sandbox ?? withSandbox;
  const started = Date.now();

  async function callModel<T>(purpose: LlmPurpose, req: ToolCallRequest<T>, meta: Record<string, string | number | boolean | null> = {}): Promise<T> {
    const t = Date.now();
    try {
      const result = await deps.llm.callTool(req);
      await deps.recordLlm(purpose, result.usage, { dataset_id: input.datasetId, ms: Date.now() - t, ...meta });
      return result.output;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      const usage = err.usage ?? { model: deps.llm.modelFor(req.role), inputTokens: null, outputTokens: null, costUsd: null };
      await deps.recordLlm(purpose, usage, { dataset_id: input.datasetId, ms: Date.now() - t, error: err.kind, ...meta });
      throw new AskLlmFailure(purpose);
    }
  }

  // ----- plan -----
  const plannerUser = buildPlannerUser({
    question: input.question,
    chartHint: input.chartHint,
    datasetName: input.datasetName,
    rowCount: input.rowCount,
    columns: input.columns,
    sampleRows: sampleRowsOf(input.csv),
  });
  const plannerReq = {
    role: 'planner' as const,
    system: PLANNER_SYSTEM,
    user: plannerUser,
    tool: PLAN_ANALYSIS_TOOL,
    // Validated below with planSchema, so a bad plan can be repaired instead of failing the call.
    schema: z.unknown(),
    maxTokens: PLANNER_MAX_TOKENS,
  };
  let raw = await callModel('plan', plannerReq);

  // ----- run, repair once, reconcile (inside one sandbox) -----
  const evaluated = await sandbox({ csv: input.csv, columns: input.columns }, async (session) => {
    let evaluation = await evaluatePlan(raw, session);
    if ('ok' in evaluation && !evaluation.ok) {
      const followUps: FollowUp[] = [
        { role: 'assistant', content: JSON.stringify(raw) },
        { role: 'user', content: repairMessage(evaluation.error) },
      ];
      raw = await callModel('repair', { ...plannerReq, followUps }, { reason: evaluation.reason });
      evaluation = await evaluatePlan(raw, session);
      if ('ok' in evaluation && !evaluation.ok) return { cannot: CANNOT_BUILD_QUERY };
    }
    if ('cannot' in evaluation) return evaluation;
    if (!evaluation.ok) return { cannot: CANNOT_BUILD_QUERY };
    const planned = evaluation.plan.reconcile;
    if (!planned) return { ...evaluation, reconcile: null, reconcileSkipped: null };
    // A reconcile over a column that cannot be added up across groups would be a false alarm: discard it, run no check.
    const skipped = reconcileSkipReason({
      tree: await session.parseTree(evaluation.plan.sql),
      column: planned.column,
      valueFormat: evaluation.plan.chart.value_format,
      rowCount: evaluation.result.rowCount,
    });
    if (skipped) return { ...evaluation, plan: { ...evaluation.plan, reconcile: null }, reconcile: null, reconcileSkipped: skipped };
    return { ...evaluation, reconcile: await reconcileCheck(session, evaluation.plan.sql, planned), reconcileSkipped: null };
  });
  if ('cannot' in evaluated) return { kind: 'cannot_answer', message: evaluated.cannot };
  const { plan, result, reconcile, reconcileSkipped } = evaluated;

  // ----- narrate (one retry) -----
  const truncated = result.rowCount > STORED_ROWS;
  const rows = result.rows.slice(0, STORED_ROWS);
  const columns: ResultColumn[] = result.columns.map((c) => ({ name: c.name, format: plan.chart.value_format[c.name]! }));
  const narratorReq = {
    role: 'fast' as const,
    system: narratorSystem(truncated),
    user: buildNarratorUser({
      question: input.question,
      title: plan.title,
      instructions: plan.narrative_instructions ?? '',
      columns,
      rows,
      rowCount: result.rowCount,
      truncated,
      datasetColumns: input.columns,
    }),
    tool: WRITE_NARRATIVE_TOOL,
    schema: narrativeSchema,
    maxTokens: NARRATOR_MAX_TOKENS,
  };
  const render = (template: string): RenderResult =>
    renderNarrative({ template, rows: rows.slice(0, 50), rowCount: result.rowCount, valueFormat: plan.chart.value_format });

  let narrative = await callModel('narrate', narratorReq);
  let rendered = render(narrative.narrative_template);
  if (!rendered.ok) {
    const retry = await callModel(
      'narrate',
      {
        ...narratorReq,
        followUps: [
          { role: 'assistant', content: JSON.stringify(narrative) },
          { role: 'user', content: narratorRetryMessage(rendered.problems) },
        ],
      },
      // Categories only (for example free_standing_number); never the text or values.
      { retry: true, reasons: [...new Set(rendered.categories)].join(',') },
    );
    const retried = render(retry.narrative_template);
    // Keep the better attempt: the retry unless it is worse.
    if (retried.ok || retried.problems.length <= rendered.problems.length) {
      narrative = retry;
      rendered = retried;
    }
  }

  // ----- checks -----
  const checks: BlockCheck[] = [
    { type: 'sql_read_only', ok: true, label: 'The query only reads your data' },
    rendered.ok
      ? { type: 'numbers_from_data', ok: true, label: 'Every number in the explanation comes from the query result' }
      : {
          type: 'numbers_from_data',
          ok: false,
          label: 'Some numbers in the explanation could not be checked against your data',
          detail: rendered.problems.slice(0, 5).join('; '),
        },
    truncated
      ? { type: 'result_not_truncated', ok: false, label: 'Only the first 500 rows of the result are shown', actual: result.rowCount }
      : { type: 'result_not_truncated', ok: true, label: 'The answer includes every row of the result' },
  ];
  if (reconcile) checks.push(reconcile);

  logger.info({ dataset_id: input.datasetId, ms: Date.now() - started, rows: result.rowCount, flagged: checks.some((c) => !c.ok) }, 'question answered');

  return {
    kind: 'answered',
    reconcileSkipped,
    block: {
      question: input.question,
      title: plan.title.trim(),
      sql: plan.sql.trim(),
      source_filter_sql: plan.source_filter_sql?.trim() || null,
      columns,
      rows,
      row_count: result.rowCount,
      truncated,
      chart: plan.chart,
      reconcile: plan.reconcile ?? null,
      narrative_template: narrative.narrative_template,
      narrative: rendered.text,
      follow_ups: narrative.follow_ups,
      checks,
      status: checks.every((c) => c.ok) ? 'ok' : 'flagged',
      source: input.source,
      model: deps.llm.modelFor('planner'),
    },
  };
}
