import type { LimitKey, Plan, PlanLimitDetails } from '@/api/types';
import { formatNumber } from '@/lib/format';
import { PLAN_LABELS } from '@/lib/errors';

const plural = (n: number, one: string, many: string) => `${formatNumber(n, 0)} ${n === 1 ? one : many}`;

// Count limits: [singular, plural, "per month" suffix or ''].
const COUNTED: Partial<Record<LimitKey, [string, string, string]>> = {
  max_workspaces: ['workspace', 'workspaces', ''],
  max_datasets_per_month: ['upload', 'uploads', ' a month'],
  max_questions_per_month: ['question', 'questions', ' a month'],
  max_reports_per_month: ['report', 'reports', ' a month'],
  max_templates: ['saved template', 'saved templates', ''],
};

const FEATURES: Partial<Record<LimitKey, string>> = {
  branding: 'Your own logo and brand colour are',
  share_links: 'Share links are',
};

/** The plain-words sentence for what was hit, e.g. "Your Free plan includes 1 workspace. You are using 1." */
export function describePlanLimit(details: PlanLimitDetails, plan: Plan): string {
  const planName = `Your ${PLAN_LABELS[plan]} plan`;
  const { limit_key: key, limit, used } = details;

  const feature = FEATURES[key];
  if (feature) return `${feature} not included in your ${PLAN_LABELS[plan]} plan.`;

  const counted = COUNTED[key];
  if (counted) {
    const [one, many, period] = counted;
    if (limit === 0) return `${planName} does not include ${many}.`;
    const usage = period ? `You have used ${formatNumber(used, 0)} this month.` : `You are using ${formatNumber(used, 0)}.`;
    return `${planName} includes ${plural(limit, one, many)}${period}. ${usage}`;
  }

  if (key === 'max_rows') {
    return `${planName} allows files of up to ${plural(limit, 'row', 'rows')}. This file has ${formatNumber(used, 0)}.`;
  }
  if (key === 'max_file_mb') {
    return `${planName} allows files of up to ${formatNumber(limit)} MB.`;
  }
  return `You have reached a limit of your ${PLAN_LABELS[plan]} plan.`;
}

export function describeUpgrade(upgradeTo: Plan | null): string {
  return upgradeTo
    ? `The ${PLAN_LABELS[upgradeTo]} plan includes more.`
    : 'No plan includes more of this at the moment.';
}
