import { throwIfDbError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getObject, normalisedPath, putObject, removeObjects } from '../lib/storage.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { ParseOptions, PlanLimitDetails } from '../types/api.js';
import { cheapestPlanAllowing, supabaseLimitsDataSource } from './limits.js';
import { type ColumnRow, COLUMN_COLUMNS, DATASET_COLUMNS, type DatasetRow, planFor } from './datasets.js';
import { placeholderFor } from './parsing/pii.js';
import { profileFile } from './parsing/pipeline.js';
import { ParseFailure, TOO_SLOW } from './parsing/sources.js';
import { generateSuggestions, MAX_PROMPT_COLUMNS, SUGGESTIONS_FAILED_WARNING } from './suggestions.js';

/**
 * Background profiling (ARCHITECTURE 2, step 3): in-process jobs, at most 2 at a time, the rest queued in memory
 * (those datasets stay `profiling`). A job that runs longer than 120 s ends `failed`. State lives in the database;
 * the client polls GET /datasets/:id.
 */

export const MAX_CONCURRENT_JOBS = 2;
export const JOB_TIMEOUT_MS = 120_000;
export const INTERRUPTED_MESSAGE = 'Interrupted by a restart. Please try again.';
const GENERIC_FAILURE = 'We could not read this file. Please try again, or change the parse options.';

export interface ProfilingJob {
  datasetId: string;
  ownerId: string;
  /** Options the user supplied on reparse; only non-null fields override detection. */
  overrides: ParseOptions;
}

const queue: ProfilingJob[] = [];
let running = 0;
const idleWaiters: Array<() => void> = [];

export function enqueueProfiling(job: ProfilingJob): void {
  queue.push(job);
  pump();
}

