import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

const serverAuth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

let admin: SupabaseClient | undefined;

/**
 * Service-role client. Bypasses RLS: use it for WRITES, and always filter by owner_id = req.auth.userId.
 * Works with both the legacy service_role JWT and the new sb_secret_ key.
 */
export function supabaseAdmin(): SupabaseClient {
  admin ??= createClient(env().SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, { auth: serverAuth });
  return admin;
}

/**
 * Per-request client carrying the user's JWT with the anon/publishable key, so RLS applies.
 * Use it for READS so tenants stay isolated even if a route forgets an owner filter.
 */
export function supabaseForUser(token: string): SupabaseClient {
  return createClient(env().SUPABASE_URL, env().SUPABASE_ANON_KEY, {
    auth: serverAuth,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
