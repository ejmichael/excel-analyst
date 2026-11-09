import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { supabaseAdmin } from '../lib/supabase.js';

/** Resolves a Supabase access token to a user id, or null when it is invalid or expired. */
export type TokenVerifier = (token: string) => Promise<string | null>;

export const verifyWithSupabase: TokenVerifier = async (token) => {
  const { data, error } = await supabaseAdmin().auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
};

export function createRequireAuth(verify: TokenVerifier): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) throw new AppError('unauthorized', 'Sign in to continue.');
    const token = match[1];
    const userId = await verify(token);
    if (!userId) throw new AppError('unauthorized', 'Your session has expired. Sign in again.');
    req.auth = { userId, token };
    next();
  };
}

export const requireAuth = createRequireAuth(verifyWithSupabase);
