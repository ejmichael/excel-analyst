import { Router } from 'express';
import { z } from 'zod';
import { AppError, notFound, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';
import { parseOrThrow, requireUuidParam, validate, validQuery } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { todaySast } from '../services/dates.js';
import { slugify } from '../services/downloadNames.js';
import { assertWithinLimit, supabaseLimitsDataSource } from '../services/limits.js';
import { buildReportXlsx, ExportTooLarge, MAX_CONCURRENT_EXPORTS } from '../services/reportXlsx.js';
import { Semaphore } from '../services/sandbox/semaphore.js';
import {
  assertBlocksAllowed,
  buildReportDetail,
  createReport,
  createReportBody,
  getMembers,
  getOwnReport,
  REPORT_COLUMNS,
  type ReportRow,
  toReport,
  updateReport,
  updateReportBody,
  type UpdateReportBody,
} from '../services/reports.js';
import { recordUsage } from '../services/usageEvents.js';
import type { Deleted, Paged, Report } from '../types/api.js';

export const reportsRouter = Router();

// ---------- GET /reports ----------

const listQuery = z.strictObject({
  workspace_id: z.uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

reportsRouter.get('/reports', validate({ query: listQuery }), async (req, res) => {
  const { userId, token } = authOf(req);
  const q = validQuery<z.infer<typeof listQuery>>(req);
  const db = supabaseForUser(token);
  const { data: ws, error: wsError } = await db.from('workspaces').select('id').eq('id', q.workspace_id).eq('owner_id', userId).maybeSingle();
  throwIfDbError('reports: workspace', wsError);
  if (!ws) throw notFound('Workspace not found.');
  const { data, count, error } = await db
    .from('reports')
    .select(`${REPORT_COLUMNS}, report_blocks(count)`, { count: 'exact' })
    .eq('owner_id', userId)
    .eq('workspace_id', q.workspace_id)
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1)
    .returns<Array<ReportRow & { report_blocks: Array<{ count: number }> }>>();
  throwIfDbError('reports: list', error);
  const page: Paged<Report> = {
    items: (data ?? []).map((r) => toReport(r, r.report_blocks?.[0]?.count ?? 0)),
    total: count ?? 0,
    limit: q.limit,
    offset: q.offset,
  };
  ok(res, page);
});

// ---------- POST /reports ----------

// Read first so the checks can run in the contract's order: workspace (404), monthly limit (402), then the full body (422).
const workspaceOnly = z.object({ workspace_id: z.uuid() });

reportsRouter.post('/reports', async (req, res) => {
  const { userId, token } = authOf(req);
  const { workspace_id } = parseOrThrow(workspaceOnly, req.body ?? {});
  const db = supabaseForUser(token);
  const { data: ws, error: wsError } = await db.from('workspaces').select('id').eq('id', workspace_id).eq('owner_id', userId).maybeSingle();
  throwIfDbError('reports: workspace', wsError);
  if (!ws) throw notFound('Workspace not found.');
  await assertWithinLimit(userId, 'max_reports_per_month');
  const body = parseOrThrow(createReportBody, req.body ?? {});
  await assertBlocksAllowed(db, userId, body.block_ids, body.workspace_id, null, 'block_ids');

  const started = Date.now();
  const id = await createReport(userId, body);
  // Counted only once the report and its blocks are saved.
  await recordUsage(userId, 'report', { report_id: id, block_count: body.block_ids.length });
  logger.info({ report_id: id, blocks: body.block_ids.length, ms: Date.now() - started }, 'report created');
  ok(res, await buildReportDetail(db, userId, await getOwnReport(db, userId, id)), 201);
});

// ---------- GET /reports/:id ----------

reportsRouter.get('/reports/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const db = supabaseForUser(token);
  ok(res, await buildReportDetail(db, userId, await getOwnReport(db, userId, req.params.id as string)));
});

// ---------- PATCH /reports/:id ----------

reportsRouter.patch('/reports/:id', requireUuidParam(), validate({ body: updateReportBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const body = req.body as UpdateReportBody;
  const db = supabaseForUser(token);
  const report = await getOwnReport(db, userId, req.params.id as string);
  if (body.blocks) {
    const members = new Set((await getMembers(db, userId, report.id)).map((m) => m.block_id));
    await assertBlocksAllowed(
      db,
      userId,
      body.blocks.map((b) => b.block_id),
      report.workspace_id,
      members,
      'blocks',
    );
  }
  // Editing never counts against max_reports_per_month.
  if (!(await updateReport(userId, report.id, body))) throw notFound('Report not found.');
  logger.info({ report_id: report.id, blocks: body.blocks?.length ?? null }, 'report updated');
  ok(res, await buildReportDetail(db, userId, await getOwnReport(db, userId, report.id)));
});

// ---------- DELETE /reports/:id ----------

reportsRouter.delete('/reports/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const report = await getOwnReport(supabaseForUser(token), userId, req.params.id as string);
  // report_blocks (and later share_links) go with it through ON DELETE CASCADE; the blocks themselves stay.
  const { error } = await supabaseAdmin().from('reports').delete().eq('id', report.id).eq('owner_id', userId);
  throwIfDbError('reports: delete', error);
  const deleted: Deleted = { deleted: true };
  ok(res, deleted);
});


// ---------- GET /reports/:id/export.xlsx ----------

// Workbooks are built in memory: at most MAX_CONCURRENT_EXPORTS at a time, waiting up to 20 s for a slot.
const exportSlots = new Semaphore(MAX_CONCURRENT_EXPORTS);

reportsRouter.get('/reports/:id/export.xlsx', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const db = supabaseForUser(token);
  const detail = await buildReportDetail(db, userId, await getOwnReport(db, userId, req.params.id as string));
  const [plan, allLimits] = await Promise.all([supabaseLimitsDataSource.getPlan(userId), supabaseLimitsDataSource.getAllPlanLimits()]);
  const branding = allLimits.find((l) => l.plan === plan)?.branding ?? false;

  const release = await exportSlots.acquire(20_000);
  if (!release) throw new AppError('rate_limited', 'The server is busy building other exports. Please try again in a moment.');
  const started = Date.now();
  let file: Buffer;
  try {
    file = await buildReportXlsx(detail, { appName: env().APP_NAME, branding, generatedAt: new Date() });
  } catch (err) {
    if (err instanceof ExportTooLarge) {
      logger.warn({ report_id: detail.id, cells: err.cells }, 'export too large');
      throw new AppError('internal', 'This report is too large to export to Excel. Remove some answers or ask for fewer rows, then try again.');
    }
    throw err;
  } finally {
    release();
  }
  // Counted only once the file was built.
  await recordUsage(userId, 'export', { report_id: detail.id, format: 'xlsx', bytes: file.length, blocks: detail.blocks.length });
  logger.info({ report_id: detail.id, bytes: file.length, blocks: detail.blocks.length, ms: Date.now() - started }, 'report exported');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(detail.title, 'report')}-${todaySast()}.xlsx"`);
  res.setHeader('Content-Length', String(file.length));
  res.end(file);
});
