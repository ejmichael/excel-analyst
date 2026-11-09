import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { createAssertWithinLimit, type LimitsDataSource } from '../../src/services/limits.js';
import type { LimitKey, Plan, PlanLimits } from '../../src/types/api.js';

// Same values as the seed rows in db/schema.sql.
const PLANS: PlanLimits[] = [
  { plan: 'free', price_zar: 0, max_workspaces: 1, max_datasets_per_month: 3, max_questions_per_month: 20, max_reports_per_month: 1, max_rows: 20000, max_file_mb: 5, max_templates: 0, branding: false, share_links: false, white_label: false, retention_days: 30 },
  { plan: 'solo', price_zar: 249, max_workspaces: 1, max_datasets_per_month: 20, max_questions_per_month: 300, max_reports_per_month: 20, max_rows: 100000, max_file_mb: 25, max_templates: 5, branding: true, share_links: true, white_label: false, retention_days: 90 },
  { plan: 'practice', price_zar: 749, max_workspaces: 10, max_datasets_per_month: 150, max_questions_per_month: 2000, max_reports_per_month: 150, max_rows: 200000, max_file_mb: 25, max_templates: 50, branding: true, share_links: true, white_label: false, retention_days: 180 },
  { plan: 'practice_plus', price_zar: 1749, max_workspaces: 30, max_datasets_per_month: 500, max_questions_per_month: 6000, max_reports_per_month: 500, max_rows: 200000, max_file_mb: 50, max_templates: 200, branding: true, share_links: true, white_label: true, retention_days: 365 },
];

interface Fake {
  plan: Plan;
  workspaces?: number;
  report_templates?: number;
  upload?: number;
  question?: number;
  report?: number;
}

function source(f: Fake): LimitsDataSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getPlan: async () => f.plan,
    // Unsorted on purpose: upgrade_to must pick by price, not row order.
    getAllPlanLimits: async () => [PLANS[3]!, PLANS[1]!, PLANS[0]!, PLANS[2]!],
    countRows: async (_u, table) => {
      calls.push(table);
      return f[table] ?? 0;
    },
    countUsageSince: async (_u, kind, since) => {
      calls.push(`${kind}@${since}`);
      return f[kind] ?? 0;
    },
  };
}

async function failure(f: Fake, key: LimitKey, value?: number) {
  try {
    await createAssertWithinLimit(source(f))('u1', key, value);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect(e.status).toBe(402);
    expect(e.code).toBe('plan_limit');
    return e.details;
  }
  throw new Error('expected a plan_limit error');
}

const passes = (f: Fake, key: LimitKey, value?: number) =>
  expect(createAssertWithinLimit(source(f))('u1', key, value)).resolves.toBeUndefined();

describe('assertWithinLimit: counted limits', () => {
  it('allows the first extra workspace below the limit', async () => {
    await passes({ plan: 'practice', workspaces: 9 }, 'max_workspaces');
  });

  it('refuses a second workspace on free, upgrading past solo (also 1) to practice', async () => {
    expect(await failure({ plan: 'free', workspaces: 1 }, 'max_workspaces')).toEqual({
      limit_key: 'max_workspaces',
      limit: 1,
      used: 1,
      upgrade_to: 'practice',
    });
  });

  it('suggests no upgrade when the top plan is full', async () => {
    expect(await failure({ plan: 'practice_plus', workspaces: 30 }, 'max_workspaces')).toMatchObject({ upgrade_to: null });
  });

  it('counts templates from report_templates', async () => {
    const ds = source({ plan: 'solo', report_templates: 4 });
    await createAssertWithinLimit(ds)('u1', 'max_templates');
    expect(ds.calls).toEqual(['report_templates']);
    expect(await failure({ plan: 'free' }, 'max_templates')).toEqual({
      limit_key: 'max_templates',
      limit: 0,
      used: 0,
      upgrade_to: 'solo',
    });
  });
});

describe('assertWithinLimit: monthly limits', () => {
  it.each([
    ['max_datasets_per_month', 'upload', 3],
    ['max_questions_per_month', 'question', 20],
    ['max_reports_per_month', 'report', 1],
  ] as const)('%s counts %s events since the SAST month start', async (key, kind, freeLimit) => {
    const ds = source({ plan: 'free', [kind]: freeLimit - 1 });
    await createAssertWithinLimit(ds)('u1', key);
    expect(ds.calls).toHaveLength(1);
    expect(ds.calls[0]).toMatch(new RegExp(`^${kind}@\\d{4}-\\d{2}-01T00:00:00\\+02:00$`));

    expect(await failure({ plan: 'free', [kind]: freeLimit }, key)).toEqual({
      limit_key: key,
      limit: freeLimit,
      used: freeLimit,
      upgrade_to: 'solo',
    });
  });
});

describe('assertWithinLimit: per-file limits', () => {
  it('allows a file at exactly the limit', async () => {
    await passes({ plan: 'free' }, 'max_rows', 20000);
    await passes({ plan: 'free' }, 'max_file_mb', 5);
  });

  it('refuses a file over the limit and reports the value as used', async () => {
    expect(await failure({ plan: 'free' }, 'max_rows', 150000)).toEqual({
      limit_key: 'max_rows',
      limit: 20000,
      used: 150000,
      upgrade_to: 'practice',
    });
    expect(await failure({ plan: 'solo' }, 'max_file_mb', 30)).toEqual({
      limit_key: 'max_file_mb',
      limit: 25,
      used: 30,
      upgrade_to: 'practice_plus',
    });
  });

  it('needs a value', async () => {
    await expect(createAssertWithinLimit(source({ plan: 'free' }))('u1', 'max_rows')).rejects.toThrow(/needs a value/);
  });
});

describe('assertWithinLimit: feature flags', () => {
  it.each(['branding', 'share_links'] as const)('%s is refused on free with limit 0', async (key) => {
    expect(await failure({ plan: 'free' }, key)).toEqual({ limit_key: key, limit: 0, used: 0, upgrade_to: 'solo' });
  });

  it.each(['branding', 'share_links'] as const)('%s is allowed on solo', async (key) => {
    await passes({ plan: 'solo' }, key);
  });
});
