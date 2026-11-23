import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dataset } from '@/features/datasets/workspace/testing';
import { DashboardTab } from './DashboardTab';
import { PLANNING_POLL_MS, PLANNING_SLOW_MS } from './queries';
import { dashboard, data, fakeCalls, renderTab, result, type Call } from './testing';

const ds = dataset();
const tab = <DashboardTab dataset={ds} />;
const NOT_FOUND = { status: 404, body: { code: 'not_found', message: 'No dashboard yet.' } };
const planning = dashboard({ status: 'planning', reading: { text: '', date_column: null }, filters: [], widgets: [] });

/** A server whose GET answers 404 until a POST, then `planning` for `polls - 1` GETs, then `outcome`. */
function planningServer(outcome = dashboard(), polls = 3) {
  let planned = false;
  let seen = 0;
  return fakeCalls((call: Call) => {
    if (call.path.endsWith('/data')) return { body: data([result('w1')]) };
    if (call.method === 'POST') {
      planned = true;
      return { status: 202, body: planning };
    }
    if (!planned) return NOT_FOUND;
    seen += 1;
    return { body: seen >= polls ? outcome : planning };
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Dashboard tab: planning starts once', () => {
  it('a 404 sends exactly one POST, then polls every 2 s and stops at ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = planningServer();
    renderTab(tab);
    const card = (await screen.findByText('Analyst is planning your dashboard')).closest('[role="status"]');
    expect(card).toHaveTextContent('This takes about a minute the first time.');
    expect(api.plans()).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS));
    expect(await screen.findByText(/Analyst read this file as:/)).toBeInTheDocument();
    const gets = api.gets().length;
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS * 5));
    expect(api.gets()).toHaveLength(gets);
    expect(api.plans()).toHaveLength(1);
  });

  it('strict mode (effects run twice) still sends one POST', async () => {
    const api = fakeCalls((call) => (call.method === 'POST' ? new Promise(() => {}) : NOT_FOUND));
    renderTab(tab, { strict: true });
    expect(await screen.findByText('Analyst is planning your dashboard')).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(api.plans()).toHaveLength(1);
  });

  it('leaving the tab and coming back neither sends a second POST nor cancels the first', async () => {
    let release: (v: { status: number; body: unknown }) => void = () => {};
    const api = fakeCalls((call) =>
      call.method === 'POST' ? new Promise((r) => (release = r)) : call.path.endsWith('/data') ? { body: data([]) } : NOT_FOUND,
    );
    const { router } = renderTab(tab);
    await screen.findByText('Analyst is planning your dashboard');
    await act(() => router.navigate('/elsewhere'));
    expect(screen.getByText('Elsewhere')).toBeInTheDocument();
    await act(() => router.navigate('/datasets/d1/dashboard'));
    expect(await screen.findByText('Analyst is planning your dashboard')).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(api.plans()).toHaveLength(1);
    // The first request finishes even though its tab was closed meanwhile; polling picks up from there.
    await act(async () => release({ status: 202, body: planning }));
    expect(screen.getByText('Analyst is planning your dashboard')).toBeInTheDocument();
    expect(api.plans()).toHaveLength(1);
  });

  it('after 60 s planning: "Taking longer than usual"; coming back to the tab resumes polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeCalls(() => ({ body: planning }));
    const { router } = renderTab(tab);
    await screen.findByText('Analyst is planning your dashboard');
    expect(screen.queryByText(/Taking longer than usual/)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_SLOW_MS));
    expect(await screen.findByText('Taking longer than usual. You can keep using the other tabs.')).toBeInTheDocument();
    await act(() => router.navigate('/elsewhere'));
    const before = api.gets().length;
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS * 3));
    expect(api.gets()).toHaveLength(before);
    await act(() => router.navigate('/datasets/d1/dashboard'));
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS));
    expect(api.gets().length).toBeGreaterThan(before);
    expect(screen.getByText('Taking longer than usual. You can keep using the other tabs.')).toBeInTheDocument();
    expect(api.plans()).toHaveLength(0);
  });
});

