import type { SupabaseClient } from '@supabase/supabase-js';
import { throwIfDbError } from '../../lib/errors.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import type { Dashboard, DashboardFilter, DashboardReading, DashboardStatus, DashboardWidget } from '../../types/api.js';

/**
 * One dashboard per dataset (table dashboards, db/migrations/20261120_01_dashboards.sql). The plan (reading, filters,
 * widgets) is stored; widget results never are. Reads use the owner's RLS client; writes the service role, filtered by
 * owner_id. Keyed by dataset id, so a cleaned copy of a file (a new dataset) gets its own dashboard.
 */

/** A run left planning this long (for example by a restart) is read as failed, so the client never polls forever. */
export const STALE_PLANNING_MS = 3 * 60_000;
export const STALE_MESSAGE = 'Building this dashboard did not finish. Please try again.';

export interface DashboardPlan {
  reading: DashboardReading;
  filters: DashboardFilter[];
  widgets: DashboardWidget[];
}

export const EMPTY_PLAN: DashboardPlan = { reading: { text: '', date_column: null }, filters: [], widgets: [] };

export interface DashboardRow {
  id: string;
  owner_id: string;
  dataset_id: string;
  status: DashboardStatus;
  fallback: boolean;
  error_message: string | null;
  plan: DashboardPlan;
  created_at: string;
  updated_at: string;
}

export const DASHBOARD_COLUMNS = 'id, owner_id, dataset_id, status, fallback, error_message, plan, created_at, updated_at';

export function toDashboard(r: DashboardRow): Dashboard {
  return {
    id: r.id,
    dataset_id: r.dataset_id,
    status: r.status,
    error_message: r.error_message,
    fallback: r.fallback,
    reading: r.plan.reading,
    filters: r.plan.filters,
    widgets: r.plan.widgets,
    created_at: r.created_at,
  };
}

/** Measured from created_at, which every (re)start of planning sets and nothing else touches while it runs. */
export const isStale = (r: Pick<DashboardRow, 'status' | 'created_at'>, now = Date.now()) =>
  r.status === 'planning' && now - Date.parse(r.created_at) > STALE_PLANNING_MS;

/**
 * The caller's dashboard for a dataset, or null. A stale planning run is marked failed first (only if it is still
 * planning, so a run that just finished is never overwritten).
 */
export async function readDashboard(db: SupabaseClient, userId: string, datasetId: string): Promise<DashboardRow | null> {
  const { data, error } = await db.from('dashboards').select(DASHBOARD_COLUMNS).eq('dataset_id', datasetId).eq('owner_id', userId).maybeSingle<DashboardRow>();
  throwIfDbError('dashboards: read', error);
  if (!data || !isStale(data)) return data;
  const { data: failed, error: uError } = await supabaseAdmin()
    .from('dashboards')
    .update({ status: 'failed', error_message: STALE_MESSAGE })
    .eq('id', data.id)
    .eq('owner_id', userId)
    .eq('status', 'planning')
    .select(DASHBOARD_COLUMNS)
    .maybeSingle<DashboardRow>();
  throwIfDbError('dashboards: mark stale', uError);
  return failed ?? (await readDashboard(db, userId, datasetId));
}

/**
 * Starts (or restarts) planning: a dashboard already planning is returned unchanged with started false; a ready or
 * failed one is replaced (same row, reset); otherwise a new row is made. A race with another request for the same
 * dataset ends with one planning row (dataset_id is unique; the update only moves a row that is not planning).
 */
export async function beginPlanning(db: SupabaseClient, userId: string, datasetId: string): Promise<{ row: DashboardRow; started: boolean }> {
  const existing = await readDashboard(db, userId, datasetId);
  if (existing?.status === 'planning') return { row: existing, started: false };
  const admin = supabaseAdmin();
  const reset = { status: 'planning', fallback: false, error_message: null, plan: EMPTY_PLAN, created_at: new Date().toISOString() };
  if (existing) {
    const { data, error } = await admin
      .from('dashboards')
      .update(reset)
      .eq('id', existing.id)
      .eq('owner_id', userId)
      .neq('status', 'planning')
      .select(DASHBOARD_COLUMNS)
      .maybeSingle<DashboardRow>();
    throwIfDbError('dashboards: restart', error);
    if (data) return { row: data, started: true };
  } else {
    const { data, error } = await admin.from('dashboards').insert({ owner_id: userId, dataset_id: datasetId, ...reset }).select(DASHBOARD_COLUMNS).single<DashboardRow>();
    if (!error) return { row: data!, started: true };
    if (error.code !== '23505') throwIfDbError('dashboards: insert', error);
  }
  // Another request started it in the meantime.
  return { row: (await readDashboard(db, userId, datasetId))!, started: false };
}

/**
 * Saves the outcome of a planning run, only while that run is still the planning one: a restart resets created_at,
 * so a run that was replaced in the meantime never overwrites the new one.
 */
export async function finishPlanning(
  row: Pick<DashboardRow, 'id' | 'owner_id' | 'created_at'>,
  outcome: { status: 'ready' | 'failed'; fallback: boolean; error_message: string | null; plan: DashboardPlan },
): Promise<void> {
  const { error } = await supabaseAdmin().from('dashboards').update(outcome).eq('id', row.id).eq('owner_id', row.owner_id).eq('created_at', row.created_at).eq('status', 'planning');
  throwIfDbError('dashboards: finish', error);
}
