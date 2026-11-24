import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { env } from '../config/env.js';
import { throwIfDbError } from '../lib/errors.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { Block, CellValue, PublicBlock, PublicReport, ReportDetail, ShareLink } from '../types/api.js';
import { type PromptColumn, resultMasks } from './analysis/prompts.js';

/**
 * Share links (slice S4). The token is a password: it is returned only in the creation response and the owner's list
 * and DELETE response, and never logged (log the link id). Public reads go through the service role.
 */

/** 32 random bytes, base64url: 43 characters (the database requires at least 32). */
export const newToken = () => randomBytes(32).toString('base64url');

export const createShareLinkBody = z.strictObject({
  expires_in_days: z.union([z.literal(7), z.literal(30), z.literal(90)]).nullable().optional(),
  show_working: z.boolean().optional(),
});
export type CreateShareLinkBody = z.infer<typeof createShareLinkBody>;

export interface ShareLinkRow {
  id: string;
  owner_id: string;
  report_id: string;
  token: string;
  show_working: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  created_at: string;
}

export const SHARE_COLUMNS = 'id, owner_id, report_id, token, show_working, expires_at, revoked_at, view_count, created_at';

export function toShareLink(r: ShareLinkRow, containsPersonalData: boolean): ShareLink {
  return {
    id: r.id,
    report_id: r.report_id,
    token: r.token,
    url: `${env().CLIENT_URL.replace(/\/+$/, '')}/r/${r.token}`,
    show_working: r.show_working,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    view_count: r.view_count,
    contains_personal_data: containsPersonalData,
    created_at: r.created_at,
  };
}

/** A link is valid while it is not revoked and not expired. */
export const isLive = (r: Pick<ShareLinkRow, 'revoked_at' | 'expires_at'>, now = Date.now()) =>
  r.revoked_at === null && (r.expires_at === null || Date.parse(r.expires_at) > now);

/** True when the report has a link that still opens (not revoked, not expired). */
export async function hasLiveShareLink(db: SupabaseClient, ownerId: string, reportId: string): Promise<boolean> {
  const { data, error } = await db
    .from('share_links')
    .select('revoked_at, expires_at')
    .eq('owner_id', ownerId)
    .eq('report_id', reportId)
    .is('revoked_at', null)
    .returns<Array<Pick<ShareLinkRow, 'revoked_at' | 'expires_at'>>>();
  throwIfDbError('share links: live check', error);
  return (data ?? []).some((r) => isLive(r));
}

// ---------- contains_personal_data ----------

type PiiColumn = Pick<PromptColumn, 'name' | 'sql_name' | 'semantic' | 'is_pii'>;

/**
 * Best-effort, never a guarantee: true when any block's result column is (or is named like) a dataset column marked
 * is_pii, or a stored value matches the email, SA mobile or SA ID detectors (the same rules that mask results for the
 * narrator). A block whose dataset was deleted is checked by its column names and values only.
 */
export function blocksContainPersonalData(
  blocks: Array<Pick<Block, 'columns' | 'rows' | 'dataset_id'>>,
  columnsByDataset: Map<string, PiiColumn[]>,
): boolean {
  return blocks.some((b) => {
    const dataset = b.dataset_id ? (columnsByDataset.get(b.dataset_id) ?? []) : [];
    const rows = b.rows as Array<Record<string, CellValue>>;
    return resultMasks(b.columns.map((c) => c.name), rows, dataset as PromptColumn[]).size > 0;
  });
}

/** contains_personal_data for one report, read with the given client (the owner's RLS client). */
export async function reportContainsPersonalData(db: SupabaseClient, ownerId: string, reportId: string): Promise<boolean> {
  const { data: members, error } = await db.from('report_blocks').select('block_id').eq('owner_id', ownerId).eq('report_id', reportId);
  throwIfDbError('share-links: members', error);
  const ids = (members ?? []).map((m) => m.block_id as string);
  if (ids.length === 0) return false;
  const { data: blocks, error: bError } = await db
    .from('blocks')
    .select('columns, rows, dataset_id')
    .eq('owner_id', ownerId)
    .in('id', ids)
    .returns<Array<Pick<Block, 'columns' | 'rows' | 'dataset_id'>>>();
  throwIfDbError('share-links: blocks', bError);
  const datasetIds = [...new Set((blocks ?? []).map((b) => b.dataset_id).filter((d): d is string => d !== null))];
  const byDataset = new Map<string, PiiColumn[]>();
  if (datasetIds.length > 0) {
    const { data: cols, error: cError } = await db
      .from('dataset_columns')
      .select('dataset_id, name, sql_name, semantic, is_pii')
      .eq('owner_id', ownerId)
      .in('dataset_id', datasetIds)
      .returns<Array<PiiColumn & { dataset_id: string }>>();
    throwIfDbError('share-links: columns', cError);
    for (const c of cols ?? []) byDataset.set(c.dataset_id, [...(byDataset.get(c.dataset_id) ?? []), c]);
  }
  return blocksContainPersonalData(blocks ?? [], byDataset);
}

// ---------- the public report ----------

/**
 * The public shape, built field by field (never by spreading), so nothing new on ReportDetail or Block can leak:
 * no owner, workspace, template or dataset id; sql and checks only with show_working; has_source_rows always false.
 */
export function toPublicReport(detail: ReportDetail, showWorking: boolean, logoUrl: string | null): PublicReport {
  return {
    id: detail.id,
    title: detail.title,
    subtitle: detail.subtitle,
    period_label: detail.period_label,
    notes: detail.notes,
    block_count: detail.block_count,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    brand: { business_name: detail.brand.business_name, logo_url: logoUrl, color: detail.brand.color },
    watermark: detail.watermark,
    comparison: detail.comparison,
    blocks: detail.blocks.map((rb) => {
      const b = rb.block;
      const block: PublicBlock = {
        id: b.id,
        question: b.question,
        title: b.title,
        sql: showWorking ? b.sql : '',
        columns: b.columns,
        rows: b.rows,
        row_count: b.row_count,
        truncated: b.truncated,
        chart: b.chart,
        narrative: b.narrative,
        follow_ups: b.follow_ups,
        checks: showWorking ? b.checks : [],
        // Kept even when the checks are hidden, so the public page can still say the answer needs a closer look.
        status: b.status,
        source: b.source,
        has_source_rows: false,
        filters: b.filters,
        created_at: b.created_at,
      };
      return { position: rb.position, heading_override: rb.heading_override, block };
    }),
  };
}

/** Increments view_count by one (read-modify-write; a lost increment under heavy concurrency is acceptable). */
export async function countView(link: ShareLinkRow): Promise<void> {
  const { error } = await supabaseAdmin().from('share_links').update({ view_count: link.view_count + 1 }).eq('id', link.id);
  throwIfDbError('share-links: view count', error);
}
