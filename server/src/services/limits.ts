import { planLimit, throwIfDbError } from '../lib/errors.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { LimitKey, Plan, PlanLimitDetails, PlanLimits } from '../types/api.js';
import { monthStartSastInstant } from './dates.js';

type CountedKey = 'max_workspaces' | 'max_templates';
type MonthlyKey = 'max_datasets_per_month' | 'max_questions_per_month' | 'max_reports_per_month';
type PerFileKey = 'max_rows' | 'max_file_mb';
type FlagKey = 'branding' | 'share_links';

/** usage_events.kind counted against each monthly limit. */
export const MONTHLY_USAGE_KIND: Record<MonthlyKey, 'upload' | 'question' | 'report'> = {
  max_datasets_per_month: 'upload',
  max_questions_per_month: 'question',
  max_reports_per_month: 'report',
};

/** Where limit checks read from. The default uses the service-role client, always filtered by owner_id. */
export interface LimitsDataSource {
  getPlan(userId: string): Promise<Plan>;
  getAllPlanLimits(): Promise<PlanLimits[]>;
  countRows(userId: string, table: 'workspaces' | 'report_templates'): Promise<number>;
  countUsageSince(userId: string, kind: 'upload' | 'question' | 'report', since: string): Promise<number>;
}

const COUNTED_TABLE: Record<CountedKey, 'workspaces' | 'report_templates'> = {
  max_workspaces: 'workspaces',
  max_templates: 'report_templates',
};

const isCounted = (k: LimitKey): k is CountedKey => k in COUNTED_TABLE;
const isMonthly = (k: LimitKey): k is MonthlyKey => k in MONTHLY_USAGE_KIND;
const isPerFile = (k: LimitKey): k is PerFileKey => k === 'max_rows' || k === 'max_file_mb';
const isFlag = (k: LimitKey): k is FlagKey => k === 'branding' || k === 'share_links';

/** Cheapest plan other than `current` whose limits pass `allows`, or null if none does. */
export function cheapestPlanAllowing(
  all: PlanLimits[],
  current: Plan,
  allows: (limits: PlanLimits) => boolean,
): Plan | null {
  const candidates = all.filter((l) => l.plan !== current && allows(l)).sort((a, b) => a.price_zar - b.price_zar);
  return candidates[0]?.plan ?? null;
}

/**
 * Throws 402 plan_limit with PlanLimitDetails when the action would exceed the user's plan.
 * - Counted (max_workspaces, max_templates): current row count must be below the limit.
 * - Monthly (datasets, questions, reports): this SAST month's usage_events must be below the limit.
 * - Per-file (max_rows, max_file_mb): pass `value` (rows, or MB); it must not exceed the limit.
 * - Flags (branding, share_links): throw when false, with limit 0.
 */
export function createAssertWithinLimit(ds: LimitsDataSource) {
  return async function assertWithinLimit(userId: string, key: LimitKey, value?: number): Promise<void> {
    const [plan, all] = await Promise.all([ds.getPlan(userId), ds.getAllPlanLimits()]);
    const limits = all.find((l) => l.plan === plan);
    if (!limits) throw new Error(`plan_limits has no row for plan ${plan}`);

    let details: PlanLimitDetails | null = null;
    if (isFlag(key)) {
      if (!limits[key]) {
        details = { limit_key: key, limit: 0, used: 0, upgrade_to: cheapestPlanAllowing(all, plan, (l) => l[key]) };
      }
    } else if (isPerFile(key)) {
      if (value === undefined) throw new Error(`assertWithinLimit(${key}) needs a value`);
      if (value > limits[key]) {
        details = { limit_key: key, limit: limits[key], used: value, upgrade_to: cheapestPlanAllowing(all, plan, (l) => value <= l[key]) };
      }
    } else {
      const used = isCounted(key)
        ? await ds.countRows(userId, COUNTED_TABLE[key])
        : isMonthly(key)
          ? await ds.countUsageSince(userId, MONTHLY_USAGE_KIND[key], monthStartSastInstant())
          : 0;
      if (used >= limits[key]) {
        details = { limit_key: key, limit: limits[key], used, upgrade_to: cheapestPlanAllowing(all, plan, (l) => used < l[key]) };
      }
    }
    if (details) throw planLimit(details);
  };
}

export function toPlanLimits(row: Record<string, unknown>): PlanLimits {
  return {
    plan: row.plan as Plan,
    price_zar: Number(row.price_zar),
    max_workspaces: Number(row.max_workspaces),
    max_datasets_per_month: Number(row.max_datasets_per_month),
    max_questions_per_month: Number(row.max_questions_per_month),
    max_reports_per_month: Number(row.max_reports_per_month),
    max_rows: Number(row.max_rows),
    max_file_mb: Number(row.max_file_mb),
    max_templates: Number(row.max_templates),
    branding: Boolean(row.branding),
    share_links: Boolean(row.share_links),
    white_label: Boolean(row.white_label),
    retention_days: Number(row.retention_days),
  };
}

export const supabaseLimitsDataSource: LimitsDataSource = {
  async getPlan(userId) {
    const { data, error } = await supabaseAdmin()
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single<{ plan: Plan }>();
    throwIfDbError('limits: plan', error);
    return data!.plan;
  },
  async getAllPlanLimits() {
    const { data, error } = await supabaseAdmin().from('plan_limits').select('*');
    throwIfDbError('limits: plan_limits', error);
    return (data ?? []).map(toPlanLimits);
  },
  async countRows(userId, table) {
    const { count, error } = await supabaseAdmin()
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId);
    throwIfDbError(`limits: count ${table}`, error);
    return count ?? 0;
  },
  async countUsageSince(userId, kind, since) {
    const { count, error } = await supabaseAdmin()
      .from('usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .eq('kind', kind)
      .gte('created_at', since);
    throwIfDbError('limits: count usage', error);
    return count ?? 0;
  },
};

export const assertWithinLimit = createAssertWithinLimit(supabaseLimitsDataSource);
