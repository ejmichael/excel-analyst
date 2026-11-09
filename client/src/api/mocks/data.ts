import type { Me, Plan, PlanLimits, Usage, Workspace } from '../types';

/** Mirrors the plan_limits seed in db/schema.sql. */
export const MOCK_PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    plan: 'free',
    price_zar: 0,
    max_workspaces: 1,
    max_datasets_per_month: 3,
    max_questions_per_month: 20,
    max_reports_per_month: 1,
    max_rows: 20000,
    max_file_mb: 5,
    max_templates: 0,
    branding: false,
    share_links: false,
    white_label: false,
    retention_days: 30,
  },
  solo: {
    plan: 'solo',
    price_zar: 249,
    max_workspaces: 1,
    max_datasets_per_month: 20,
    max_questions_per_month: 300,
    max_reports_per_month: 20,
    max_rows: 100000,
    max_file_mb: 25,
    max_templates: 5,
    branding: true,
    share_links: true,
    white_label: false,
    retention_days: 90,
  },
  practice: {
    plan: 'practice',
    price_zar: 749,
    max_workspaces: 10,
    max_datasets_per_month: 150,
    max_questions_per_month: 2000,
    max_reports_per_month: 150,
    max_rows: 200000,
    max_file_mb: 25,
    max_templates: 50,
    branding: true,
    share_links: true,
    white_label: false,
    retention_days: 180,
  },
  practice_plus: {
    plan: 'practice_plus',
    price_zar: 1749,
    max_workspaces: 30,
    max_datasets_per_month: 500,
    max_questions_per_month: 6000,
    max_reports_per_month: 500,
    max_rows: 200000,
    max_file_mb: 50,
    max_templates: 200,
    branding: true,
    share_links: true,
    white_label: true,
    retention_days: 365,
  },
};

const PLAN_ORDER: Plan[] = ['free', 'solo', 'practice', 'practice_plus'];

/** The cheapest plan whose limit allows `needed` (or the feature), as the server computes upgrade_to. */
export function cheapestPlanAllowing(check: (limits: PlanLimits) => boolean): Plan | null {
  return PLAN_ORDER.find((plan) => check(MOCK_PLAN_LIMITS[plan])) ?? null;
}

export interface MockUser {
  user_id: string;
  email: string;
  password: string;
  full_name: string | null;
  business_name: string | null;
  plan: Plan;
  brand_color: string;
  popia_consent_at: string | null;
  workspaces: Workspace[];
}

/** First day of the current month in SAST (UTC+2, no DST), as YYYY-MM-DD. */
export function sastMonthStart(now = new Date()): string {
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return `${sast.getUTCFullYear()}-${String(sast.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** ISO timestamp with the SAST offset, like the server returns. */
export function sastTimestamp(now = new Date()): string {
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return sast.toISOString().replace('Z', '+02:00');
}

export function buildMe(user: MockUser): Me {
  const usage: Usage = {
    month_start: sastMonthStart(),
    uploads: 0,
    questions: 0,
    reports: 0,
    report_runs: 0,
    exports: 0,
    workspaces: user.workspaces.length,
    templates: 0,
  };
  return {
    user_id: user.user_id,
    email: user.email,
    full_name: user.full_name,
    business_name: user.business_name,
    plan: user.plan,
    consent_accepted: user.popia_consent_at !== null,
    brand: { business_name: user.business_name, logo_url: null, color: user.brand_color },
    limits: MOCK_PLAN_LIMITS[user.plan],
    usage,
    subscription: null,
  };
}

export function newMockUser(email: string, password: string): MockUser {
  return {
    user_id: crypto.randomUUID(),
    email,
    password,
    full_name: null,
    business_name: null,
    plan: 'free',
    brand_color: '#1E7A5F',
    popia_consent_at: null,
    // Same as the DB trigger: every new user gets one default workspace.
    workspaces: [{ id: crypto.randomUUID(), name: 'My workspace', is_default: true, created_at: sastTimestamp() }],
  };
}
