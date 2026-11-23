import { logger } from '../../lib/logger.js';
import { getObject } from '../../lib/storage.js';
import { llm } from '../../llm/client.js';
import { recordLlmUsage } from '../usageEvents.js';
import { planDashboard } from './planner.js';
import { type DashboardRow, finishPlanning, STALE_PLANNING_MS } from './storage.js';
import type { DashboardColumn } from './widgets.js';

/**
 * The planning job behind POST /datasets/:id/dashboard (in-process, like profiling and the auto-report). It never
 * throws: every failure ends the dashboard failed with a user-safe message. It stops itself before a run would be
 * read as stale. Logs ids, counts and timings only.
 */

export const JOB_LIMIT_MS = STALE_PLANNING_MS - 30_000;
const GENERIC = 'We could not build a dashboard for this file right now. Please try again.';
const TOO_SLOW = 'Building this dashboard took too long. Please try again.';

export interface DashboardJobInput {
  datasetName: string;
  rowCount: number;
  normalisedPath: string | null;
  columns: DashboardColumn[];
}

const active = new Set<Promise<void>>();
const idleWaiters: Array<() => void> = [];

/** Resolves when no dashboard job is running (tests and graceful shutdown). */
export function dashboardsIdle(): Promise<void> {
  if (active.size === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

export function startDashboardJob(row: DashboardRow, input: DashboardJobInput): void {
  const job = run(row, input).finally(() => {
    active.delete(job);
    if (active.size === 0) idleWaiters.splice(0).forEach((r) => r());
  });
  active.add(job);
}

async function run(row: DashboardRow, input: DashboardJobInput): Promise<void> {
  const started = Date.now();
  const fail = (message: string) =>
    finishPlanning(row, { status: 'failed', fallback: false, error_message: message, plan: row.plan }).catch(() =>
      logger.error({ dashboard_id: row.id }, 'could not mark dashboard failed'),
    );
  let timer: NodeJS.Timeout | undefined;
  try {
    const csv = input.normalisedPath ? await getObject(input.normalisedPath) : null;
    if (!csv) {
      await fail('The source file is no longer available.');
      return;
    }
    const planning = planDashboard(
      { datasetName: input.datasetName, rowCount: input.rowCount, columns: input.columns, csv },
      { llm: llm(), recordLlm: (purpose, usage, meta) => recordLlmUsage(row.owner_id, purpose, usage, { dataset_id: row.dataset_id, dashboard_id: row.id, ...meta }) },
    );
    const outcome = await Promise.race([planning, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), JOB_LIMIT_MS)))]);
    if (outcome === 'timeout') {
      await fail(TOO_SLOW);
      logger.warn({ dashboard_id: row.id, ms: Date.now() - started }, 'dashboard planning timed out');
      return;
    }
    // The trace holds model text (titles, SQL): never logged.
    const { report: { trace: _trace, ...report }, ...saved } = outcome;
    await finishPlanning(row, saved);
    logger.info(
      { dashboard_id: row.id, dataset_id: row.dataset_id, status: saved.status, fallback: saved.fallback, widgets: saved.plan.widgets.length, ...report, ms: Date.now() - started },
      'dashboard planned',
    );
  } catch (err) {
    logger.error({ dashboard_id: row.id, err_name: err instanceof Error ? err.name : typeof err }, 'dashboard planning error');
    await fail(GENERIC);
  } finally {
    clearTimeout(timer);
  }
}
