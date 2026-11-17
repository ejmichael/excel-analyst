import { z } from 'zod';
import type { PlanLimitDetails, PublicReport, ShareLink, ValidationFailedDetails } from '../types';
import { MOCK_PLAN_LIMITS, cheapestPlanAllowing, sastTimestamp, type MockUser } from './data';
import { reportDetail, reportsOf } from './reports';
import { MOCK_XLSX_BASE64 } from './xlsxFixture';

/**
 * Mock export and share links (S4), following the contract and the server's S4 notes. Variants (client/README.md):
 * a report titled with "busy" answers the Excel export with 429 and Retry-After, one titled with "huge" with the 422
 * for a report too large to export; links made on a report titled with
 * "expired" are already expired; a report titled with "personal", or an answer with a column such as email, phone or
 * customer, is flagged contains_personal_data. The public token "busy" answers 429.
 */

/** The server's message for a report too large to export (422, reason export_too_large). */
const EXPORT_TOO_LARGE = 'This report is too large to export to Excel. Remove some answers or ask for fewer rows, then try again.';

type Result = { status: number; body?: unknown; raw?: Response };
const ok = (data: unknown, status = 200): Result => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, details?: unknown): Result => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

const createSchema = z.strictObject({
  expires_in_days: z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]).optional(),
  show_working: z.boolean().optional(),
});

const PERSONAL_COLUMN = /email|e-mail|phone|cell|mobile|customer|name|address|id.?number/i;

function linksOf(user: MockUser) {
  user.share_links ??= [];
  return user.share_links;
}

/** Best effort, like the server: personal-looking result columns, or a report title with "personal" (mock variant). */
function containsPersonalData(user: MockUser, reportId: string): boolean {
  const report = reportsOf(user).find((r) => r.report.id === reportId);
  if (!report) return false;
  if (/personal/i.test(report.report.title)) return true;
  return reportDetail(user, report).blocks.some((b) => b.block.columns.some((c) => PERSONAL_COLUMN.test(c.name)));
}

const withFlag = (user: MockUser, link: Omit<ShareLink, 'contains_personal_data'>): ShareLink => ({
  ...link,
  contains_personal_data: containsPersonalData(user, link.report_id),
});

/** 43 URL-safe characters, like the server's tokens. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function slug(text: string): string {
  return text.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
}

/** The server's words: one identical 404 for an unknown, expired or turned-off link. */
const UNAVAILABLE = { error: { code: 'not_found', message: 'This link is not valid. Ask the sender for a new one.' } };
const PUBLIC_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

/**
 * GET /public/reports/:token (no sign-in). The token "busy" answers 429 with Retry-After (mock variant). The report
 * has no workspace, template or dataset ids; sql and checks only with show_working; never source rows.
 */
export function routePublicReport(users: MockUser[], token: string): Response {
  if (token === 'busy') {
    return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests.' } }), {
      status: 429,
      headers: { ...PUBLIC_HEADERS, 'Retry-After': '20' },
    });
  }
  const unavailable = () => new Response(JSON.stringify(UNAVAILABLE), { status: 404, headers: PUBLIC_HEADERS });
  const owner = users.find((u) => (u.share_links ?? []).some((l) => l.token === token));
  const link = owner?.share_links?.find((l) => l.token === token);
  if (!owner || !link) return unavailable();
  if (link.revoked_at || (link.expires_at && Date.parse(link.expires_at) <= Date.now())) return unavailable();
  const report = reportsOf(owner).find((r) => r.report.id === link.report_id);
  if (!report) return unavailable();

  link.view_count += 1;
  const { workspace_id: _workspace, template_id: _template, blocks, ...rest } = reportDetail(owner, report);
  const data: PublicReport = {
    ...rest,
    blocks: blocks.map(({ position, heading_override, block }) => {
      const { dataset_id: _dataset, ...publicBlock } = block;
      return {
        position,
        heading_override,
        block: {
          ...publicBlock,
          sql: link.show_working ? publicBlock.sql : '',
          checks: link.show_working ? publicBlock.checks : [],
          has_source_rows: false,
        },
      };
    }),
  };
  return new Response(JSON.stringify({ data }), { status: 200, headers: PUBLIC_HEADERS });
}

