import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { monthStartSast } from '../../src/services/dates.js';
import type { Me, Workspace } from '../../src/types/api.js';

const app = createApp();
const api = (path: string) => `/api/v1${path}`;

let a: TestUser;
let b: TestUser;

beforeAll(async () => {
  [a, b] = await Promise.all([createTestUser(), createTestUser()]);
});

afterAll(async () => {
  await deleteTestUsers();
});

async function profileOf(userId: string) {
  const { data } = await supabaseAdmin()
    .from('profiles')
    .select('plan, popia_consent_at, brand_color, full_name')
    .eq('id', userId)
    .single();
  return data as { plan: string; popia_consent_at: string | null; brand_color: string; full_name: string | null };
}

async function acceptTerms(u: TestUser) {
  const res = await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true });
  expect(res.status).toBe(200);
  return res.body.data as Me;
}

describe('system and auth', () => {
  it('GET /health works without a token', async () => {
    const res = await request(app).get(api('/health'));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(Number.isNaN(Date.parse(res.body.data.time))).toBe(false);
  });

  it('GET /me without a token is 401', async () => {
    const res = await request(app).get(api('/me'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('GET /me with a garbage token is 401', async () => {
    const res = await request(app).get(api('/me')).set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });
});

describe('a new user before consent', () => {
  it('has a profile and exactly one default workspace', async () => {
    const res = await request(app).get(api('/me')).set(bearer(a));
    expect(res.status).toBe(200);
    const me = res.body.data as Me;
    expect(me).toMatchObject({
      user_id: a.id,
      email: a.email,
      full_name: null,
      business_name: null,
      plan: 'free',
      consent_accepted: false,
      brand: { business_name: null, logo_url: null, color: '#1E7A5F' },
      subscription: null,
    });
    expect(me.limits).toMatchObject({ plan: 'free', price_zar: 0, max_workspaces: 1, branding: false });
    expect(me.usage).toEqual({
      month_start: monthStartSast(),
      uploads: 0,
      questions: 0,
      reports: 0,
      report_runs: 0,
      exports: 0,
      workspaces: 1,
      templates: 0,
    });
    const { data: ws } = await supabaseAdmin().from('workspaces').select('is_default').eq('owner_id', a.id);
    expect(ws).toEqual([{ is_default: true }]);
  });

  it('gets 403 consent_required on /workspaces but /me still works', async () => {
    const res = await request(app).get(api('/workspaces')).set(bearer(b));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('consent_required');
    expect((await request(app).get(api('/me')).set(bearer(b))).status).toBe(200);
  });
});

describe('consent', () => {
  it('PATCH /me { accept_terms: true } unlocks /workspaces', async () => {
    const me = await acceptTerms(a);
    expect(me.consent_accepted).toBe(true);
    const res = await request(app).get(api('/workspaces')).set(bearer(a));
    expect(res.status).toBe(200);
    const list = res.body.data as Workspace[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'My workspace', is_default: true });
    expect(Object.keys(list[0]!).sort()).toEqual(['created_at', 'id', 'is_default', 'name']);
  });

  it('accepting twice keeps the first timestamp', async () => {
    const before = (await profileOf(a.id)).popia_consent_at;
    expect(before).not.toBeNull();
    await acceptTerms(a);
    expect((await profileOf(a.id)).popia_consent_at).toBe(before);
  });

  it('accept_terms: false is rejected', async () => {
    const res = await request(app).patch(api('/me')).set(bearer(b)).send({ accept_terms: false });
    expect(res.status).toBe(422);
  });
});

describe('PATCH /me', () => {
  it('updates and trims names', async () => {
    const res = await request(app)
      .patch(api('/me'))
      .set(bearer(a))
      .send({ full_name: '  Thandi Nkosi ', business_name: ' Nkosi Bakery ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      full_name: 'Thandi Nkosi',
      business_name: 'Nkosi Bakery',
      brand: { business_name: 'Nkosi Bakery' },
    });
  });

  it('clears a name with null', async () => {
    const res = await request(app).patch(api('/me')).set(bearer(a)).send({ full_name: null });
    expect(res.status).toBe(200);
    expect(res.body.data.full_name).toBeNull();
  });

  it('rejects an empty body, unknown fields, blank names and bad colours with 422', async () => {
    for (const body of [{}, { plan: 'practice_plus' }, { full_name: '   ' }, { full_name: 'x'.repeat(121) }, { brand_color: 'red' }]) {
      const res = await request(app).patch(api('/me')).set(bearer(a)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect((await profileOf(a.id)).plan).toBe('free');
  });

  it('brand_color on free is 402 plan_limit and changes nothing', async () => {
    const res = await request(app)
      .patch(api('/me'))
      .set(bearer(a))
      .send({ brand_color: '#123456', full_name: 'Should Not Save' });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      code: 'plan_limit',
      details: { limit_key: 'branding', limit: 0, used: 0, upgrade_to: 'solo' },
    });
    const p = await profileOf(a.id);
    expect(p.brand_color).toBe('#1E7A5F');
    expect(p.full_name).toBeNull();
  });
});

describe('workspaces', () => {
  it('a second workspace on free is 402 with the right details', async () => {
    const res = await request(app).post(api('/workspaces')).set(bearer(a)).send({ name: 'Client: Spaza' });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      code: 'plan_limit',
      details: { limit_key: 'max_workspaces', limit: 1, used: 1, upgrade_to: 'practice' },
    });
  });

  it('unknown fields are 422', async () => {
    const res = await request(app).post(api('/workspaces')).set(bearer(a)).send({ name: 'X', is_default: true });
    expect(res.status).toBe(422);
  });

  describe('on the practice plan', () => {
    let extra: Workspace;
    let aDefault: Workspace;

    beforeAll(async () => {
      // Plans change only through billing (Part 6); set it directly for the test.
      await supabaseAdmin().from('profiles').update({ plan: 'practice' }).eq('id', a.id);
      await acceptTerms(b);
      const list = await request(app).get(api('/workspaces')).set(bearer(a));
      aDefault = (list.body.data as Workspace[])[0]!;
    });

    it('creates a workspace (201), trimmed, listed after the default', async () => {
      const res = await request(app).post(api('/workspaces')).set(bearer(a)).send({ name: '  Client: Spaza  ' });
      expect(res.status).toBe(201);
      extra = res.body.data as Workspace;
      expect(extra).toMatchObject({ name: 'Client: Spaza', is_default: false });
      const list = await request(app).get(api('/workspaces')).set(bearer(a));
      expect((list.body.data as Workspace[]).map((w) => w.id)).toEqual([aDefault.id, extra.id]);
    });

    it('brand_color now works and shows in /me', async () => {
      const res = await request(app).patch(api('/me')).set(bearer(a)).send({ brand_color: '#AA3300' });
      expect(res.status).toBe(200);
      expect(res.body.data.brand.color).toBe('#AA3300');
    });

    it('/me usage counts both workspaces', async () => {
      const res = await request(app).get(api('/me')).set(bearer(a));
      expect(res.body.data.usage.workspaces).toBe(2);
    });

    it('renames its own workspace', async () => {
      const res = await request(app).patch(api(`/workspaces/${extra.id}`)).set(bearer(a)).send({ name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: extra.id, name: 'Renamed' });
    });

    it("user B gets 404 renaming or deleting user A's workspaces", async () => {
      for (const id of [extra.id, aDefault.id]) {
        const rename = await request(app).patch(api(`/workspaces/${id}`)).set(bearer(b)).send({ name: 'Mine now' });
        expect(rename.status).toBe(404);
        expect(rename.body.error.code).toBe('not_found');
        const del = await request(app).delete(api(`/workspaces/${id}`)).set(bearer(b));
        expect(del.status).toBe(404);
      }
      const { data } = await supabaseAdmin().from('workspaces').select('name').eq('id', extra.id).single();
      expect(data).toEqual({ name: 'Renamed' });
    });

    it('user B does not see user A workspaces in its list', async () => {
      const res = await request(app).get(api('/workspaces')).set(bearer(b));
      expect((res.body.data as Workspace[]).map((w) => w.id)).not.toContain(extra.id);
      expect(res.body.data).toHaveLength(1);
    });

    it('deleting the default workspace is 409', async () => {
      const res = await request(app).delete(api(`/workspaces/${aDefault.id}`)).set(bearer(a));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    });

    it('a malformed or unknown id is 404', async () => {
      expect((await request(app).patch(api('/workspaces/nope')).set(bearer(a)).send({ name: 'x' })).status).toBe(404);
      expect((await request(app).delete(api('/workspaces/00000000-0000-4000-8000-000000000000')).set(bearer(a))).status).toBe(404);
    });

    it('deletes its own non-default workspace', async () => {
      const res = await request(app).delete(api(`/workspaces/${extra.id}`)).set(bearer(a));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { deleted: true } });
      const { data } = await supabaseAdmin().from('workspaces').select('id').eq('id', extra.id);
      expect(data).toEqual([]);
    });
  });
});

describe('Supabase REST with the user token', () => {
  it('cannot change plan or consent on the profile', async () => {
    const before = await profileOf(b.id);
    const { data } = await b.client
      .from('profiles')
      .update({ plan: 'practice_plus', popia_consent_at: null })
      .eq('id', b.id)
      .select();
    expect(data ?? []).toEqual([]);
    const after = await profileOf(b.id);
    expect(after.plan).toBe(before.plan);
    expect(after.popia_consent_at).toBe(before.popia_consent_at);
  });

  it('cannot insert a workspace past the plan limit', async () => {
    const { error } = await b.client.from('workspaces').insert({ owner_id: b.id, name: 'Sneaky' });
    expect(error).not.toBeNull();
    const { count } = await supabaseAdmin()
      .from('workspaces')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', b.id);
    expect(count).toBe(1);
  });

  it("cannot read another user's rows", async () => {
    const { data } = await b.client.from('workspaces').select('id').eq('owner_id', a.id);
    expect(data).toEqual([]);
  });
});
