import { beforeEach, describe, expect, it } from 'vitest';
import { configureApiClient, type ApiError } from '../client';
import { getDashboard, getDashboardData, planDashboard } from '../dashboards';
import { mockAuthBackend } from './auth';
import { MOCK_PLANNING_POLLS, MOCK_PLANS_PER_DAY } from './dashboards';
import { mockTransport, setMockLatency } from './handlers';
import { mockStore } from './store';

const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ApiError);

let ids: Record<string, string> = {};

beforeEach(async () => {
  setMockLatency(0);
  mockStore.reset();
  await mockAuthBackend.signIn('demo@example.co.za', 'password123');
  const user = mockStore.findUser('demo@example.co.za')!;
  user.popia_consent_at = '2026-11-01T09:00:00+02:00';
  ids = Object.fromEntries(user.datasets!.map((d) => [d.detail.name, d.detail.id]));
  configureApiClient({
    transport: mockTransport,
    getAccessToken: async () => (await mockAuthBackend.getSession())?.access_token ?? null,
    refreshAccessToken: async () => null,
  });
});

async function planUntilDone(id: string) {
  const planning = await planDashboard(id);
  expect(planning.status).toBe('planning');
  const seen = [];
  for (let i = 0; i < MOCK_PLANNING_POLLS; i++) seen.push((await getDashboard(id)).status);
  return seen;
}

describe('mock dashboards behave like the contract', () => {
  it('404 until the first POST; planning turns ready on the third poll with 8 widgets across five kinds', async () => {
    const id = ids['Webstore orders October']!;
    expect((await caught(getDashboard(id)))?.status).toBe(404);
    expect(await planUntilDone(id)).toEqual(['planning', 'planning', 'ready']);
    const board = await getDashboard(id);
    expect(board.fallback).toBe(false);
    expect(board.widgets).toHaveLength(8);
    expect(new Set(board.widgets.map((w) => w.chart.type))).toEqual(new Set(['kpi', 'bar', 'pie', 'line', 'table']));
    expect(board.filters.map((f) => f.kind)).toEqual(['date_range', 'category', 'category']);
  });

  it('a POST while planning returns it unchanged', async () => {
    const id = ids['Webstore orders October']!;
    const first = await planDashboard(id);
    expect((await planDashboard(id)).id).toBe(first.id);
  });

  it('filtered results differ from unfiltered; one widget errors; a filter can empty a widget; the layout stays', async () => {
    const id = ids['Webstore orders October']!;
    await planUntilDone(id);
    const board = await getDashboard(id);
    const all = await getDashboardData(id, { filters: [] });
    expect(all.rows_in_scope).toBe(all.rows_total);
    const paid = await getDashboardData(id, { filters: [{ filter_id: 'cat:payment_status', values: ['paid'] }] });
    expect(paid.rows_in_scope).toBeLessThan(all.rows_total);
    expect(paid.widgets.map((w) => w.widget_id)).toEqual(board.widgets.map((w) => w.id));
    expect(paid.widgets[0]!.rows).not.toEqual(all.widgets[0]!.rows);
    // The record count equals the rows in scope.
    expect(all.widgets[0]!.rows[0]!.orders).toBe(all.rows_total);
    expect(paid.widgets[0]!.rows[0]!.orders).toBe(paid.rows_in_scope);
    expect(all.widgets.filter((w) => w.error)).toHaveLength(1);
    const refunds = paid.widgets.find((w) => w.widget_id === board.widgets.at(-1)!.id)!;
    expect(refunds.rows).toEqual([]);
    const dated = await getDashboardData(id, { filters: [{ filter_id: 'date', from: '2026-10-05', to: '2026-10-07' }] });
    expect(dated.rows_in_scope).toBeLessThan(all.rows_total);
  });

  it('422 for an unknown filter, a backwards range or values on a date; 409 while planning', async () => {
    const id = ids['Webstore orders October']!;
    await planDashboard(id);
    expect((await caught(getDashboardData(id, { filters: [] })))?.code).toBe('dashboard_not_ready');
    await getDashboard(id);
    await getDashboard(id);
    await getDashboard(id);
    expect((await caught(getDashboardData(id, { filters: [{ filter_id: 'cat:nope', values: ['x'] }] })))?.code).toBe('validation_failed');
    expect((await caught(getDashboardData(id, { filters: [{ filter_id: 'date', from: '2026-10-09', to: '2026-10-01' }] })))?.code).toBe('validation_failed');
    expect((await caught(getDashboardData(id, { filters: [{ filter_id: 'date', values: ['x'] }] })))?.code).toBe('validation_failed');
  });

  it('failed and fallback examples', async () => {
    const office = ids['Office expenses']!;
    expect(await planUntilDone(office)).toEqual(['planning', 'planning', 'failed']);
    expect((await getDashboard(office)).error_message).toBeTruthy();
    const bank = ids['Bank statement October']!;
    await planUntilDone(bank);
    expect((await getDashboard(bank)).fallback).toBe(true);
  });

  it(`at most ${MOCK_PLANS_PER_DAY} plans a day per file (429); not for a file that is not ready`, async () => {
    const id = ids['Bank statement October']!;
    for (let i = 0; i < MOCK_PLANS_PER_DAY; i++) await planUntilDone(id);
    const limited = await caught(planDashboard(id));
    expect(limited?.status).toBe(429);
    expect(limited?.serverMessage).toMatch(/5 times a day/);
    expect((await caught(planDashboard(ids['Card sales full year']!)))?.code).toBe('dataset_not_ready');
    expect((await caught(planDashboard(ids['Card sales August']!)))?.code).toBe('dataset_expired');
  });
});
