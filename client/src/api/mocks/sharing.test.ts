import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, configureApiClient } from '../client';
import { createReport, createShareLink, downloadReportXlsx, listShareLinks, revokeShareLink } from '../reports';
import { listBlocks } from '../blocks';
import { listDatasets } from '../datasets';
import { updateMe } from '../me';
import { listWorkspaces } from '../workspaces';
import { configurePublicTransport, getPublicReport, PublicReportError } from '../publicReports';
import { mockAuthBackend } from './auth';
import { mockTransport, setMockLatency } from './handlers';
import { mockStore } from './store';

const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('mock export and sharing (S4)', () => {
  let reportId = '';
  let workspaceId = '';
  let blockIds: string[] = [];

  beforeEach(async () => {
    setMockLatency(0);
    mockStore.reset();
    configureApiClient({
      transport: mockTransport,
      getAccessToken: async () => (await mockAuthBackend.getSession())?.access_token ?? null,
      onUnauthorized: () => {},
      onConsentRequired: () => {},
    });
    configurePublicTransport(mockTransport);
    // paid@ is on Solo (share links allowed) and starts with example files and answers.
    await mockAuthBackend.signIn('paid@example.co.za', 'password123');
    await updateMe({ accept_terms: true });
    const [ws] = await listWorkspaces();
    const datasets = await listDatasets(ws!.id, { limit: 50, offset: 0 });
    workspaceId = ws!.id;
    blockIds = [];
    for (const d of datasets.items) {
      const page = await listBlocks(d.id, { limit: 50, offset: 0 });
      blockIds = blockIds.concat(page.items.map((b) => b.id));
      if (blockIds.length >= 3) break;
    }
    reportId = (await createReport({ workspace_id: ws!.id, title: 'October review', block_ids: blockIds.slice(0, 3) })).id;
  });

  it('exports a real .xlsx with its file name in Content-Disposition', async () => {
    const { blob, filename } = await downloadReportXlsx(reportId);
    expect(filename).toMatch(/^october-review-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // An .xlsx is a zip: it starts with "PK".
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it('creates, lists (newest first) and turns off links; turning off twice keeps the first time', async () => {
    const first = await createShareLink(reportId, { expires_in_days: 7 });
    const second = await createShareLink(reportId, { show_working: true });
    expect(first.token).toHaveLength(43);
    expect(first.url.endsWith(`/r/${first.token}`)).toBe(true);
    expect(first.expires_at).not.toBeNull();
    expect(second).toMatchObject({ expires_at: null, show_working: true, contains_personal_data: false, view_count: 0 });
    expect((await listShareLinks(reportId)).map((l) => l.id)).toEqual([second.id, first.id]);
    const off = await revokeShareLink(first.id);
    expect(off.revoked_at).not.toBeNull();
    expect((await revokeShareLink(first.id)).revoked_at).toBe(off.revoked_at);
  });

  it('refuses links on Free with 402 share_links', async () => {
    mockStore.findUser('paid@example.co.za')!.plan = 'free';
    const error = (await caught(createShareLink(reportId, {}))) as ApiError;
    expect(error.planLimit).toEqual({ limit_key: 'share_links', limit: 0, used: 0, upgrade_to: 'solo' });
  });

  it('the public report: no ids, working only with show_working, never source rows, and it counts the view', async () => {
    const plain = await createShareLink(reportId, {});
    const working = await createShareLink(reportId, { show_working: true });
    const report = await getPublicReport(plain.token);
    expect(report).not.toHaveProperty('workspace_id');
    expect(report).not.toHaveProperty('template_id');
    expect(report.blocks.every((b) => !('dataset_id' in b.block) && b.block.sql === '' && b.block.checks.length === 0 && !b.block.has_source_rows)).toBe(true);
    const withWorking = await getPublicReport(working.token);
    expect(withWorking.blocks.some((b) => b.block.sql !== '' && b.block.checks.length > 0)).toBe(true);
    expect(withWorking.blocks.every((b) => !b.block.has_source_rows)).toBe(true);
    expect((await listShareLinks(reportId)).find((l) => l.id === plain.id)?.view_count).toBe(1);
  });

  it('unknown, expired and turned-off links all answer the same 404', async () => {
    const off = await createShareLink(reportId, {});
    await revokeShareLink(off.id);
    // Mock variant: links made on a report titled with "expired" have already expired.
    const expiredReport = await createReport({ workspace_id: workspaceId, title: 'expired example', block_ids: blockIds.slice(0, 1) });
    const expired = await createShareLink(expiredReport.id, { expires_in_days: 7 });
    const failures = [];
    for (const token of ['no-such-token', off.token, expired.token]) {
      const response = await mockTransport(`http://api.test/api/v1/public/reports/${token}`, { method: 'GET' });
      failures.push([response.status, await response.text(), response.headers.get('Cache-Control')]);
    }
    expect(new Set(failures.map((f) => JSON.stringify(f))).size).toBe(1);
    expect(failures[0]![0]).toBe(404);
    expect(failures[0]![2]).toBe('no-store');
    expect(((await caught(getPublicReport('no-such-token'))) as PublicReportError).failure).toEqual({ kind: 'unavailable' });
  });

  it('the token "busy" answers 429 with Retry-After', async () => {
    expect(((await caught(getPublicReport('busy'))) as PublicReportError).failure).toEqual({ kind: 'rate_limited', retryAfterSeconds: 20 });
  });
});
