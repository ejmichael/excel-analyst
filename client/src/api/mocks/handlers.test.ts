import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, apiFetch, configureApiClient } from '../client';
import { getMe, updateMe } from '../me';
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from '../workspaces';
import { mockAuthBackend } from './auth';
import { mockTransport, setMockLatency } from './handlers';
import { mockStore } from './store';

const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ApiError);

describe('mock API behaves like the contract', () => {
  beforeEach(async () => {
    setMockLatency(0);
    mockStore.reset();
    configureApiClient({
      transport: mockTransport,
      getAccessToken: async () => (await mockAuthBackend.getSession())?.access_token ?? null,
      onUnauthorized: () => {},
      onConsentRequired: () => {},
    });
    await mockAuthBackend.signIn('owner@example.co.za', 'password123');
  });

  it('gates workspaces behind consent, but allows /me', async () => {
    expect((await getMe()).consent_accepted).toBe(false);
    expect((await caught(listWorkspaces()))?.code).toBe('consent_required');

    const me = await updateMe({ accept_terms: true });
    expect(me.consent_accepted).toBe(true);
    const workspaces = await listWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.is_default).toBe(true);
  });

  it('refuses a second workspace on Free with 402 plan_limit', async () => {
    await updateMe({ accept_terms: true });
    const error = await caught(createWorkspace({ name: 'Second' }));
    expect(error?.status).toBe(402);
    expect(error?.planLimit).toEqual({ limit_key: 'max_workspaces', limit: 1, used: 1, upgrade_to: 'practice' });
  });

  it('refuses to delete the default workspace with 409, and renames it', async () => {
    await updateMe({ accept_terms: true });
    const [def] = await listWorkspaces();
    if (!def) throw new Error('no default workspace');
    expect((await caught(deleteWorkspace(def.id)))?.status).toBe(409);
    expect((await updateWorkspace(def.id, { name: '  Shop  ' })).name).toBe('Shop');
  });

  it('creates and deletes a non-default workspace on a plan that allows it', async () => {
    await updateMe({ accept_terms: true });
    const user = mockStore.findUser('owner@example.co.za');
    if (!user) throw new Error('mock user missing');
    user.plan = 'practice';

    const created = await createWorkspace({ name: 'Client A' });
    expect(created.is_default).toBe(false);
    expect(await listWorkspaces()).toHaveLength(2);
    expect(await deleteWorkspace(created.id)).toEqual({ deleted: true });
    expect(await listWorkspaces()).toHaveLength(1);
    expect((await caught(deleteWorkspace(created.id)))?.status).toBe(404);
  });

  it('returns validation_failed with field details', async () => {
    await updateMe({ accept_terms: true });
    const error = await caught(createWorkspace({ name: '' }));
    expect(error?.code).toBe('validation_failed');
    expect(Object.keys(error?.fieldErrors ?? {})).toEqual(['name']);
  });

  it('refuses a brand colour on Free with 402 branding', async () => {
    const error = await caught(updateMe({ brand_color: '#123456' }));
    expect(error?.planLimit).toEqual({ limit_key: 'branding', limit: 0, used: 0, upgrade_to: 'solo' });
  });

  it('returns 401 without a session', async () => {
    await mockAuthBackend.signOut();
    expect((await caught(apiFetch('/me')))?.status).toBe(401);
  });
});
