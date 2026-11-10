import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, configureApiClient } from '../client';
import { getMe, updateMe } from '../me';
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from '../workspaces';
import { mockAuthBackend } from './auth';
import { mockTransport, mockUploadTransport, setMockLatency } from './handlers';
import { MOCK_PROFILING_MS, handleUpload } from './datasets';
import { deleteDataset, getDataset, getDatasetPreview, listDatasets, reparseDataset, updateDataset, uploadDataset } from '../datasets';
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

describe('mock datasets behave like the contract', () => {
  beforeEach(async () => {
    setMockLatency(0);
    mockStore.reset();
    configureApiClient({
      transport: mockTransport,
      uploadTransport: mockUploadTransport,
      getAccessToken: async () => (await mockAuthBackend.getSession())?.access_token ?? null,
      refreshAccessToken: async () => null,
      onUnauthorized: () => {},
      onConsentRequired: () => {},
    });
    await mockAuthBackend.signIn('owner@example.co.za', 'password123');
    await updateMe({ accept_terms: true });
  });

  const upload = async (file: File) => {
    const [ws] = await listWorkspaces();
    return uploadDataset({ file, workspace_id: ws!.id }, { onProgress: () => {}, signal: new AbortController().signal });
  };
  const csv = (name: string, text = 'Date,Amount\n01/10/2026,10.00\n') => new File([text], name, { type: 'text/csv' });

  it('uploads a fixture, profiles it, then turns ready with its suggestions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const created = await upload(csv('04_ambiguous_dates.csv'));
      expect(created.status).toBe('profiling');
      vi.setSystemTime(Date.now() + MOCK_PROFILING_MS + 1);
      const detail = await getDataset(created.id);
      expect(detail.status).toBe('ready');
      expect(detail.warnings).toHaveLength(1);
      expect(detail.suggestions.length).toBeGreaterThan(0);
      expect(detail.expires_at).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses non-CSV content with 415, even with a .csv name', async () => {
    const binary = new File([new Uint8Array([0x50, 0x4b, 0, 0, 1])], 'trick.csv');
    expect((await caught(upload(binary)))?.status).toBe(415);
    expect((await caught(upload(new File(['hello'], 'notes.pdf'))))?.status).toBe(415);
  });

  it('refuses files above the hard ceiling (413) and above the plan (402 max_file_mb)', async () => {
    // jsdom copies a File put into FormData (losing an overridden size), so call the handler with a stub form.
    const user = mockStore.findUser('owner@example.co.za')!;
    const [ws] = await listWorkspaces();
    const sized = (mb: number) => {
      const f = csv('big.csv');
      Object.defineProperty(f, 'size', { value: mb * 1024 * 1024 + 1 });
      const fields: Record<string, unknown> = { file: f, workspace_id: ws!.id };
      return { get: (key: string) => fields[key] ?? null } as unknown as FormData;
    };
    expect((await handleUpload(user, sized(50))).status).toBe(413);
    const planLimit = await handleUpload(user, sized(5));
    expect(planLimit.status).toBe(402);
    expect(planLimit.body).toMatchObject({ error: { code: 'plan_limit', details: { limit_key: 'max_file_mb', limit: 5, upgrade_to: 'solo' } } });
  });

  it('refuses the fourth upload of the month on Free with 402 max_datasets_per_month', async () => {
    for (let i = 0; i < 3; i += 1) await upload(csv(`file${i}.csv`));
    expect((await caught(upload(csv('file4.csv'))))?.planLimit).toEqual({
      limit_key: 'max_datasets_per_month',
      limit: 3,
      used: 3,
      upgrade_to: 'solo',
    });
    expect((await getMe()).usage.uploads).toBe(3);
  });

  it('turns Private on when a meaning becomes personal, unless the request sets it', async () => {
    const created = await upload(csv('02_webstore_orders_utf8bom.csv'));
    const { columns } = await getDataset(created.id);
    const product = columns.find((c) => c.name === 'Product')!;
    const province = columns.find((c) => c.name === 'Province')!;
    const updated = await updateDataset(created.id, {
      columns: [
        { id: product.id, semantic: 'person_name' },
        { id: province.id, semantic: 'address', is_pii: false },
      ],
    });
    expect(updated.columns.find((c) => c.id === product.id)?.is_pii).toBe(true);
    expect(updated.columns.find((c) => c.id === province.id)?.is_pii).toBe(false);
  });

  it('while profiling: preview is 409 dataset_not_ready and reparse is 409 conflict (like the server)', async () => {
    const created = await upload(csv('04_ambiguous_dates.csv'));
    expect((await caught(getDatasetPreview(created.id, 50)))?.code).toBe('dataset_not_ready');
    expect((await caught(reparseDataset(created.id, { date_format: 'mdy' })))?.code).toBe('conflict');
  });

  it('reparse re-detects what is not sent, keeps column edits by sql_name with new ids, and clears error_details', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const created = await upload(csv('04_ambiguous_dates.csv'));
      vi.setSystemTime(Date.now() + MOCK_PROFILING_MS + 1);
      const before = await getDataset(created.id);
      const item = before.columns.find((c) => c.sql_name === 'item')!;
      await updateDataset(created.id, { columns: [{ id: item.id, display_name: 'What' }] });

      await reparseDataset(created.id, { date_format: 'mdy' });
      vi.setSystemTime(Date.now() + MOCK_PROFILING_MS + 1);
      const after = await getDataset(created.id);
      const itemAfter = after.columns.find((c) => c.sql_name === 'item')!;
      expect(itemAfter.display_name).toBe('What');
      expect(itemAfter.id).not.toBe(item.id);
      expect(after.warnings).toEqual([]);
      expect(after.error_details).toBeNull();

      // A later re-read that does not send the date order goes back to the detected one, with its warning.
      await reparseDataset(created.id, { header_row: 1 });
      vi.setSystemTime(Date.now() + MOCK_PROFILING_MS + 1);
      const again = await getDataset(created.id);
      expect(again.parse_options.date_format).toBe('dmy');
      expect(again.warnings).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('masks Private columns with placeholders and shows real samples once Private is off', async () => {
    const created = await upload(csv('02_webstore_orders_utf8bom.csv'));
    const { columns } = await getDataset(created.id);
    const email = columns.find((c) => c.name === 'Customer email')!;
    expect(email.sample_values.every((v) => v === '[email]')).toBe(true);
    expect(email.min_value).toBeNull();
    const updated = await updateDataset(created.id, { columns: [{ id: email.id, is_pii: false }] });
    expect(updated.columns.find((c) => c.id === email.id)?.sample_values[0]).toContain('@example.com');
  });

  it('lists newest first per workspace and deletes', async () => {
    const a = await upload(csv('a.csv'));
    const b = await upload(csv('b.csv'));
    const [ws] = await listWorkspaces();
    const page = await listDatasets(ws!.id, { limit: 1, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.map((d) => d.id)).toEqual([b.id]);
    expect(await deleteDataset(a.id)).toEqual({ deleted: true });
    expect((await caught(getDataset(a.id)))?.status).toBe(404);
  });
});