export function routeSharing(method: string, path: string, user: MockUser, body: unknown, origin: string): Result | null {
  const xlsx = /^\/reports\/([^/]+)\/export\.xlsx$/.exec(path);
  if (xlsx && method === 'GET') {
    const report = reportsOf(user).find((r) => r.report.id === decodeURIComponent(xlsx[1] ?? ''));
    if (!report) return fail(404, 'not_found', 'Report not found.');
    if (/busy/i.test(report.report.title)) {
      return { status: 429, raw: new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many exports.' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '12' } }) };
    }
    // Mock variant "huge": the server's body for a report too large to export.
    if (/huge/i.test(report.report.title)) {
      const details: ValidationFailedDetails = {
        fields: [{ location: 'params', path: 'id', message: EXPORT_TOO_LARGE }],
        reason: 'export_too_large',
      };
      return fail(422, 'validation_failed', EXPORT_TOO_LARGE, details);
    }
    const bytes = Uint8Array.from(atob(MOCK_XLSX_BASE64), (c) => c.charCodeAt(0));
    const filename = `${slug(report.report.title)}-${sastTimestamp().slice(0, 10)}.xlsx`;
    return {
      status: 200,
      raw: new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      }),
    };
  }

  const list = /^\/reports\/([^/]+)\/share-links$/.exec(path);
  if (list) {
    const reportId = decodeURIComponent(list[1] ?? '');
    const report = reportsOf(user).find((r) => r.report.id === reportId);
    if (!report) return fail(404, 'not_found', 'Report not found.');
    if (method === 'GET') {
      const items = linksOf(user)
        .filter((l) => l.report_id === reportId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((l) => withFlag(user, l));
      return ok(items);
    }
    if (method === 'POST') {
      if (!MOCK_PLAN_LIMITS[user.plan].share_links) {
        const details: PlanLimitDetails = { limit_key: 'share_links', limit: 0, used: 0, upgrade_to: cheapestPlanAllowing((l) => l.share_links) };
        return fail(402, 'plan_limit', 'Share links are not included in your plan.', details);
      }
      const parsed = createSchema.safeParse(body ?? {});
      if (!parsed.success) {
        const fields = parsed.error.issues.map((i) => ({ location: 'body', path: i.path.join('.'), message: i.message }));
        return fail(422, 'validation_failed', 'Some fields are not valid.', { fields });
      }
      const days = parsed.data.expires_in_days ?? null;
      const now = Date.now();
      // Mock variant: on a report titled with "expired" a new link has already expired.
      const expiresAt = /expired/i.test(report.report.title) ? sastTimestamp(new Date(now - 60_000)) : days ? sastTimestamp(new Date(now + days * 86_400_000)) : null;
      const token = newToken();
      const link = {
        id: crypto.randomUUID(),
        report_id: reportId,
        token,
        url: `${origin}/r/${token}`,
        show_working: parsed.data.show_working ?? false,
        expires_at: expiresAt,
        revoked_at: null,
        view_count: 0,
        created_at: sastTimestamp(),
      };
      linksOf(user).push(link);
      return ok(withFlag(user, link), 201);
    }
  }

  const revoke = /^\/share-links\/([^/]+)$/.exec(path);
  if (revoke && method === 'DELETE') {
    const link = linksOf(user).find((l) => l.id === decodeURIComponent(revoke[1] ?? ''));
    if (!link) return fail(404, 'not_found', 'Share link not found.');
    // Repeating it returns the same revoked_at.
    link.revoked_at ??= sastTimestamp();
    return ok(withFlag(user, link));
  }
  return null;
}
