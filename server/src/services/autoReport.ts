import { z } from 'zod';
import { AppError, throwIfDbError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getObject } from '../lib/storage.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { llm } from '../llm/client.js';
import type { AutoReportConflictDetails, AutoReportRun } from '../types/api.js';
import { ask, type AskDeps, AskLlmFailure, type AskInput } from './analysis/ask.js';
import { saveAnsweredBlock } from './blocks.js';
import { type ColumnRow, type DatasetRow, getColumns } from './datasets.js';
import { assertWithinLimit } from './limits.js';
import { INTERRUPTED_MESSAGE } from './profiling.js';
import { createReport, REPORT_LIMITS } from './reports.js';
import { recordLlmUsage, recordUsage } from './usageEvents.js';

/**
 * "Build my report" (slice S3b, API_CONTRACT Flow B2): asks a ready dataset's stored suggestions, in order, through the
 * same ask pipeline as POST /datasets/:id/ask (at most 2 at a time), then makes one report from the answers.
 * In-process, like profiling: state lives in auto_report_runs, the client polls GET /auto-reports/:id, and runs left
 * `running` by a restart are failed on boot. Logs ids, counts and timings only: never questions, SQL, rows or narratives.
 */

export const MIN_SUGGESTIONS = 3;
export const MIN_ANSWERED = 3;
export const AUTO_REPORT_CONCURRENCY = 2;

export const NOT_ENOUGH_SUGGESTIONS = `This file needs at least ${MIN_SUGGESTIONS} suggested questions to build a report. Ask your own questions and pin the answers instead.`;
export const ALREADY_RUNNING = 'A report is already being built for this file. Please wait for it to finish.';
/** 409 conflict naming the running run, so the client can poll it (AutoReportConflictDetails). */
export const alreadyRunning = (runId: string) => new AppError('conflict', ALREADY_RUNNING, { auto_report_id: runId } satisfies AutoReportConflictDetails);
export const FILE_DELETED = 'The file was deleted.';
export const FILE_UNAVAILABLE = 'The source file is no longer available.';
export const REPORT_LIMIT_REACHED =
  'Your plan’s monthly report limit was reached, so the report was not created. The answers are saved with this file.';
export const BUILD_FAILED = 'We could not build the report. The answers are saved with this file; please try again.';
export const tooFewAnswered = (answered: number, total: number) =>
  `We could only answer ${answered} of the ${total} questions for this file. Try asking your own questions.`;

export const autoReportBody = z.strictObject({
  title: z.string().trim().min(1, 'Give the report a title.').max(REPORT_LIMITS.title, `At most ${REPORT_LIMITS.title} characters.`).optional(),
  period_label: z
    .string()
    .trim()
    .max(REPORT_LIMITS.period_label, `At most ${REPORT_LIMITS.period_label} characters.`)
    .transform((s) => (s === '' ? null : s))
    .optional(),
});
export type AutoReportBody = z.infer<typeof autoReportBody>;

export interface AutoReportRow {
  id: string;
  owner_id: string;
  dataset_id: string | null;
  status: AutoReportRun['status'];
  blocks_done: number;
  blocks_total: number;
  report_id: string | null;
  error_message: string | null;
  title: string | null;
  period_label: string | null;
  created_at: string;
  finished_at: string | null;
}

export const RUN_COLUMNS = 'id, owner_id, dataset_id, status, blocks_done, blocks_total, report_id, error_message, title, period_label, created_at, finished_at';

export function toAutoReportRun(r: AutoReportRow): AutoReportRun {
  return {
    id: r.id,
    dataset_id: r.dataset_id,
    status: r.status,
    blocks_done: r.blocks_done,
    blocks_total: r.blocks_total,
    report_id: r.report_id,
    error_message: r.error_message,
    created_at: r.created_at,
  };
}

/** Inserts a `running` run; a second running run for the same dataset (a race past the route's check) is 409. */
export async function insertRun(ownerId: string, dataset: DatasetRow, body: AutoReportBody): Promise<AutoReportRow> {
  const { data, error } = await supabaseAdmin()
    .from('auto_report_runs')
    .insert({
      owner_id: ownerId,
      dataset_id: dataset.id,
      blocks_total: dataset.suggestions.length,
      title: body.title ?? null,
      period_label: body.period_label ?? null,
    })
    .select(RUN_COLUMNS)
    .single<AutoReportRow>();
  if (error?.code === '23505') {
    // Another request started a run for this dataset between the route's check and this insert.
    const { data: other } = await supabaseAdmin().from('auto_report_runs').select('id').eq('owner_id', ownerId).eq('dataset_id', dataset.id).eq('status', 'running').maybeSingle<{ id: string }>();
    throw other ? alreadyRunning(other.id) : new AppError('conflict', ALREADY_RUNNING);
  }
  throwIfDbError('auto-report: insert', error);
  return data!;
}

// ---------- the background job ----------

const active = new Set<Promise<void>>();
const idleWaiters: Array<() => void> = [];

