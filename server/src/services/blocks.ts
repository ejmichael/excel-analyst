import type { SupabaseClient } from '@supabase/supabase-js';
import { notFound, throwIfDbError } from '../lib/errors.js';
import type { Block, BlockCheck, BlockSource, BlockStatus, CellValue, ChartSpec, ResultColumn } from '../types/api.js';

/** Database rows for blocks and their mapping to the contract's Block. */

export interface BlockRow {
  id: string;
  owner_id: string;
  dataset_id: string | null;
  question: string;
  title: string;
  sql: string;
  source_filter_sql: string | null;
  columns: ResultColumn[];
  rows: Array<Record<string, CellValue>>;
  row_count: number;
  truncated: boolean;
  chart: ChartSpec;
  reconcile: { column: string; aggregation: 'sum' | 'count'; total_sql: string } | null;
  narrative_template: string;
  narrative: string;
  follow_ups: string[];
  checks: BlockCheck[];
  status: BlockStatus;
  source: BlockSource;
  model: string | null;
  created_at: string;
}

export const BLOCK_COLUMNS =
  'id, owner_id, dataset_id, question, title, sql, source_filter_sql, columns, rows, row_count, truncated, chart, reconcile, narrative_template, narrative, follow_ups, checks, status, source, model, created_at';

/** has_source_rows: a source filter exists and the dataset still exists (API_CONTRACT, Block). */
export function toBlock(r: BlockRow): Block {
  return {
    id: r.id,
    dataset_id: r.dataset_id,
    question: r.question,
    title: r.title,
    sql: r.sql,
    columns: r.columns,
    rows: r.rows,
    row_count: r.row_count,
    truncated: r.truncated,
    chart: r.chart,
    narrative: r.narrative,
    follow_ups: r.follow_ups ?? [],
    checks: r.checks ?? [],
    status: r.status,
    source: r.source,
    has_source_rows: Boolean(r.source_filter_sql) && r.dataset_id !== null,
    created_at: r.created_at,
  };
}

/** The caller's block (RLS read with an owner filter), or 404. */
export async function getOwnBlock(db: SupabaseClient, userId: string, id: string): Promise<BlockRow> {
  const { data, error } = await db.from('blocks').select(BLOCK_COLUMNS).eq('id', id).eq('owner_id', userId).maybeSingle<BlockRow>();
  throwIfDbError('blocks: read', error);
  if (!data) throw notFound('Answer not found.');
  return data;
}
