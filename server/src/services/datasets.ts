import type { SupabaseClient } from '@supabase/supabase-js';
import { notFound, throwIfDbError } from '../lib/errors.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { ColumnDataType, ColumnSemantic, Dataset, DatasetColumn, DatasetDetail, ParseOptions, SuggestedQuestion } from '../types/api.js';
import { placeholderFor } from './parsing/pii.js';

/** Database rows for datasets and dataset_columns, and their mapping to the contract's shapes. */

export interface DatasetRow {
  id: string;
  owner_id: string;
  workspace_id: string;
  name: string;
  original_filename: string;
  file_type: 'csv' | 'xlsx';
  size_bytes: number;
  storage_path: string;
  normalised_path: string | null;
  status: Dataset['status'];
  error_message: string | null;
  row_count: number | null;
  excluded_rows: number;
  sheet_names: string[];
  parse_options: ParseOptions;
  preamble_lines: string[];
  warnings: string[];
  suggestions: SuggestedQuestion[];
  expires_at: string | null;
  created_at: string;
}

export interface ColumnRow {
  id: string;
  dataset_id: string;
  owner_id: string;
  position: number;
  name: string;
  display_name: string | null;
  sql_name: string;
  data_type: ColumnDataType;
  semantic: ColumnSemantic;
  is_pii: boolean;
  vat_included: boolean | null;
  null_count: number;
  distinct_count: number;
  min_value: string | null;
  max_value: string | null;
  sample_values: string[];
}

export const DATASET_COLUMNS =
  'id, owner_id, workspace_id, name, original_filename, file_type, size_bytes, storage_path, normalised_path, status, error_message, row_count, excluded_rows, sheet_names, parse_options, preamble_lines, warnings, suggestions, expires_at, created_at';

export const COLUMN_COLUMNS =
  'id, dataset_id, owner_id, position, name, display_name, sql_name, data_type, semantic, is_pii, vat_included, null_count, distinct_count, min_value, max_value, sample_values';

export function toDataset(r: DatasetRow): Dataset {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    name: r.name,
    original_filename: r.original_filename,
    file_type: r.file_type,
    size_bytes: Number(r.size_bytes),
    row_count: r.row_count,
    status: r.status,
    error_message: r.error_message,
    warnings: r.warnings ?? [],
    expires_at: r.expires_at,
    created_at: r.created_at,
  };
}

/** A PII column's samples are placeholders, whatever is stored (defence in depth). */
export function toColumn(c: ColumnRow): DatasetColumn {
  return {
    id: c.id,
    position: c.position,
    name: c.name,
    display_name: c.display_name,
    sql_name: c.sql_name,
    data_type: c.data_type,
    semantic: c.semantic,
    is_pii: c.is_pii,
    vat_included: c.vat_included,
    null_count: c.null_count,
    distinct_count: c.distinct_count,
    min_value: c.is_pii ? null : c.min_value,
    max_value: c.is_pii ? null : c.max_value,
    sample_values: c.is_pii ? (c.sample_values ?? []).map(() => placeholderFor(c.semantic, c.name)) : (c.sample_values ?? []),
  };
}

const EMPTY_OPTIONS: Required<ParseOptions> = {
  sheet_name: null,
  header_row: null,
  delimiter: null,
  decimal_separator: null,
  date_format: null,
};

export function toDetail(r: DatasetRow, columns: ColumnRow[]): DatasetDetail {
  return {
    ...toDataset(r),
    columns: [...columns].sort((a, b) => a.position - b.position).map(toColumn),
    parse_options: { ...EMPTY_OPTIONS, ...(r.parse_options ?? {}) },
    sheet_names: r.sheet_names ?? [],
    preamble_lines: r.preamble_lines ?? [],
    excluded_rows: r.excluded_rows,
    suggestions: r.suggestions ?? [],
  };
}

/** The caller's dataset (RLS read with an owner filter), or 404. */
export async function getOwnDataset(db: SupabaseClient, userId: string, id: string): Promise<DatasetRow> {
  const { data, error } = await db
    .from('datasets')
    .select(DATASET_COLUMNS)
    .eq('id', id)
    .eq('owner_id', userId)
    .maybeSingle<DatasetRow>();
  throwIfDbError('datasets: read', error);
  if (!data) throw notFound('Dataset not found.');
  return data;
}

export async function getColumns(db: SupabaseClient, datasetId: string): Promise<ColumnRow[]> {
  const { data, error } = await db
    .from('dataset_columns')
    .select(COLUMN_COLUMNS)
    .eq('dataset_id', datasetId)
    .order('position', { ascending: true })
    .returns<ColumnRow[]>();
  throwIfDbError('dataset_columns: read', error);
  return data ?? [];
}

export async function getDetail(db: SupabaseClient, userId: string, id: string): Promise<DatasetDetail> {
  const row = await getOwnDataset(db, userId, id);
  return toDetail(row, await getColumns(db, id));
}

/** The plan limits that profiling needs, read with the service role (owner filter). */
export async function planFor(ownerId: string): Promise<{ max_rows: number; retention_days: number }> {
  const admin = supabaseAdmin();
  const { data: profile, error } = await admin.from('profiles').select('plan').eq('id', ownerId).single<{ plan: string }>();
  throwIfDbError('datasets: plan', error);
  const { data: limits, error: limitsError } = await admin
    .from('plan_limits')
    .select('max_rows, retention_days')
    .eq('plan', profile!.plan)
    .single<{ max_rows: number; retention_days: number }>();
  throwIfDbError('datasets: plan_limits', limitsError);
  return limits!;
}
