import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, configureApiClient } from '../client';
import { getAutoReport, startAutoReport } from '../autoReports';
import { getDataset, uploadDataset } from '../datasets';
import { updateMe } from '../me';
import { getReport } from '../reports';
import { listWorkspaces } from '../workspaces';
import { mockAuthBackend } from './auth';
import { MOCK_AUTO_SLOW_TOTAL_MS, MOCK_AUTO_STEP_MS } from './autoReports';
import { MOCK_PROFILING_MS } from './datasets';
import { mockTransport, mockUploadTransport, setMockLatency } from './handlers';
import { mockStore } from './store';

const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ApiError);

describe('mock "Build my report" (Flow B2)', () => {
  let datasetId = '';

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setMockLatency(0);
    mockStore.reset();
    configureApiClient({
      transport: mockTransport,
      uploadTransport: mockUploadTransport,
      getAccessToken: async () => (await mockAuthBackend.getSession())?.access_token ?? null,
      onUnauthorized: () => {},
      onConsentRequired: () => {},
    });
    await mockAuthBackend.signIn('paid@example.co.za', 'password123');
    await updateMe({ accept_terms: true });
    const [ws] = await listWorkspaces();
    const file = new File(['Date;Amount\n01/10/2026;10,00\n'], '01_card_sales_semicolon_win1252.csv', { type: 'text/csv' });
    const created = await uploadDataset({ file, workspace_id: ws!.id }, { onProgress: () => {}, signal: new AbortController().signal });
    vi.setSystemTime(Date.now() + MOCK_PROFILING_MS + 1);
    datasetId = (await getDataset(created.id)).id;
  });

  afterEach(() => vi.useRealTimers());

  it('answers one suggestion every 2 s, then makes the report in suggestion order, with the flagged answer kept', async () => {
    const run = await startAutoReport(datasetId, { period_label: 'October 2026' });
    expect(run).toMatchObject({ dataset_id: datasetId, status: 'running', blocks_done: 0, blocks_total: 5, report_id: null, error_message: null });

    vi.setSystemTime(Date.now() + MOCK_AUTO_STEP_MS * 2 + 1);
    expect(await getAutoReport(run.id)).toMatchObject({ status: 'running', blocks_done: 2 });
    // One already running for this file: 409 naming it.
    const conflict = await caught(startAutoReport(datasetId, {}));
    expect(conflict?.code).toBe('conflict');
    expect(conflict?.details).toEqual({ auto_report_id: run.id });

    vi.setSystemTime(Date.now() + MOCK_AUTO_STEP_MS * 3);
    const done = await getAutoReport(run.id);
    expect(done).toMatchObject({ status: 'done', blocks_done: 5 });
    const report = await getReport(done.report_id!);
    expect(report.title).toBe('Card sales October');
    expect(report.period_label).toBe('October 2026');
    expect(report.blocks.map((b) => b.block.question)).toEqual((await getDataset(datasetId)).suggestions.map((s) => s.question));
    expect(report.blocks.filter((b) => b.block.status === 'flagged')).toHaveLength(1);
    expect(report.blocks.every((b) => b.block.source === 'suggested')).toBe(true);
  });

  it('variants by title: "fail" ends failed and keeps its answers, "busy" is 409, "limit" is 402, "slow" takes 3 minutes', async () => {
    const failing = await startAutoReport(datasetId, { title: 'fail please' });
    vi.setSystemTime(Date.now() + MOCK_AUTO_STEP_MS * 5 + 1);
    const failed = await getAutoReport(failing.id);
    expect(failed).toMatchObject({ status: 'failed', report_id: null });
    expect(failed.error_message).toMatch(/We could only answer 2 of the 5 questions/);

    // "busy": a run started as if from another tab, and the 409 names it (AutoReportConflictDetails).
    const busy = await caught(startAutoReport(datasetId, { title: 'busy' }));
    expect(busy?.status).toBe(409);
    const busyId = (busy?.details as { auto_report_id: string }).auto_report_id;
    expect(await getAutoReport(busyId)).toMatchObject({ id: busyId, status: 'running' });
    vi.setSystemTime(Date.now() + MOCK_AUTO_STEP_MS * 5 + 1);
    expect((await getAutoReport(busyId)).status).toBe('done');

    const limit = await caught(startAutoReport(datasetId, { title: 'limit' }));
    expect(limit?.status).toBe(402);
    expect(limit?.planLimit?.limit_key).toBe('max_questions_per_month');

    const slow = await startAutoReport(datasetId, { title: 'slow one' });
    vi.setSystemTime(Date.now() + MOCK_AUTO_SLOW_TOTAL_MS - 40_000);
    expect((await getAutoReport(slow.id)).status).toBe('running');
    vi.setSystemTime(Date.now() + 40_001);
    expect((await getAutoReport(slow.id)).status).toBe('done');
  });

  it('checks the body (title 1 to 120, period up to 60) and the monthly report limit', async () => {
    expect((await caught(startAutoReport(datasetId, { title: 'x'.repeat(121) })))?.fieldErrors.title).toBeTruthy();
    expect((await caught(startAutoReport(datasetId, { period_label: 'x'.repeat(61) })))?.fieldErrors.period_label).toBeTruthy();
    const user = mockStore.findUser('paid@example.co.za')!;
    user.plan = 'free';
    user.report_events = [new Date().toISOString()];
    const error = await caught(startAutoReport(datasetId, {}));
    expect(error?.planLimit).toMatchObject({ limit_key: 'max_reports_per_month', limit: 1, used: 1 });
    expect((await caught(getAutoReport('nope')))?.status).toBe(404);
  });
});
