import { z } from 'zod';
import type { AutoReportConflictDetails, AutoReportRun, PlanLimitDetails } from '../types';
import { MOCK_PLAN_LIMITS, cheapestPlanAllowing, sastTimestamp, type MockAutoReportRun, type MockUser } from './data';
import { blockFrom, templateForQuestion } from './blockFixtures';
import { questionsThisMonth } from './blocks';
import { findDataset } from './datasets';
import { addReport, reportsThisMonth } from './reports';

/**
 * Mock "Build my report" (Flow B2). A run answers one suggestion every 2 seconds (about 10 s for five), then makes
 * the report. The title picks a variant (documented in client/README.md): "fail" ends failed after two answers,
 * "busy" starts a run but answers 409 naming it (as if another tab had started it), "limit" is 402 on the monthly questions, "slow" takes 3 minutes.
 */

export const MOCK_AUTO_STEP_MS = 2000;
export const MOCK_AUTO_SLOW_TOTAL_MS = 3 * 60_000;

// The server's words (server/src/services/autoReport.ts).
const NOT_ENOUGH_SUGGESTIONS =
  'This file needs at least 3 suggested questions to build a report. Ask your own questions and pin the answers instead.';

type Result = { status: number; body: unknown };
const ok = (data: unknown, status = 200): Result => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, details?: unknown): Result => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

const requestSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  period_label: z.string().trim().max(60).optional(),
});

/** 409 conflict naming the running run, like the server (AutoReportConflictDetails). */
function alreadyRunning(runId: string): Result {
  const details: AutoReportConflictDetails = { auto_report_id: runId };
  return fail(409, 'conflict', 'A report is already being built for this file. Please wait for it to finish.', details);
}

function runsOf(user: MockUser): MockAutoReportRun[] {
  user.auto_report_runs ??= [];
  return user.auto_report_runs;
}

/** Moves a run on to where the time says it should be: answers made, then the report or the failure. */
function settle(user: MockUser, entry: MockAutoReportRun): void {
  const { run } = entry;
  if (run.status !== 'running') return;
  const dataset = run.dataset_id ? findDataset(user, run.dataset_id) : null;
  if (!dataset) {
    Object.assign(run, { status: 'failed', dataset_id: null, error_message: 'The file was deleted.' } satisfies Partial<AutoReportRun>);
    return;
  }
  const due = Math.min(run.blocks_total, Math.floor((Date.now() - entry.started_ms) / entry.step_ms));
  for (let i = run.blocks_done; i < due; i += 1) {
    // The fail variant answers two questions, then the rest cannot be answered (skipped, not counted).
    if (entry.variant === 'fail' && i >= 2) continue;
    const question = entry.questions[i]!;
    const block = blockFrom(templateForQuestion(question), { question, datasetId: dataset.id, source: 'suggested', createdAt: sastTimestamp() });
    (user.blocks ??= []).push({ block, pinned: false });
    (user.question_events ??= []).push(sastTimestamp());
    entry.block_ids.push(block.id);
  }
  run.blocks_done = due;
  if (due < run.blocks_total) return;

  if (entry.block_ids.length < 3) {
    run.status = 'failed';
    run.error_message = `We could only answer ${entry.block_ids.length} of the ${run.blocks_total} questions for this file. Try asking your own questions.`;
    return;
  }
  if (reportsThisMonth(user) >= MOCK_PLAN_LIMITS[user.plan].max_reports_per_month) {
    run.status = 'failed';
    run.error_message = 'Your plan’s monthly report limit was reached, so the report was not created. The answers are saved with this file.';
    return;
  }
  const report = addReport(user, {
    workspace_id: dataset.workspace_id,
    title: entry.title,
    subtitle: null,
    period_label: entry.period_label,
    block_ids: entry.block_ids,
  });
  run.status = 'done';
  run.report_id = report.report.id;
}

export function routeAutoReports(method: string, path: string, user: MockUser, body: unknown): Result | null {
  const start = /^\/datasets\/([^/]+)\/auto-report$/.exec(path);
  if (start && method === 'POST') {
    const dataset = findDataset(user, decodeURIComponent(start[1] ?? ''));
    // Same order as the server (Flow B2): 404, 409/410, 422 suggestions, 409 running, 402.
    if (!dataset) return fail(404, 'not_found', 'Dataset not found.');
    if (dataset.status === 'expired') return fail(410, 'dataset_expired', 'The source file was removed.');
    if (dataset.status !== 'ready') return fail(409, 'dataset_not_ready', 'The dataset is not ready.');
    const parsed = requestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => ({ location: 'body', path: i.path.join('.'), message: i.message }));
      return fail(422, 'validation_failed', 'Some fields are not valid.', { fields });
    }
    if (dataset.suggestions.length < 3) {
      return fail(422, 'validation_failed', NOT_ENOUGH_SUGGESTIONS, {
        fields: [{ location: 'params', path: 'id', message: NOT_ENOUGH_SUGGESTIONS }],
      });
    }
    const title = parsed.data.title ?? dataset.name;
    const runs = runsOf(user);
    runs.forEach((r) => settle(user, r));
    const running = runs.find((r) => r.run.dataset_id === dataset.id && r.run.status === 'running');
    if (running) return alreadyRunning(running.run.id);
    const needed = dataset.suggestions.length;
    const limits = MOCK_PLAN_LIMITS[user.plan];
    const usedQuestions = /limit/i.test(title) ? limits.max_questions_per_month : questionsThisMonth(user);
    if (usedQuestions + needed > limits.max_questions_per_month) {
      const details: PlanLimitDetails = {
        limit_key: 'max_questions_per_month',
        limit: limits.max_questions_per_month,
        used: usedQuestions,
        upgrade_to: cheapestPlanAllowing((l) => l.max_questions_per_month >= usedQuestions + needed),
      };
      return fail(402, 'plan_limit', 'Not enough questions left this month.', details);
    }
    const usedReports = reportsThisMonth(user);
    if (usedReports + 1 > limits.max_reports_per_month) {
      const details: PlanLimitDetails = {
        limit_key: 'max_reports_per_month',
        limit: limits.max_reports_per_month,
        used: usedReports,
        upgrade_to: cheapestPlanAllowing((l) => l.max_reports_per_month >= usedReports + 1),
      };
      return fail(402, 'plan_limit', 'Monthly report limit reached.', details);
    }
    const run: AutoReportRun = {
      id: crypto.randomUUID(),
      dataset_id: dataset.id,
      status: 'running',
      blocks_done: 0,
      blocks_total: needed,
      report_id: null,
      error_message: null,
      created_at: sastTimestamp(),
    };
    runs.push({
      run,
      questions: dataset.suggestions.map((s) => s.question),
      started_ms: Date.now(),
      step_ms: /slow/i.test(title) ? Math.ceil(MOCK_AUTO_SLOW_TOTAL_MS / needed) : MOCK_AUTO_STEP_MS,
      variant: /fail/i.test(title) ? 'fail' : 'normal',
      block_ids: [],
      title,
      period_label: parsed.data.period_label || null,
    });
    // "busy": as if another tab had just started it, this request is told which run is already running.
    if (/busy/i.test(title)) return alreadyRunning(run.id);
    return ok({ ...run }, 202);
  }

  const get = /^\/auto-reports\/([^/]+)$/.exec(path);
  if (get && method === 'GET') {
    const entry = runsOf(user).find((r) => r.run.id === decodeURIComponent(get[1] ?? ''));
    if (!entry) return fail(404, 'not_found', 'Not found.');
    settle(user, entry);
    return ok({ ...entry.run });
  }
  return null;
}
