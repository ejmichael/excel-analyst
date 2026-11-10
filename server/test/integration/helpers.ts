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

const created: string[] = [];

/** Creates a confirmed user with the admin API and signs in with the anon key. Remember to call deleteTestUsers. */
export async function createTestUser(): Promise<TestUser> {
  const email = `test+${randomBytes(6).toString('hex')}@example.com`;
  const password = `T1!${randomBytes(12).toString('base64url')}`;
  const { data, error } = await supabaseAdmin().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  created.push(data.user.id);

  const client = createClient(env().SUPABASE_URL, env().SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn failed: ${signIn.error?.message}`);
  return { id: data.user.id, email, token: signIn.data.session.access_token, client };
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

/** Removes the users' storage objects, then the users. Deleting the auth user cascades to every row they own. */
export async function deleteTestUsers(): Promise<void> {
  const ids = created.splice(0);
  const bucket = supabaseAdmin().storage.from(env().STORAGE_BUCKET_DATASETS);
  for (const id of ids) {
    const paths = await listOwnerObjects(id);
    if (paths.length > 0) await bucket.remove(paths);
  }
  await Promise.all(ids.map((id) => supabaseAdmin().auth.admin.deleteUser(id)));
}

export async function setPlan(userId: string, plan: 'free' | 'solo' | 'practice' | 'practice_plus'): Promise<void> {
  const { error } = await supabaseAdmin().from('profiles').update({ plan }).eq('id', userId);
  if (error) throw new Error(`setPlan failed: ${error.code}`);
}

export const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
