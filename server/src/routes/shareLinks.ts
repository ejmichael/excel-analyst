import { Router, type Response } from 'express';
import { AppError, notFound, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';
import { publicRateLimit } from '../middleware/rateLimit.js';
import { requireUuidParam, validate } from '../middleware/validate.js';
import { assertWithinLimit } from '../services/limits.js';
import { buildReportDetail, getOwnReport } from '../services/reports.js';
import {
  countView,
  type CreateShareLinkBody,
  createShareLinkBody,
  isLive,
  newToken,
  reportContainsPersonalData,
  SHARE_COLUMNS,
  type ShareLinkRow,
  toPublicReport,
  toShareLink,
} from '../services/shareLinks.js';
import { recordUsage } from '../services/usageEvents.js';
import type { ShareLink } from '../types/api.js';

/** Owner routes (auth and consent). Never logs a token: only link and report ids. */
export const shareLinksRouter = Router();

// ---------- GET /reports/:id/share-links ----------

shareLinksRouter.get('/reports/:id/share-links', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const db = supabaseForUser(token);
  const report = await getOwnReport(db, userId, req.params.id as string);
  const { data, error } = await db
    .from('share_links')
    .select(SHARE_COLUMNS)
    .eq('owner_id', userId)
    .eq('report_id', report.id)
    .order('created_at', { ascending: false })
    .returns<ShareLinkRow[]>();
  throwIfDbError('share-links: list', error);
  // One report, so one answer for every link (computed now: the report's answers may have changed since creation).
  const personal = (data ?? []).length > 0 ? await reportContainsPersonalData(db, userId, report.id) : false;
  ok(res, (data ?? []).map((r) => toShareLink(r, personal)) satisfies ShareLink[]);
});

// ---------- POST /reports/:id/share-links ----------

shareLinksRouter.post('/reports/:id/share-links', requireUuidParam(), validate({ body: createShareLinkBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const body = req.body as CreateShareLinkBody;
  const db = supabaseForUser(token);
  const report = await getOwnReport(db, userId, req.params.id as string);
  await assertWithinLimit(userId, 'share_links');
  const days = body.expires_in_days ?? null;
  const { data, error } = await supabaseAdmin()
    .from('share_links')
    .insert({
      owner_id: userId,
      report_id: report.id,
      token: newToken(),
      show_working: body.show_working ?? false,
      expires_at: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
    })
    .select(SHARE_COLUMNS)
    .single<ShareLinkRow>();
  throwIfDbError('share-links: insert', error);
  // Counted only once the link is saved.
  await recordUsage(userId, 'share', { report_id: report.id, share_link_id: data!.id, show_working: data!.show_working, expires_in_days: days });
  logger.info({ report_id: report.id, share_link_id: data!.id }, 'share link created');
  ok(res, toShareLink(data!, await reportContainsPersonalData(db, userId, report.id)), 201);
});

// ---------- DELETE /share-links/:id ----------

shareLinksRouter.delete('/share-links/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const db = supabaseForUser(token);
  const id = req.params.id as string;
  const { data: link, error } = await db.from('share_links').select(SHARE_COLUMNS).eq('id', id).eq('owner_id', userId).maybeSingle<ShareLinkRow>();
  throwIfDbError('share-links: read', error);
  if (!link) throw notFound('Share link not found.');
  let row = link;
  // Repeating a revoke is harmless: the first revoked_at is kept.
  if (link.revoked_at === null) {
    const { data, error: uError } = await supabaseAdmin()
      .from('share_links')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('owner_id', userId)
      .select(SHARE_COLUMNS)
      .single<ShareLinkRow>();
    throwIfDbError('share-links: revoke', uError);
    row = data!;
    logger.info({ share_link_id: id }, 'share link revoked');
  }
  ok(res, toShareLink(row, await reportContainsPersonalData(db, userId, row.report_id)));
});

// ---------- GET /public/reports/:token (no auth) ----------

/** Public routes: mounted before authentication. The Authorization header is never read here. */
export const publicRouter = Router();

const PUBLIC_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

/** Unknown, revoked and expired links all get this exact error, so a response never says whether a link existed. */
const linkNotFound = () => new AppError('not_found', 'This link is not valid. Ask the sender for a new one.');

function setPublicHeaders(res: Response): void {
  for (const [k, v] of Object.entries(PUBLIC_HEADERS)) res.setHeader(k, v);
}

publicRouter.get('/public/reports/:token', publicRateLimit, async (req, res) => {
  setPublicHeaders(res);
  const token = req.params.token as string;
  // A string of this length is never a token we issued; still look it up below for anything that could be one,
  // so unknown, revoked and expired take the same single query.
  if (token.length < 32 || token.length > 128) throw linkNotFound();
  const { data: link, error } = await supabaseAdmin().from('share_links').select(SHARE_COLUMNS).eq('token', token).maybeSingle<ShareLinkRow>();
  throwIfDbError('public: link', error);
  if (!link || !isLive(link)) throw linkNotFound();

  const admin = supabaseAdmin();
  const detail = await buildReportDetail(admin, link.owner_id, await getOwnReport(admin, link.owner_id, link.report_id).catch(() => {
    throw linkNotFound();
  }));
  await countView(link);
  logger.info({ share_link_id: link.id, blocks: detail.blocks.length }, 'public report viewed');
  // brand.logo_url: see docs/CONTRACT_CHANGES.md 2026-11-16 "Logo on public reports" (PROPOSED); null until decided.
  ok(res, toPublicReport(detail, link.show_working, null));
});
