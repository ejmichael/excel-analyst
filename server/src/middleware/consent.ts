import type { RequestHandler } from 'express';
import { AppError, throwIfDbError } from '../lib/errors.js';
import { supabaseForUser } from '../lib/supabase.js';

/** True when the user has accepted the terms and privacy notice (profiles.popia_consent_at is set). */
export type ConsentLookup = (userId: string, token: string) => Promise<boolean>;

export const consentFromProfile: ConsentLookup = async (userId, token) => {
  const { data, error } = await supabaseForUser(token)
    .from('profiles')
    .select('popia_consent_at')
    .eq('id', userId)
    .maybeSingle<{ popia_consent_at: string | null }>();
  throwIfDbError('consent lookup', error);
  return Boolean(data?.popia_consent_at);
};

/** 403 consent_required until PATCH /me { accept_terms: true } has been called. Mount after requireAuth. */
export function createRequireConsent(lookup: ConsentLookup): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw new AppError('unauthorized', 'Sign in to continue.');
    const accepted = await lookup(req.auth.userId, req.auth.token);
    if (!accepted) {
      throw new AppError('consent_required', 'Accept the terms of use and privacy notice to continue.');
    }
    next();
  };
}

export const requireConsent = createRequireConsent(consentFromProfile);
