import type { SupabaseClient } from '@supabase/supabase-js';
import { throwIfDbError } from '../lib/errors.js';
import type { Usage } from '../types/api.js';
import { monthStartSast } from './dates.js';

interface UsageMonthRow {
  uploads: number;
  questions: number;
  reports: number;
  report_runs: number;
  exports: number;
}

async function countOwned(client: SupabaseClient, table: string, userId: string): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId);
  throwIfDbError(`usage: count ${table}`, error);
  return count ?? 0;
}

/**
 * Usage for the current SAST month. Monthly counters come from the owner_usage_month view
 * (zeros when the user has no events this month); workspaces and templates are current row counts.
 * Pass the user's client so RLS applies (the view is security_invoker).
 */
export async function getUsage(client: SupabaseClient, userId: string, now: Date = new Date()): Promise<Usage> {
  const [month, workspaces, templates] = await Promise.all([
    client
      .from('owner_usage_month')
      .select('uploads, questions, reports, report_runs, exports')
      .eq('owner_id', userId)
      .maybeSingle<UsageMonthRow>(),
    countOwned(client, 'workspaces', userId),
    countOwned(client, 'report_templates', userId),
  ]);
  throwIfDbError('usage: month', month.error);
  const m = month.data;
  return {
    month_start: monthStartSast(now),
    uploads: Number(m?.uploads ?? 0),
    questions: Number(m?.questions ?? 0),
    reports: Number(m?.reports ?? 0),
    report_runs: Number(m?.report_runs ?? 0),
    exports: Number(m?.exports ?? 0),
    workspaces,
    templates,
  };
}
