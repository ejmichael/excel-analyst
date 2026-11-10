import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabase.js';

/**
 * Resolves a Supabase access token to a user id, or null when Supabase rejects the token (invalid, expired,
 * user gone). Throws AppError when the check itself could not be made, so an outage is never reported as
 * "signed out" (a 401 makes the client sign the user out).
 */
export type TokenVerifier = (token: string) => Promise<string | null>;

export type AuthErrorKind = 'invalid' | 'rate_limited' | 'unavailable';

/** 400/401/403/404 from Supabase Auth mean the token is not acceptable; anything else is Auth being unreachable. */
export function classifyAuthError(err: { status?: number; name?: string }): AuthErrorKind {
  const status = err.status;
  if (status === 400 || status === 401 || status === 403 || status === 404) return 'invalid';
  if (status === 429) return 'rate_limited';
  return 'unavailable'; // network failure (status 0 / AuthRetryableFetchError), 5xx, or unknown
}

const RETRY_DELAY_MS = 200;

export function createSupabaseVerifier(
  getUser: (token: string) => Promise<{ data: { user: { id: string } | null }; error: { status?: number; name?: string; code?: string } | null }>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): TokenVerifier {
  return async (token) => {
    for (let attempt = 1; ; attempt++) {
      const { data, error } = await getUser(token);
      if (!error) return data.user?.id ?? null;
      const kind = classifyAuthError(error);
      if (kind === 'invalid') return null;
      if (attempt === 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      // Log the kind only; never the token.
      logger.warn({ auth_error: error.name, status: error.status, code: error.code }, 'could not verify token');
      throw kind === 'rate_limited'
        ? new AppError('rate_limited', 'Too many sign-in checks right now. Please wait a moment and try again.')
        : new AppError('internal', 'We could not check your sign-in right now. Please try again.');
    }
  };
}

export const verifyWithSupabase: TokenVerifier = (token) =>
  createSupabaseVerifier((t) => supabaseAdmin().auth.getUser(t))(token);

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