/** Resolves when no auto-report job is running (tests and graceful shutdown). */
export function autoReportsIdle(): Promise<void> {
  if (active.size === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/** Starts the job without waiting for it. It never throws: every failure ends the run `failed`. */
export function startAutoReport(run: AutoReportRow, dataset: DatasetRow): void {
  const job = runAutoReport(run, dataset).finally(() => {
    active.delete(job);
    if (active.size === 0) idleWaiters.splice(0).forEach((r) => r());
  });
  active.add(job);
}

/** Thrown inside the job to end the run with a user-safe message. */
class RunFailure extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

async function datasetExists(ownerId: string, datasetId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().from('datasets').select('id').eq('id', datasetId).eq('owner_id', ownerId).maybeSingle();
  throwIfDbError('auto-report: dataset', error);
  return data !== null;
}

/** Writes only while the run is still `running`, so a run swept or finished elsewhere is never overwritten. */
async function updateRun(run: AutoReportRow, patch: Partial<AutoReportRow>): Promise<void> {
  const { error } = await supabaseAdmin().from('auto_report_runs').update(patch).eq('id', run.id).eq('owner_id', run.owner_id).eq('status', 'running');
  throwIfDbError('auto-report: update', error);
}

async function runAutoReport(run: AutoReportRow, dataset: DatasetRow): Promise<void> {
  const started = Date.now();
  const ownerId = run.owner_id;
  const suggestions = dataset.suggestions;
  let answered = 0;
  let skipped = 0;
  let flagged = 0;
  try {
    const csv = dataset.normalised_path ? await getObject(dataset.normalised_path) : null;
    if (!csv) throw new RunFailure(FILE_UNAVAILABLE);
    const columns: ColumnRow[] = await getColumns(supabaseAdmin(), dataset.id);
    const deps: AskDeps = { llm: llm(), recordLlm: (purpose, usage, meta) => recordLlmUsage(ownerId, purpose, usage, meta) };

    // Block ids by suggestion index, so the report keeps the suggestions' order whatever finishes first.
    const blockIds: Array<string | null> = suggestions.map(() => null);
    let done = 0;
    let deleted = false;
    // Progress writes are chained so two workers can never write blocks_done out of order.
    let progress: Promise<void> = Promise.resolve();
    let next = 0;

    const askOne = async (index: number): Promise<void> => {
      const input: AskInput = {
        ownerId,
        datasetId: dataset.id,
        datasetName: dataset.name,
        rowCount: dataset.row_count ?? 0,
        columns,
        csv,
        question: suggestions[index]!.question,
        source: 'suggested',
      };
      try {
        const outcome = await ask(input, deps);
        if (outcome.kind === 'answered') {
          const row = await saveAnsweredBlock(ownerId, dataset.id, outcome.block, outcome.reconcileSkipped);
          blockIds[index] = row.id;
          answered++;
          if (row.status === 'flagged') flagged++;
        } else {
          skipped++;
        }
      } catch (err) {
        // A failed model call is skipped like cannot_answer. So is anything else that stops one question (a busy
        // sandbox, a save that failed because the file was deleted meanwhile, which is caught below).
        skipped++;
        const reason = err instanceof AskLlmFailure ? 'llm_failed' : err instanceof AppError ? err.code : err instanceof Error ? err.name : 'unknown';
        logger.warn({ run_id: run.id, index, reason }, 'auto-report question skipped');
      }
      done++;
      const value = done;
      progress = progress.then(() => updateRun(run, { blocks_done: value }));
    };

    const worker = async (): Promise<void> => {
      while (!deleted && next < suggestions.length) {
        const index = next++;
        if (!(await datasetExists(ownerId, dataset.id))) {
          deleted = true;
          return;
        }
        await askOne(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AUTO_REPORT_CONCURRENCY, suggestions.length) }, worker));
    await progress;

    if (deleted || !(await datasetExists(ownerId, dataset.id))) throw new RunFailure(FILE_DELETED);
    if (answered < MIN_ANSWERED) throw new RunFailure(tooFewAnswered(answered, suggestions.length));

    try {
      await assertWithinLimit(ownerId, 'max_reports_per_month');
    } catch (err) {
      if (err instanceof AppError && err.code === 'plan_limit') throw new RunFailure(REPORT_LIMIT_REACHED);
      throw err;
    }
    const ids = blockIds.filter((id): id is string => id !== null);
    const reportId = await createReport(ownerId, {
      workspace_id: dataset.workspace_id,
      title: run.title ?? dataset.name.slice(0, REPORT_LIMITS.title),
      subtitle: null,
      period_label: run.period_label,
      block_ids: ids,
    });
    // Counted only once the report and its blocks are saved, exactly as POST /reports does.
    await recordUsage(ownerId, 'report', { report_id: reportId, block_count: ids.length, auto_report_run_id: run.id });
    await updateRun(run, { status: 'done', report_id: reportId, blocks_done: suggestions.length, finished_at: new Date().toISOString() });
    logger.info({ run_id: run.id, dataset_id: dataset.id, report_id: reportId, answered, skipped, flagged, ms: Date.now() - started }, 'auto-report done');
  } catch (err) {
    const message = err instanceof RunFailure ? err.userMessage : BUILD_FAILED;
    if (!(err instanceof RunFailure)) {
      logger.error({ run_id: run.id, err_name: err instanceof Error ? err.name : typeof err }, 'auto-report error');
    }
    await updateRun(run, { status: 'failed', error_message: message, finished_at: new Date().toISOString() }).catch(() =>
      logger.error({ run_id: run.id }, 'could not mark auto-report failed'),
    );
    logger.info({ run_id: run.id, dataset_id: dataset.id, outcome: 'failed', answered, skipped, flagged, ms: Date.now() - started }, 'auto-report finished');
  }
}

/**
 * On boot: any run left `running` was cut off by a restart (jobs run in-process). `ownerId` narrows the sweep (tests).
 */
export async function sweepInterruptedAutoReports(ownerId?: string): Promise<number> {
  let q = supabaseAdmin()
    .from('auto_report_runs')
    .update({ status: 'failed', error_message: INTERRUPTED_MESSAGE, finished_at: new Date().toISOString() })
    .eq('status', 'running');
  if (ownerId) q = q.eq('owner_id', ownerId);
  const { data, error } = await q.select('id');
  throwIfDbError('auto-report: boot sweep', error);
  return data?.length ?? 0;
}
