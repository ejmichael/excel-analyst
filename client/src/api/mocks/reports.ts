import { z } from 'zod';
import type { Brand, PlanLimitDetails, Report, ReportDetail } from '../types';
import { MOCK_PLAN_LIMITS, cheapestPlanAllowing, sastMonthStart, sastTimestamp, type MockUser } from './data';

/**
 * Mock reports and logo routes, following the S3 server brief: lengths (title 1-120, subtitle 200, period 60,
 * notes 2000, heading 120), 1 to 30 distinct answers, the workspace rule (422), 404 without saying which answer,
 * the monthly report limit (402), watermark on the free plan, and the logo checked by its bytes.
 */

export interface MockReport {
  report: Omit<Report, 'block_count'>;
  blocks: Array<{ block_id: string; heading_override: string | null }>;
}

type Result = { status: number; body: unknown };
const ok = (data: unknown, status = 200): Result => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, details?: unknown): Result => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
const field = (path: string, message: string) => ({ location: 'body', path, message });
const invalid = (fields: Array<{ location: string; path: string; message: string }>, message = 'Some fields are not valid.') =>
  fail(422, 'validation_failed', message, { fields });

function validationFailed(error: z.ZodError): Result {
  return invalid(error.issues.map((i) => field(i.path.join('.'), i.message)));
}

export const WORKSPACE_RULE_MESSAGE = 'This answer comes from a file in another workspace. A report can only hold answers from its own workspace.';
export const DELETED_FILE_MESSAGE = "This answer's file was deleted, so it can't be checked against this workspace.";

const title = z.string().trim().min(1).max(120);
const subtitle = z.string().trim().max(200).nullable().optional();
const period = z.string().trim().max(60).nullable().optional();
const notes = z.string().max(2000).nullable().optional();

const createSchema = z.strictObject({
  workspace_id: z.string(),
  title,
  subtitle,
  period_label: period,
  block_ids: z.array(z.string()).min(1).max(30),
});

