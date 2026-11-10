import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../src/config/env.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';

export interface TestUser {
  id: string;
  email: string;
  token: string;
  /** Anon/publishable client signed in as this user: what someone could do with their own token. */
  client: SupabaseClient;
}

/** Test users look like test+<12 hex>@example.com; nothing else is ever created or deleted by these helpers. */
export const TEST_EMAIL_RE = /^test\+[0-9a-f]{12}@example\.com$/;

/** Emails are recorded BEFORE createUser, so a user whose create response was lost can still be found and deleted. */
const pendingEmails = new Set<string>();
const createdIds = new Map<string, string>(); // email -> user id

// ---------- readable, secret-free errors ----------

/** Strips anything that could be a credential from a message (JWTs, Supabase keys, bearer tokens). */
export function redact(text: string): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[jwt]')
    .replace(/sb_(secret|publishable)_[\w-]+/g, 'sb_$1_[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

interface ErrorLike {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
}

export function describeError(err: unknown): string {
  const e = (typeof err === 'object' && err !== null ? err : { message: String(err) }) as ErrorLike;
  const parts = [e.name, e.status !== undefined ? `status ${e.status}` : undefined, e.code ? `code ${e.code}` : undefined, e.message];
  return redact(parts.filter(Boolean).join(', '));
}

/** Auth rate limits (429), server errors and network failures are worth one more try. */
function isTransient(err: unknown): boolean {
  const e = (err ?? {}) as ErrorLike;
  if (e.status === 429 || (e.status !== undefined && e.status >= 500)) return true;
  if (e.status === 0 || e.name === 'AuthRetryableFetchError') return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|over_request_rate_limit|rate limit/i.test(e.message ?? '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one named setup step. A transient failure gets one retry after a short wait; any final failure
 * is printed and rethrown as "Integration setup failed at <step>: <name, status, code, message>".
 */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 1 && isTransient(err)) {
        console.warn(`[integration setup] "${name}" failed (${describeError(err)}); retrying once in 3 s`);
        await sleep(3000);
        continue;
      }
      const message = `Integration setup failed at "${name}": ${describeError(err)}`;
      console.error(`[integration setup] ${message}`);
      throw new Error(message);
    }
  }
}

/** Supabase returns { error } instead of throwing; turn it into a throw for step(). */
function orThrow<R extends { data: unknown; error: unknown }>(res: R): R['data'] {
  if (res.error) throw res.error;
  return res.data;
}

// ---------- users ----------

// Creating users one at a time keeps sign-ins from bursting into the auth rate limit.
let queue: Promise<unknown> = Promise.resolve();

/** Creates a confirmed user with the admin API and signs in with the anon key. Remember to call deleteTestUsers. */
export function createTestUser(): Promise<TestUser> {
  const next = queue.then(async () => {
    const email = `test+${randomBytes(6).toString('hex')}@example.com`;
    const password = `T1!${randomBytes(12).toString('base64url')}`;
    pendingEmails.add(email);

    const created = await step('create test user (admin API)', async () => {
      const data = orThrow(await supabaseAdmin().auth.admin.createUser({ email, password, email_confirm: true }));
      if (!data.user) throw new Error('createUser returned no user');
      return data.user;
    });
    createdIds.set(email, created.id);

    const client = createClient(env().SUPABASE_URL, env().SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const session = await step('sign in test user (password grant)', async () => {
      const data = orThrow(await client.auth.signInWithPassword({ email, password }));
      if (!data.session) throw new Error('signIn returned no session');
      return data.session;
    });
    return { id: created.id, email, token: session.access_token, client };
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Every storage object under `<ownerId>/` in the datasets bucket (two levels: dataset folder, then files). */
export async function listOwnerObjects(ownerId: string): Promise<string[]> {
  const bucket = supabaseAdmin().storage.from(env().STORAGE_BUCKET_DATASETS);
  const { data: folders } = await bucket.list(ownerId, { limit: 1000 });
  const paths: string[] = [];
  for (const folder of folders ?? []) {
    const { data: files } = await bucket.list(`${ownerId}/${folder.name}`, { limit: 1000 });
    for (const f of files ?? []) paths.push(`${ownerId}/${folder.name}/${f.name}`);
  }
  return paths;
}

/** All auth users (paged), for finding test users by email. */
async function listAllUsers(): Promise<Array<{ id: string; email?: string; created_at: string }>> {
  const all: Array<{ id: string; email?: string; created_at: string }> = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    all.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return all;
}

/** Removes one user's storage objects, then the user (which cascades to every row they own). Never throws. */
async function removeUser(id: string): Promise<string | null> {
  try {
    const paths = await listOwnerObjects(id);
    if (paths.length > 0) orThrow(await supabaseAdmin().storage.from(env().STORAGE_BUCKET_DATASETS).remove(paths));
  } catch (err) {
    console.error(`[integration cleanup] storage for user ${id}: ${describeError(err)}`);
  }
  try {
    orThrow(await supabaseAdmin().auth.admin.deleteUser(id));
    return null;
  } catch (err) {
    return `delete user ${id}: ${describeError(err)}`;
  }
}

/**
 * Deletes every user this process created, including any whose create call succeeded but whose response was lost
 * (found by the recorded email). Each step runs even if another fails; failures are printed, not thrown,
 * so one bad delete cannot stop the rest.
 */
export async function deleteTestUsers(): Promise<void> {
  // A failed beforeAll can reject while later users are still being created; wait for those first.
  await queue;
  const ids = new Set(createdIds.values());
  const unresolved = [...pendingEmails].filter((e) => !createdIds.has(e));
  if (unresolved.length > 0) {
    try {
      for (const u of await listAllUsers()) if (u.email && unresolved.includes(u.email)) ids.add(u.id);
    } catch (err) {
      console.error(`[integration cleanup] could not look up ${unresolved.length} unconfirmed test user(s): ${describeError(err)}`);
    }
  }
  pendingEmails.clear();
  createdIds.clear();
  const failures = (await Promise.all([...ids].map(removeUser))).filter((f): f is string => f !== null);
  for (const f of failures) console.error(`[integration cleanup] ${f}`);
}

/**
 * Deletes test users (test+<12 hex>@example.com only) created more than `olderThanMs` ago: leftovers from runs that
 * were killed or lost their network. Runs before the integration tests (globalSetup) and as `npm run test:cleanup`.
 */
export async function sweepLeftoverTestUsers(olderThanMs = 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const leftovers = (await listAllUsers()).filter((u) => u.email && TEST_EMAIL_RE.test(u.email) && Date.parse(u.created_at) < cutoff);
  const failures = (await Promise.all(leftovers.map((u) => removeUser(u.id)))).filter((f): f is string => f !== null);
  for (const f of failures) console.error(`[integration cleanup] ${f}`);
  return leftovers.length - failures.length;
}

export async function setPlan(userId: string, plan: 'free' | 'solo' | 'practice' | 'practice_plus'): Promise<void> {
  await step(`set plan ${plan}`, async () => {
    orThrow(await supabaseAdmin().from('profiles').update({ plan }).eq('id', userId));
  });
}

export const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
