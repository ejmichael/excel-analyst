import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { AppError, notFound, throwIfDbError } from '../lib/errors.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { Plan, Report, ReportBlock, ReportDetail } from '../types/api.js';
import { BLOCK_COLUMNS, type BlockRow, toBlock } from './blocks.js';
import { buildBrand, watermarkFor } from './brand.js';

/**
 * Reports (slice S3): an ordered list of 1 to 30 of the owner's blocks, all from files in the report's workspace.
 * Writes go through two SQL functions (db/migrations/20261113_01_report_functions.sql) so a report and its blocks are
 * written in one transaction. Never logs titles, notes or headings.
 */

export const MAX_REPORT_BLOCKS = 30;
export const REPORT_LIMITS = { title: 120, subtitle: 200, period_label: 60, notes: 2000, heading_override: 120 } as const;

/** Optional text: trimmed; an empty string is stored as null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters.`)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();

const title = z.string().trim().min(1, 'Give the report a title.').max(REPORT_LIMITS.title, `At most ${REPORT_LIMITS.title} characters.`);

const distinct = (ids: string[]) => new Set(ids).size === ids.length;
const DUPLICATE = 'Each answer can appear only once in a report.';
const COUNT = `A report holds 1 to ${MAX_REPORT_BLOCKS} answers.`;

export const createReportBody = z.strictObject({
  workspace_id: z.uuid(),
  title,
  subtitle: optionalText(REPORT_LIMITS.subtitle),
  period_label: optionalText(REPORT_LIMITS.period_label),
  block_ids: z.array(z.uuid()).min(1, COUNT).max(MAX_REPORT_BLOCKS, COUNT).refine(distinct, DUPLICATE),
});
export type CreateReportBody = z.infer<typeof createReportBody>;

export const updateReportBody = z
  .strictObject({
    title: title.optional(),
    subtitle: optionalText(REPORT_LIMITS.subtitle),
    period_label: optionalText(REPORT_LIMITS.period_label),
    notes: optionalText(REPORT_LIMITS.notes),
    blocks: z
      .array(z.strictObject({ block_id: z.uuid(), heading_override: optionalText(REPORT_LIMITS.heading_override) }))
      .min(1, COUNT)
      .max(MAX_REPORT_BLOCKS, COUNT)
      .refine((list) => distinct(list.map((b) => b.block_id)), DUPLICATE)
      .optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Send at least one field to update.' });
export type UpdateReportBody = z.infer<typeof updateReportBody>;

// ---------- the workspace rule ----------

export const OTHER_WORKSPACE_MESSAGE =
  'Some of these answers come from a file in another workspace. A report can only hold answers from files in its own workspace.';
export const DELETED_FILE_MESSAGE =
  'Some of these answers come from a file that has been deleted, so we cannot check which workspace they belong to. Remove them from the report.';

export interface BlockPlacement {
  id: string;
  /** null when the block's dataset was deleted. */
  dataset_id: string | null;
  /** The workspace of the block's dataset (null when the dataset was deleted). */
  workspace_id: string | null;
}

/**
 * A bookkeeper's workspaces are their clients, so one client's numbers must never end up in another client's report.
 * A block whose dataset exists must be from a dataset in the report's workspace. A block whose dataset was deleted
 * cannot be checked: refused on create (`currentMembers` null), allowed on update only if already in the report.
 * `blocks` are in request order. Returns one refusal per refused block (its 0-based position in the request and the
 * user-facing message), in request order; empty when every block is allowed.
 */
export function workspaceRuleRefusals(
  blocks: BlockPlacement[],
  workspaceId: string,
  currentMembers: Set<string> | null,
): Array<{ index: number; message: string }> {
  return blocks.flatMap((b, index) => {
    if (b.dataset_id !== null && b.workspace_id !== workspaceId) return [{ index, message: OTHER_WORKSPACE_MESSAGE }];
    if (b.dataset_id === null && !currentMembers?.has(b.id)) return [{ index, message: DELETED_FILE_MESSAGE }];
    return [];
  });
}

/**
 * The 422 for the workspace rule: one details.fields entry per refused answer, with the path style of the validation
 * errors (`block_ids.<i>` on POST, `blocks.<i>.block_id` on PATCH). The top-level message is the other-workspace one
 * when any answer is from another workspace, otherwise the deleted-file one.
 */
function ruleFailure(refusals: Array<{ index: number; message: string }>, field: 'block_ids' | 'blocks'): AppError {
  const fields = refusals.map((r) => ({ location: 'body' as const, path: field === 'block_ids' ? `block_ids.${r.index}` : `blocks.${r.index}.block_id`, message: r.message }));
  const message = refusals.some((r) => r.message === OTHER_WORKSPACE_MESSAGE) ? OTHER_WORKSPACE_MESSAGE : DELETED_FILE_MESSAGE;
  return new AppError('validation_failed', message, { fields });
}

/**
 * Loads the caller's blocks (404 with no hint which, if any is not theirs) and applies the workspace rule.
 * `blockIds` are in request order; `path` names the body field in the 422 details.
 */