describe('Dashboard tab: failed, fallback and rebuild', () => {
  it('failed: the server message, Try again (POST) and a link to Ask; polling stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const failed = dashboard({ status: 'failed', error_message: 'This file has too few columns to chart.' });
    const api = planningServer(failed, 2);
    renderTab(tab);
    await screen.findByText('Analyst is planning your dashboard');
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This file has too few columns to chart.');
    expect(within(alert).getByRole('link', { name: 'Ask a question instead' })).toHaveAttribute('href', '/datasets/d1/ask');
    const gets = api.gets().length;
    await act(() => vi.advanceTimersByTimeAsync(PLANNING_POLL_MS * 4));
    expect(api.gets()).toHaveLength(gets);
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(api.plans()).toHaveLength(2);
    expect(await screen.findByText('Analyst is planning your dashboard')).toBeInTheDocument();
  });

  it('fallback: a muted note above the filters with Try again', async () => {
    const api = fakeCalls((call) =>
      call.method === 'POST' && !call.path.endsWith('/data')
        ? { status: 202, body: planning }
        : call.path.endsWith('/data')
          ? { body: data([result('w1')]) }
          : { body: dashboard({ fallback: true }) },
    );
    renderTab(tab);
    const note = await screen.findByText('This is a basic dashboard. Analyst could not plan a custom one for this file.');
    const box = note.closest('[data-dashboard-fallback]') as HTMLElement;
    const filters = screen.getByRole('region', { name: 'Filters' });
    expect(box.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(api.plans()).toHaveLength(0);
    await userEvent.click(within(box).getByRole('button', { name: 'Try again' }));
    expect(api.plans()).toHaveLength(1);
  });

  it('no fallback note on a planned dashboard', async () => {
    fakeCalls((call) => (call.path.endsWith('/data') ? { body: data([result('w1')]) } : { body: dashboard() }));
    renderTab(tab);
    await screen.findByText(/Analyst read this file as:/);
    expect(screen.queryByText(/This is a basic dashboard/)).not.toBeInTheDocument();
  });

  it('Rebuild dashboard asks first; Keep this one sends nothing, Rebuild sends one POST', async () => {
    const api = fakeCalls((call) =>
      call.path.endsWith('/data') ? { body: data([result('w1')]) } : call.method === 'POST' ? { status: 202, body: planning } : { body: dashboard() },
    );
    renderTab(tab);
    expect(await screen.findByText('card sales, one row per sale, with amounts in rand')).toBeInTheDocument();
    expect(screen.getByText(/Analyst read this file as:/).closest('p')).toHaveTextContent(
      'Analyst read this file as: card sales, one row per sale, with amounts in rand',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Rebuild dashboard' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Analyst will plan the dashboard again and replace this one.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep this one' }));
    expect(api.plans()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Rebuild dashboard' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild dashboard' }));
    expect(await screen.findByText('Analyst is planning your dashboard')).toBeInTheDocument();
    expect(api.plans()).toHaveLength(1);
  });
});

describe('Dashboard tab: errors in words', () => {
  it.each([
    [409, 'dataset_not_ready', 'This file is still being read. Try again in a moment.', true],
    [410, 'dataset_expired', 'This file has expired, so its dashboard can no longer be shown.', false],
    [429, 'rate_limited', 'Slow down, please.', true],
  ])('reading the dashboard: %i says so', async (status, code, words, retry) => {
    const api = fakeCalls(() => ({ status, body: { code, message: 'Slow down, please.' } }));
    renderTab(tab);
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(Boolean(screen.queryByRole('button', { name: 'Try again' }))).toBe(retry);
    expect(api.gets()).toHaveLength(1);
    expect(api.plans()).toHaveLength(0);
  });

  it('planning refused with 429: the server message, no automatic retry and no Try again', async () => {
    const api = fakeCalls((call) =>
      call.method === 'POST'
        ? { status: 429, body: { code: 'rate_limited', message: 'A dashboard can be planned 5 times a day for each file. Try again tomorrow.' } }
        : NOT_FOUND,
    );
    renderTab(tab);
    expect(await screen.findByText('A dashboard can be planned 5 times a day for each file. Try again tomorrow.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask a question instead' })).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(api.plans()).toHaveLength(1);
  });

  it('a network failure says so, with Try again', async () => {
    let fail = true;
    configureFailing();
    function configureFailing() {
      fakeCalls(() => {
        if (fail) throw new TypeError('Failed to fetch');
        return { body: dashboard() };
      });
    }
    renderTab(tab);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByText(/Analyst read this file as:/)).toBeInTheDocument();
  });
});
