import { Router } from 'express';
import { AppError, notFound, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { supabaseForUser } from '../lib/supabase.js';
import { requireUuidParam, validate } from '../middleware/validate.js';
import {
  alreadyRunning,
  type AutoReportBody,
  autoReportBody,
  type AutoReportRow,
  insertRun,
  MIN_SUGGESTIONS,
  NOT_ENOUGH_SUGGESTIONS,
  RUN_COLUMNS,
  startAutoReport,
  toAutoReportRun,
} from '../services/autoReport.js';
import { getOwnDataset } from '../services/datasets.js';
import { assertQuotaCovers } from '../services/limits.js';

export const autoReportsRouter = Router();

// ---------- POST /datasets/:id/auto-report ----------

autoReportsRouter.post('/datasets/:id/auto-report', requireUuidParam(), validate({ body: autoReportBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const body = req.body as AutoReportBody;
  const db = supabaseForUser(token);
  // Order (API_CONTRACT Flow B2): 404, 409 / 410, 422 suggestions, 409 running, 402 quota.
  const dataset = await getOwnDataset(db, userId, req.params.id as string);
  if (dataset.status === 'expired') throw new AppError('dataset_expired', 'The source file was removed after the retention period.');
  if (dataset.status !== 'ready') throw new AppError('dataset_not_ready', 'This file is not ready yet.');
  if ((dataset.suggestions ?? []).length < MIN_SUGGESTIONS) {
    throw new AppError('validation_failed', NOT_ENOUGH_SUGGESTIONS, {
      fields: [{ location: 'params', path: 'id', message: NOT_ENOUGH_SUGGESTIONS }],
    });
  }
  const { data: running, error } = await db
    .from('auto_report_runs')
    .select('id')
    .eq('owner_id', userId)
    .eq('dataset_id', dataset.id)
    .eq('status', 'running')
    .limit(1);
  throwIfDbError('auto-report: running', error);
  if (running?.[0]) throw alreadyRunning(running[0].id);
  // Nothing is asked unless this month's remaining quota covers every suggestion and one report.
  await assertQuotaCovers(userId, [
    { key: 'max_questions_per_month', needed: dataset.suggestions.length },
    { key: 'max_reports_per_month', needed: 1 },
  ]);

  const run = await insertRun(userId, dataset, body);
  logger.info({ run_id: run.id, dataset_id: dataset.id, questions: run.blocks_total }, 'auto-report started');
  startAutoReport(run, dataset);
  ok(res, toAutoReportRun(run), 202);
});

// ---------- GET /auto-reports/:id ----------

autoReportsRouter.get('/auto-reports/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const { data, error } = await supabaseForUser(token)
    .from('auto_report_runs')
    .select(RUN_COLUMNS)
    .eq('id', req.params.id as string)
    .eq('owner_id', userId)
    .maybeSingle<AutoReportRow>();
  throwIfDbError('auto-report: read', error);
  if (!data) throw notFound('Report build not found.');
  ok(res, toAutoReportRun(data));
});
