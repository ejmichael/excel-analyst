import { Router } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { getObject } from '../lib/storage.js';
import { supabaseForUser } from '../lib/supabase.js';
import { dashboardDataLimit, dashboardPlanDatasetLimit, dashboardPlanUserLimit } from '../middleware/rateLimit.js';
import { parseOrThrow, requireUuidParam, validate } from '../middleware/validate.js';
import { type DashboardDataBody, dashboardDataBody, resolveFilters, runDashboardData } from '../services/dashboard/data.js';
import { startDashboardJob } from '../services/dashboard/job.js';
import { beginPlanning, readDashboard, toDashboard } from '../services/dashboard/storage.js';
import { type DatasetRow, getColumns, getOwnDataset } from '../services/datasets.js';
import { withSandbox } from '../services/sandbox/sandbox.js';

/** The dashboard of a dataset (Part W2). Logs ids, counts and timings only: never SQL, filter values or results. */
export const dashboardsRouter = Router();

function assertDatasetReady(dataset: DatasetRow): void {
  if (dataset.status === 'expired') throw new AppError('dataset_expired', 'The source file was removed after the retention period.');
  if (dataset.status !== 'ready') throw new AppError('dataset_not_ready', 'This file is not ready yet.');
}

// ---------- GET /datasets/:id/dashboard ----------

dashboardsRouter.get('/datasets/:id/dashboard', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  // 404 until the first POST, and for an unknown or another user's dataset alike.
  const row = await readDashboard(supabaseForUser(token), userId, req.params.id as string);
  if (!row) throw notFound('This file has no dashboard yet.');
  ok(res, toDashboard(row));
});

// ---------- POST /datasets/:id/dashboard ----------

dashboardsRouter.post('/datasets/:id/dashboard', requireUuidParam(), dashboardPlanDatasetLimit, dashboardPlanUserLimit, async (req, res) => {
  const { userId, token } = authOf(req);
  parseOrThrow(z.strictObject({}), req.body ?? {});
  const db = supabaseForUser(token);
  const dataset = await getOwnDataset(db, userId, req.params.id as string);
  assertDatasetReady(dataset);
  const { row, started } = await beginPlanning(db, userId, dataset.id);
  if (started) {
    startDashboardJob(row, {
      datasetName: dataset.name,
      rowCount: dataset.row_count ?? 0,
      normalisedPath: dataset.normalised_path,
      columns: await getColumns(db, dataset.id),
    });
    logger.info({ dashboard_id: row.id, dataset_id: dataset.id }, 'dashboard planning started');
  }
  ok(res, toDashboard(row), 202);
});

// ---------- POST /datasets/:id/dashboard/data ----------

dashboardsRouter.post('/datasets/:id/dashboard/data', requireUuidParam(), dashboardDataLimit, validate({ body: dashboardDataBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const body = req.body as DashboardDataBody;
  const db = supabaseForUser(token);
  const row = await readDashboard(db, userId, req.params.id as string);
  if (!row) throw notFound('This file has no dashboard yet.');
  if (row.status !== 'ready') throw new AppError('dashboard_not_ready', 'The dashboard is not ready yet.');
  const dataset = await getOwnDataset(db, userId, row.dataset_id);
  assertDatasetReady(dataset);
  const filters = resolveFilters(row.plan.filters, body);
  const file = dataset.normalised_path ? await getObject(dataset.normalised_path) : null;
  if (!file) throw new AppError('dataset_expired', 'The source file is no longer available.');

  const started = Date.now();
  const columns = await getColumns(db, dataset.id);
  const data = await withSandbox({ csv: file, columns }, (session) => runDashboardData(session, row.plan.widgets, filters));
  logger.info(
    { dashboard_id: row.id, filters: filters.length, widgets: data.widgets.length, failed: data.widgets.filter((w) => w.error).length, ms: Date.now() - started },
    'dashboard data',
  );
  ok(res, data);
});