const updateSchema = z
  .strictObject({
    title: title.optional(),
    subtitle,
    period_label: period,
    notes,
    blocks: z
      .array(z.strictObject({ block_id: z.string(), heading_override: z.string().trim().max(120).nullable().optional() }))
      .min(1)
      .max(30)
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Send at least one field.' });

const pageQuery = z.object({
  workspace_id: z.string(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function reportsOf(user: MockUser): MockReport[] {
  user.reports ??= [];
  return user.reports;
}

export function reportsThisMonth(user: MockUser): number {
  const start = sastMonthStart();
  return (user.report_events ?? []).filter((t) => t.slice(0, 10) >= start).length;
}

export function isInAnyReport(user: MockUser, blockId: string): boolean {
  return reportsOf(user).some((r) => r.blocks.some((b) => b.block_id === blockId));
}

function brandOf(user: MockUser): Brand {
  return { business_name: user.business_name, logo_url: user.logo_data_url ?? null, color: user.brand_color };
}

function summary(r: MockReport): Report {
  return { ...r.report, block_count: r.blocks.length };
}

function detail(user: MockUser, r: MockReport): ReportDetail {
  return {
    ...summary(r),
    brand: brandOf(user),
    watermark: user.plan === 'free',
    blocks: r.blocks.flatMap((b, position) => {
      const entry = (user.blocks ?? []).find((x) => x.block.id === b.block_id);
      return entry ? [{ position, heading_override: b.heading_override, block: entry.block }] : [];
    }),
    comparison: null,
  };
}

/**
 * The ownership and workspace rules for a list of answers. 404 (without saying which) if any is not the caller's;
 * 422 naming the position if an answer is from another workspace, or its file was deleted (allowed on update only
 * when it is already in the report).
 */
function checkBlocks(user: MockUser, workspaceId: string, ids: string[], path: (i: number) => string, existing: Set<string> | null): Result | null {
  if (new Set(ids).size !== ids.length) {
    const dupe = ids.findIndex((id, i) => ids.indexOf(id) !== i);
    return invalid([field(path(dupe), 'This answer is in the list twice.')]);
  }
  const entries = ids.map((id) => (user.blocks ?? []).find((b) => b.block.id === id));
  if (entries.some((e) => !e)) return fail(404, 'not_found', 'Not found.');
  const problems = [];
  for (const [i, entry] of entries.entries()) {
    const datasetId = entry!.block.dataset_id;
    if (datasetId === null) {
      if (!existing?.has(entry!.block.id)) problems.push(field(path(i), DELETED_FILE_MESSAGE));
      continue;
    }
    const dataset = (user.datasets ?? []).find((d) => d.detail.id === datasetId);
    if (dataset && dataset.detail.workspace_id !== workspaceId) problems.push(field(path(i), WORKSPACE_RULE_MESSAGE));
  }
  return problems.length > 0 ? invalid(problems, problems[0]!.message) : null;
}

export function routeReports(method: string, url: URL, user: MockUser, body: unknown): Result | null {
  const path = url.pathname.replace(/^\/api\/v1/, '');

  if (path === '/reports' && method === 'GET') {
    const parsed = pageQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return validationFailed(parsed.error);
    const { workspace_id, limit, offset } = parsed.data;
    if (!user.workspaces.some((w) => w.id === workspace_id)) return fail(404, 'not_found', 'Workspace not found.');
    const items = reportsOf(user)
      .filter((r) => r.report.workspace_id === workspace_id)
      .sort((a, b) => b.report.created_at.localeCompare(a.report.created_at))
      .map(summary);
    return ok({ items: items.slice(offset, offset + limit), total: items.length, limit, offset });
  }

  if (path === '/reports' && method === 'POST') {
    const workspaceId = (body as { workspace_id?: unknown } | null)?.workspace_id;
    if (typeof workspaceId === 'string' && !user.workspaces.some((w) => w.id === workspaceId)) return fail(404, 'not_found', 'Workspace not found.');
    const limit = MOCK_PLAN_LIMITS[user.plan].max_reports_per_month;
    const used = reportsThisMonth(user);
    if (used >= limit) {
      const details: PlanLimitDetails = {
        limit_key: 'max_reports_per_month',
        limit,
        used,
        upgrade_to: cheapestPlanAllowing((l) => l.max_reports_per_month > used),
      };
      return fail(402, 'plan_limit', 'Monthly report limit reached.', details);
    }
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const input = parsed.data;
    const problem = checkBlocks(user, input.workspace_id, input.block_ids, (i) => `block_ids.${i}`, null);
    if (problem) return problem;
    const now = sastTimestamp();
    const report: MockReport = {
      report: {
        id: crypto.randomUUID(),
        workspace_id: input.workspace_id,
        title: input.title,
        subtitle: input.subtitle || null,
        period_label: input.period_label || null,
        notes: null,
        template_id: null,
        created_at: now,
        updated_at: now,
      },
      blocks: input.block_ids.map((block_id) => ({ block_id, heading_override: null })),
    };
    reportsOf(user).push(report);
    (user.report_events ??= []).push(now);
    return ok(detail(user, report), 201);
  }

  const match = /^\/reports\/([^/]+)$/.exec(path);
  if (!match) return null;
  const report = reportsOf(user).find((r) => r.report.id === decodeURIComponent(match[1] ?? ''));
  if (!report) return fail(404, 'not_found', 'Report not found.');

  if (method === 'GET') return ok(detail(user, report));

  if (method === 'DELETE') {
    user.reports = reportsOf(user).filter((r) => r !== report);
    return ok({ deleted: true });
  }

  if (method === 'PATCH') {
    const parsed = updateSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const input = parsed.data;
    if (input.blocks) {
      const existing = new Set(report.blocks.map((b) => b.block_id));
      const problem = checkBlocks(user, report.report.workspace_id, input.blocks.map((b) => b.block_id), (i) => `blocks.${i}.block_id`, existing);
      if (problem) return problem;
    }
    // Everything checked first, then applied together: a refused change leaves the report as it was.
    if (input.title !== undefined) report.report.title = input.title;
    if (input.subtitle !== undefined) report.report.subtitle = input.subtitle || null;
    if (input.period_label !== undefined) report.report.period_label = input.period_label || null;
    if (input.notes !== undefined) report.report.notes = input.notes || null;
    if (input.blocks) report.blocks = input.blocks.map((b) => ({ block_id: b.block_id, heading_override: b.heading_override || null }));
    report.report.updated_at = sastTimestamp();
    return ok(detail(user, report));
  }

  return fail(404, 'not_found', 'Not found.');
}

// ----- logo -----

const MB = 1024 * 1024;

function brandingDenied(user: MockUser): Result | null {
  if (MOCK_PLAN_LIMITS[user.plan].branding) return null;
  const details: PlanLimitDetails = { limit_key: 'branding', limit: 0, used: 0, upgrade_to: cheapestPlanAllowing((l) => l.branding) };
  return fail(402, 'plan_limit', 'Branding is not included in your plan.', details);
}

function imageKind(b: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | 'svg' | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (/<svg|<\?xml/i.test(ascii(0, Math.min(b.length, 256)))) return 'svg';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export async function handleLogoUpload(user: MockUser, form: FormData): Promise<Result> {
  const denied = brandingDenied(user);
  if (denied) return denied;
  const file = form.get('file');
  if (!(file instanceof File)) return invalid([field('file', 'Required')]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(bytes);
  if (kind === 'svg' || kind === 'gif') return fail(415, 'file_unsupported', 'SVG and GIF logos are not accepted. Use a PNG, JPEG or WebP image.');
  if (!kind) return fail(415, 'file_unsupported', 'This file is not a PNG, JPEG or WebP image.');
  if (file.size > MB) return fail(413, 'file_too_large', 'The logo is larger than 1 MB.');
  if (kind === 'png' && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 16 || height < 16 || width > 4000 || height > 4000) {
      return invalid([field('file', 'The logo must be between 16 and 4,000 pixels wide and high.')], 'The logo must be between 16 and 4,000 pixels wide and high.');
    }
  }
  // The uploaded image itself, as a data URL: works offline and never points anywhere remote.
  user.logo_data_url = `data:image/${kind};base64,${toBase64(bytes)}`;
  return ok(brandOf(user));
}

export function routeLogoDelete(user: MockUser): Result {
  const denied = brandingDenied(user);
  if (denied) return denied;
  user.logo_data_url = null;
  return ok(brandOf(user));
}