export async function assertBlocksAllowed(
  db: SupabaseClient,
  userId: string,
  blockIds: string[],
  workspaceId: string,
  currentMembers: Set<string> | null,
  path: 'block_ids' | 'blocks',
): Promise<void> {
  const { data: blocks, error } = await db
    .from('blocks')
    .select('id, dataset_id')
    .eq('owner_id', userId)
    .in('id', blockIds)
    .returns<Array<{ id: string; dataset_id: string | null }>>();
  throwIfDbError('reports: blocks', error);
  if ((blocks ?? []).length !== blockIds.length) throw notFound('Answer not found.');

  const datasetIds = [...new Set((blocks ?? []).map((b) => b.dataset_id).filter((d): d is string => d !== null))];
  const workspaceOf = new Map<string, string>();
  if (datasetIds.length > 0) {
    const { data: datasets, error: dsError } = await db
      .from('datasets')
      .select('id, workspace_id')
      .eq('owner_id', userId)
      .in('id', datasetIds)
      .returns<Array<{ id: string; workspace_id: string }>>();
    throwIfDbError('reports: datasets', dsError);
    for (const d of datasets ?? []) workspaceOf.set(d.id, d.workspace_id);
  }
  // In request order, so each refusal carries the answer's position in the request.
  const byId = new Map((blocks ?? []).map((b) => [b.id, b]));
  const placements = blockIds.map((id) => {
    const b = byId.get(id)!;
    return { id, dataset_id: b.dataset_id, workspace_id: b.dataset_id ? (workspaceOf.get(b.dataset_id) ?? null) : null };
  });
  const refusals = workspaceRuleRefusals(placements, workspaceId, currentMembers);
  if (refusals.length > 0) throw ruleFailure(refusals, path);
}

// ---------- reads ----------

export interface ReportRow {
  id: string;
  owner_id: string;
  workspace_id: string;
  title: string;
  subtitle: string | null;
  period_label: string | null;
  notes: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

export const REPORT_COLUMNS = 'id, owner_id, workspace_id, title, subtitle, period_label, notes, template_id, created_at, updated_at';

export function toReport(r: ReportRow, blockCount: number): Report {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    title: r.title,
    subtitle: r.subtitle,
    period_label: r.period_label,
    notes: r.notes,
    template_id: r.template_id,
    block_count: blockCount,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** The caller's report (RLS read with an owner filter), or 404. */
export async function getOwnReport(db: SupabaseClient, userId: string, id: string): Promise<ReportRow> {
  const { data, error } = await db.from('reports').select(REPORT_COLUMNS).eq('id', id).eq('owner_id', userId).maybeSingle<ReportRow>();
  throwIfDbError('reports: read', error);
  if (!data) throw notFound('Report not found.');
  return data;
}

interface MemberRow {
  block_id: string;
  position: number;
  heading_override: string | null;
}

export async function getMembers(db: SupabaseClient, userId: string, reportId: string): Promise<MemberRow[]> {
  const { data, error } = await db
    .from('report_blocks')
    .select('block_id, position, heading_override')
    .eq('owner_id', userId)
    .eq('report_id', reportId)
    .order('position', { ascending: true })
    .returns<MemberRow[]>();
  throwIfDbError('reports: members', error);
  return data ?? [];
}

interface ProfileBrandRow {
  plan: Plan;
  business_name: string | null;
  brand_color: string;
  brand_logo_path: string | null;
}

/** ReportDetail: the report, the owner's current brand (fresh signed logo URL), watermark, blocks in position order. */
export async function buildReportDetail(db: SupabaseClient, userId: string, report: ReportRow): Promise<ReportDetail> {
  const members = await getMembers(db, userId, report.id);
  const [blocks, profile] = await Promise.all([
    members.length === 0
      ? Promise.resolve({ data: [] as BlockRow[], error: null })
      : db
          .from('blocks')
          .select(BLOCK_COLUMNS)
          .eq('owner_id', userId)
          .in(
            'id',
            members.map((m) => m.block_id),
          )
          .returns<BlockRow[]>(),
    db.from('profiles').select('plan, business_name, brand_color, brand_logo_path').eq('id', userId).single<ProfileBrandRow>(),
  ]);
  throwIfDbError('reports: blocks', blocks.error);
  throwIfDbError('reports: profile', profile.error);
  const byId = new Map((blocks.data ?? []).map((b) => [b.id, b]));
  const items: ReportBlock[] = members.flatMap((m) => {
    const row = byId.get(m.block_id);
    return row ? [{ position: m.position, heading_override: m.heading_override, block: toBlock(row) }] : [];
  });
  return {
    ...toReport(report, items.length),
    brand: await buildBrand(profile.data!),
    watermark: watermarkFor(profile.data!.plan),
    blocks: items,
    comparison: null, // month-on-month comparison arrives with templates (S5)
  };
}

// ---------- writes (service role, owner-filtered inside the SQL functions) ----------

/** Maps the SQL functions' own errors: a block that is not the owner's (or vanished meanwhile) is 404. */
function rpcError(op: string, error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (error.code === 'P0002' || error.code === '23503') throw notFound('Answer not found.');
  throwIfDbError(op, error);
}

export async function createReport(userId: string, body: CreateReportBody): Promise<string> {
  const { data, error } = await supabaseAdmin().rpc('create_report_with_blocks', {
    p_owner_id: userId,
    p_workspace_id: body.workspace_id,
    p_title: body.title,
    p_subtitle: body.subtitle ?? null,
    p_period_label: body.period_label ?? null,
    p_block_ids: body.block_ids,
  });
  rpcError('reports: create', error);
  return data as string;
}

export async function updateReport(userId: string, reportId: string, body: UpdateReportBody): Promise<boolean> {
  const fields: Record<string, string | null> = {};
  for (const key of ['title', 'subtitle', 'period_label', 'notes'] as const) {
    if (body[key] !== undefined) fields[key] = body[key] ?? null;
  }
  const blocks = body.blocks?.map((b) => ({ block_id: b.block_id, heading_override: b.heading_override ?? null })) ?? null;
  const { data, error } = await supabaseAdmin().rpc('update_report_with_blocks', {
    p_owner_id: userId,
    p_report_id: reportId,
    p_fields: fields,
    p_blocks: blocks,
  });
  rpcError('reports: update', error);
  return data === true;
}