/** Resolves when no job is running or queued (used by tests and graceful shutdown). */
export function profilingIdle(): Promise<void> {
  if (running === 0 && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function pump(): void {
  while (running < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    void runWithTimeout(job).finally(() => {
      running--;
      pump();
      if (running === 0 && queue.length === 0) idleWaiters.splice(0).forEach((r) => r());
    });
  }
}

async function runWithTimeout(job: ProfilingJob): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, JOB_TIMEOUT_MS);
  });
  const started = Date.now();
  try {
    const outcome = await Promise.race([runProfiling(job, controller.signal).then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') await markFailed(job, TOO_SLOW);
    logger.info({ dataset_id: job.datasetId, outcome, ms: Date.now() - started }, 'profiling finished');
  } catch (err) {
    const message = err instanceof ParseFailure ? err.message : GENERIC_FAILURE;
    const limit = err instanceof ParseFailure ? err.limit : undefined;
    if (!(err instanceof ParseFailure)) {
      logger.error({ dataset_id: job.datasetId, err_name: err instanceof Error ? err.name : typeof err }, 'profiling error');
    }
    await markFailed(job, message, limit).catch(() => logger.error({ dataset_id: job.datasetId }, 'could not mark dataset failed'));
  } finally {
    clearTimeout(timer);
  }
}

/** PlanLimitDetails for a plan-limit failure: the server adds upgrade_to from the plan table. */
async function limitDetails(ownerId: string, limit: NonNullable<ParseFailure['limit']>): Promise<PlanLimitDetails> {
  const [plan, all] = await Promise.all([
    supabaseLimitsDataSource.getPlan(ownerId),
    supabaseLimitsDataSource.getAllPlanLimits(),
  ]);
  return { ...limit, upgrade_to: cheapestPlanAllowing(all, plan, (l) => limit.used <= l[limit.limit_key]) };
}

async function markFailed(job: ProfilingJob, message: string, limit?: ParseFailure['limit']): Promise<void> {
  const { retention_days } = await planFor(job.ownerId);
  const errorDetails = limit ? await limitDetails(job.ownerId, limit) : null;
  const { error } = await supabaseAdmin()
    .from('datasets')
    .update({
      status: 'failed',
      error_message: message,
      error_details: errorDetails,
      // Failed datasets expire too, so retention removes their raw file.
      expires_at: new Date(Date.now() + retention_days * 86_400_000).toISOString(),
    })
    .eq('id', job.datasetId)
    .eq('owner_id', job.ownerId)
    .eq('status', 'profiling');
  throwIfDbError('profiling: mark failed', error);
}

function maskedSamples(c: { is_pii: boolean; semantic: ColumnRow['semantic']; name: string }, samples: string[]): string[] {
  return c.is_pii ? samples.map(() => placeholderFor(c.semantic, c.name)) : samples;
}

export async function runProfiling(job: ProfilingJob, signal: AbortSignal): Promise<void> {
  const admin = supabaseAdmin();
  const { data: dataset, error } = await admin
    .from('datasets')
    .select(DATASET_COLUMNS)
    .eq('id', job.datasetId)
    .eq('owner_id', job.ownerId)
    .maybeSingle<DatasetRow>();
  throwIfDbError('profiling: read dataset', error);
  if (!dataset || dataset.status !== 'profiling') return; // deleted, or already handled

  const plan = await planFor(job.ownerId);
  const raw = await getObject(dataset.storage_path);
  if (!raw) throw new ParseFailure('The original file is no longer available. Upload it again.');

  const result = await profileFile({
    buffer: raw,
    fileType: dataset.file_type,
    options: job.overrides,
    maxRows: plan.max_rows,
    signal,
  });
  if (signal.aborted) throw new ParseFailure(TOO_SLOW);

  const outPath = normalisedPath(job.ownerId, job.datasetId);
  await putObject(outPath, result.normalisedCsv, 'text/csv; charset=utf-8');

  // Reparse keeps the user's column edits, matched by sql_name.
  const { data: previous, error: prevError } = await admin
    .from('dataset_columns')
    .select(COLUMN_COLUMNS)
    .eq('dataset_id', job.datasetId)
    .eq('owner_id', job.ownerId)
    .returns<ColumnRow[]>();
  throwIfDbError('profiling: read columns', prevError);
  const bySqlName = new Map((previous ?? []).map((c) => [c.sql_name, c]));

  const columns = result.columns.map((c) => {
    const prev = bySqlName.get(c.sql_name);
    const merged = {
      display_name: prev?.display_name ?? null,
      semantic: prev?.semantic ?? c.semantic,
      is_pii: prev?.is_pii ?? c.is_pii,
      vat_included: prev?.vat_included ?? null,
    };
    return { profiled: c, merged };
  });

  const warnings = [...result.warnings];
  const suggestions = await generateSuggestions(job.ownerId, job.datasetId, {
    datasetName: dataset.name,
    rowCount: result.rowCount,
    columns: columns.map(({ profiled, merged }) => ({ ...profiled, ...merged })),
    sampleRows: result.sampleRows,
  });
  if (!suggestions) warnings.push(SUGGESTIONS_FAILED_WARNING);
  if (result.columns.length > MAX_PROMPT_COLUMNS) {
    warnings.push(`This file has ${result.columns.length} columns; only the first ${MAX_PROMPT_COLUMNS} are used for suggestions.`);
  }
  if (signal.aborted) throw new ParseFailure(TOO_SLOW);

  const { error: delError } = await admin
    .from('dataset_columns')
    .delete()
    .eq('dataset_id', job.datasetId)
    .eq('owner_id', job.ownerId);
  throwIfDbError('profiling: clear columns', delError);
  const { error: insError } = await admin.from('dataset_columns').insert(
    columns.map(({ profiled: c, merged }) => ({
      dataset_id: job.datasetId,
      owner_id: job.ownerId,
      position: c.position,
      name: c.name,
      display_name: merged.display_name,
      sql_name: c.sql_name,
      data_type: c.data_type,
      semantic: merged.semantic,
      is_pii: merged.is_pii,
      vat_included: merged.vat_included,
      null_count: c.null_count,
      distinct_count: c.distinct_count,
      min_value: c.min_value,
      max_value: c.max_value,
      sample_values: maskedSamples({ ...merged, name: c.name }, c.samples),
    })),
  );
  if (insError) {
    // The dataset was most likely deleted while we worked; do not leave its normalised file behind.
    await removeObjects([outPath]).catch(() => undefined);
    throwIfDbError('profiling: insert columns', insError);
  }

  const { data: updated, error: updError } = await admin
    .from('datasets')
    .update({
      status: 'ready',
      error_message: null,
      error_details: null,
      row_count: result.rowCount,
      excluded_rows: result.excludedRows,
      warnings,
      sheet_names: result.sheetNames,
      preamble_lines: result.preambleLines,
      parse_options: result.parseOptions,
      suggestions: suggestions ?? [],
      normalised_path: outPath,
      expires_at: new Date(Date.now() + plan.retention_days * 86_400_000).toISOString(),
    })
    .eq('id', job.datasetId)
    .eq('owner_id', job.ownerId)
    .eq('status', 'profiling')
    .select('id');
  throwIfDbError('profiling: mark ready', updError);
  if (!updated || updated.length === 0) await removeObjects([outPath]).catch(() => undefined);
}

/**
 * On boot: any dataset left `profiling` was interrupted by a restart. It can be reparsed.
 * `ownerId` narrows the sweep (tests); in production it covers everyone.
 */
export async function sweepInterruptedProfiling(ownerId?: string): Promise<number> {
  let q = supabaseAdmin()
    .from('datasets')
    .update({ status: 'failed', error_message: INTERRUPTED_MESSAGE, error_details: null })
    .eq('status', 'profiling');
  if (ownerId) q = q.eq('owner_id', ownerId);
  const { data, error } = await q.select('id');
  throwIfDbError('profiling: boot sweep', error);
  return data?.length ?? 0;
}
