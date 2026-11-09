import { Router } from 'express';
import { z } from 'zod';
import { notFound, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';
import { validate } from '../middleware/validate.js';
import { assertWithinLimit, toPlanLimits } from '../services/limits.js';
import { getUsage } from '../services/usage.js';
import type { Me, Plan, Subscription, UpdateMeRequest } from '../types/api.js';

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  business_name: string | null;
  plan: Plan;
  brand_color: string;
  popia_consent_at: string | null;
}

interface SubscriptionRow {
  plan: Plan;
  status: Subscription['status'];
  amount_zar: number | string | null;
  next_billing_date: string | null;
  cancelled_at: string | null;
}

const PROFILE_COLUMNS = 'id, email, full_name, business_name, plan, brand_color, popia_consent_at';

/** Builds Me from profiles + plan_limits + usage + subscription, read with the user's client (RLS applies). */
export async function buildMe(userId: string, token: string): Promise<Me> {
  const db = supabaseForUser(token);
  const [profile, limits, usage, sub] = await Promise.all([
    db.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle<ProfileRow>(),
    db.from('plan_limits').select('*'),
    getUsage(db, userId),
    db
      .from('subscriptions')
      .select('plan, status, amount_zar, next_billing_date, cancelled_at')
      .eq('owner_id', userId)
      .maybeSingle<SubscriptionRow>(),
  ]);
  throwIfDbError('me: profile', profile.error);
  throwIfDbError('me: plan_limits', limits.error);
  throwIfDbError('me: subscription', sub.error);
  const p = profile.data;
  // The DB trigger creates the profile at sign-up; a missing one means the account is gone.
  if (!p) throw notFound('Profile not found.');
  const planRow = (limits.data ?? []).find((r: { plan: unknown }) => r.plan === p.plan);
  if (!planRow) throw new Error(`plan_limits has no row for plan ${p.plan}`);

  const s = sub.data;
  const subscription: Subscription | null =
    !s || s.status === 'none'
      ? null
      : {
          plan: s.plan,
          status: s.status,
          amount_zar: s.amount_zar === null ? null : Number(s.amount_zar),
          next_billing_date: s.next_billing_date,
          cancelled_at: s.cancelled_at,
        };

  return {
    user_id: p.id,
    email: p.email,
    full_name: p.full_name,
    business_name: p.business_name,
    plan: p.plan,
    consent_accepted: p.popia_consent_at !== null,
    // Logos arrive in Part 4.
    brand: { business_name: p.business_name, logo_url: null, color: p.brand_color },
    limits: toPlanLimits(planRow),
    usage,
    subscription,
  };
}

const optionalName = z.string().trim().min(1).max(120).nullable().optional();

const updateMeBody = z
  .strictObject({
    full_name: optionalName,
    business_name: optionalName,
    brand_color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #1E7A5F')
      .optional(),
    accept_terms: z.literal(true).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Send at least one field to update.' });

export const meRouter = Router();

// GET /me and PATCH /me are allowed before consent.
meRouter.get('/me', async (req, res) => {
  const { userId, token } = authOf(req);
  ok(res, await buildMe(userId, token));
});

meRouter.patch('/me', validate({ body: updateMeBody }), async (req, res) => {
  const { userId, token } = authOf(req);
  const body = req.body as UpdateMeRequest;

  // Check the plan before writing anything so a refused request changes nothing.
  if (body.brand_color !== undefined) {
    await assertWithinLimit(userId, 'branding');
  }

  const { data: current, error: readError } = await supabaseForUser(token)
    .from('profiles')
    .select('popia_consent_at')
    .eq('id', userId)
    .maybeSingle<{ popia_consent_at: string | null }>();
  throwIfDbError('me: read consent', readError);
  if (!current) throw notFound('Profile not found.');

  const update: Record<string, string | null> = {};
  if (body.full_name !== undefined) update.full_name = body.full_name;
  if (body.business_name !== undefined) update.business_name = body.business_name;
  if (body.brand_color !== undefined) update.brand_color = body.brand_color;
  // Consent is set once; accepting again keeps the original timestamp.
  if (body.accept_terms && current.popia_consent_at === null) update.popia_consent_at = new Date().toISOString();

  if (Object.keys(update).length > 0) {
    const { error } = await supabaseAdmin().from('profiles').update(update).eq('id', userId);
    throwIfDbError('me: update', error);
  }
  ok(res, await buildMe(userId, token));
});
