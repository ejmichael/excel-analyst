import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardFilterValue } from '@/api/types';
import { dataset } from '@/features/datasets/workspace/testing';
import { DashboardTab } from './DashboardTab';
import { parseFilters, sendable, serialiseFilters, toRequest } from './filters';
import { dashboard, data, fakeCalls, renderTab, result, urlFilters, widget, type Call } from './testing';

const ds = dataset();
const tab = <DashboardTab dataset={ds} />;
const board = dashboard();
const filterParam = (value: unknown) => `?filters=${encodeURIComponent(JSON.stringify(value))}`;

/** A ready dashboard whose data answer reports how many filters it was asked for, as the kpi value. */
function server(answer?: (filters: DashboardFilterValue[], call: Call) => ReturnType<Parameters<typeof fakeCalls>[0]> | undefined) {
  return fakeCalls((call) => {
    if (call.path.endsWith('/data')) {
      const filters = (call.body as { filters: DashboardFilterValue[] }).filters;
      return answer?.(filters, call) ?? { body: data([result('w1', { rows: [{ n: filters.length }] })], { rows_in_scope: filters.length ? 9 : 25 }) };
    }
    if (call.method === 'POST') return { status: 202, body: dashboard({ status: 'planning' }) };
    return { body: board };
  });
}

const kpi = () => screen.getByText((_, el) => el?.hasAttribute('data-kpi-value') ?? false);
const sent = (api: ReturnType<typeof fakeCalls>) => api.dataCalls().map((c) => (c.body as { filters: DashboardFilterValue[] }).filters);

describe('filters: reading and writing ?filters=', () => {
  const filters = board.filters;

  it('keeps only what fits this dashboard; anything else is ignored', () => {
    const raw = JSON.stringify({
      date: ['2026-10-05', null],
      'cat:store': ['Durban', 'Atlantis', 'Durban'],
      'cat:unknown': ['x'],
    });
    expect(parseFilters(raw, filters)).toEqual({ date: { from: '2026-10-05', to: null }, 'cat:store': ['Durban'] });
    expect(parseFilters('{not json', filters)).toEqual({});
    expect(parseFilters('[1,2]', filters)).toEqual({});
    expect(parseFilters(JSON.stringify({ date: ['2026-13-40', 'soon'] }), filters)).toEqual({});
    // Backwards is kept (the bar shows why) but left out of requests.
    const backwards = parseFilters(JSON.stringify({ date: ['2026-10-09', '2026-10-01'], 'cat:store': ['Durban'] }), filters);
    expect(backwards).toEqual({ date: { from: '2026-10-09', to: '2026-10-01' }, 'cat:store': ['Durban'] });
    expect(toRequest(sendable(backwards), filters)).toEqual([{ filter_id: 'cat:store', values: ['Durban'] }]);
    expect(parseFilters(JSON.stringify({ date: '2026-10-01', 'cat:store': 'Durban' }), filters)).toEqual({});
    expect(parseFilters(JSON.stringify({ 'cat:store': ['Atlantis'] }), filters)).toEqual({});
  });

  it('writes compact JSON in the dashboard order, and builds the request body', () => {
    const state = { 'cat:store': ['Durban'], date: { from: null, to: '2026-10-09' } };
    expect(serialiseFilters(state, filters)).toBe('{"date":[null,"2026-10-09"],"cat:store":["Durban"]}');
    expect(serialiseFilters({}, filters)).toBeNull();
    expect(toRequest(state, filters)).toEqual([
      { filter_id: 'date', from: null, to: '2026-10-09' },
      { filter_id: 'cat:store', values: ['Durban'] },
    ]);
  });
});

describe('the filter bar', () => {
  it('renders both kinds from the contract, in the order sent, with the row count from the server', async () => {
    server();
    renderTab(tab);
    const bar = await screen.findByRole('region', { name: 'Filters' });
    const group = within(bar).getByRole('group', { name: 'Sale date' });
    const from = within(group).getByLabelText('From');
    expect(from).toHaveAttribute('type', 'date');
    expect(from).toHaveAttribute('min', '2026-10-01');
    expect(from).toHaveAttribute('max', '2026-10-31');
    expect(within(group).getByLabelText('To')).toHaveAttribute('max', '2026-10-31');
    expect(within(bar).getByRole('button', { name: 'Store: All' })).toHaveAttribute('aria-expanded', 'false');
    expect(await within(bar).findByText('25 of 25 rows')).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('is not shown at all when the dashboard has no filters', async () => {
    fakeCalls((call) => (call.path.endsWith('/data') ? { body: data([result('w1')]) } : { body: dashboard({ filters: [] }) }));
    renderTab(tab);
    await screen.findByText(/Analyst read this file as:/);
    expect(screen.queryByRole('region', { name: 'Filters' })).not.toBeInTheDocument();
    expect(screen.queryByText(/of 25 rows/)).not.toBeInTheDocument();
  });

  it('From later than To: an inline message and no request', async () => {
    const api = server();
    renderTab(tab);
    await screen.findByText('25 of 25 rows');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('From must be on or before To');
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true');
    await act(() => new Promise((r) => setTimeout(r, 450)));
    expect(sent(api)).toEqual([[]]);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-25' } });
    await waitFor(() => expect(sent(api)).toHaveLength(2));
    expect(sent(api)[1]).toEqual([{ filter_id: 'date', from: '2026-10-20', to: '2026-10-25' }]);
    expect(screen.queryByText('From must be on or before To')).not.toBeInTheDocument();
  });

  it('category: search, Select all and Clear inside the list; the button counts the selection', async () => {
    server();
    renderTab(tab);
    const button = await screen.findByRole('button', { name: 'Store: All' });
    await userEvent.click(button);
    const list = screen.getByRole('dialog', { name: 'Store' });
    expect(within(list).getByRole('searchbox', { name: 'Search Store' })).toHaveFocus();
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
    await userEvent.type(within(list).getByRole('searchbox'), 'ur');
    expect(within(list).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['Durban']);
    await userEvent.clear(within(list).getByRole('searchbox'));
    await userEvent.type(within(list).getByRole('searchbox'), 'zzz');
    expect(within(list).getByText('No values match “zzz”.')).toBeInTheDocument();
    await userEvent.clear(within(list).getByRole('searchbox'));
    await userEvent.click(within(list).getByRole('button', { name: 'Select all' }));
    expect(within(list).getAllByRole('checkbox').every((c) => (c as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Store: 3 selected' })).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: 'Store: All' })).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('checkbox', { name: 'Pretoria' }));
    expect(screen.getByRole('button', { name: 'Store: 1 selected' })).toBeInTheDocument();
  });

  it('keyboard: Escape closes the list and returns focus to its button; the button shows a focus ring', async () => {
    server();
    renderTab(tab);
    const button = await screen.findByRole('button', { name: 'Store: All' });
    expect(button.className).toMatch(/focus-visible:ring-2/);
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Store' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole('checkbox', { name: 'Durban' })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('checkbox', { name: 'Durban' })).toBeChecked();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Store' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Store: 1 selected' })).toHaveFocus();
  });

  it('Clear all removes every filter', async () => {
    const { router } = (server(), renderTab(tab, { path: `/datasets/d1/dashboard${filterParam({ 'cat:store': ['Durban'], date: ['2026-10-02', null] })}` }));
    expect(await screen.findByText('9 of 25 rows')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(urlFilters(router)).toBeNull();
    expect(screen.getByRole('button', { name: 'Store: All' })).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveValue('');
    expect(await screen.findByText('25 of 25 rows')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });
});

describe('filters and the data requests', () => {
  it('the URL keeps the filters; the first request uses them; an invalid value is ignored', async () => {
    const api = server();
    const { router } = renderTab(tab, {
      path: `/datasets/d1/dashboard${filterParam({ 'cat:store': ['Sandton', 'Nowhere'], 'cat:gone': ['x'] })}`,
    });
    expect(await screen.findByRole('button', { name: 'Store: 1 selected' })).toBeInTheDocument();
    await waitFor(() => expect(sent(api)).toHaveLength(1));
    expect(sent(api)[0]).toEqual([{ filter_id: 'cat:store', values: ['Sandton'] }]);
    await userEvent.click(screen.getByRole('button', { name: 'Store: 1 selected' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Durban' }));
    expect(urlFilters(router)).toEqual({ 'cat:store': ['Durban', 'Sandton'] });
  });

  it('a malformed ?filters= is ignored: the unfiltered request runs', async () => {
    const api = server();
    renderTab(tab, { path: '/datasets/d1/dashboard?filters=%7Bnope' });
    await screen.findByText('25 of 25 rows');
    expect(sent(api)).toEqual([[]]);
  });

  it('a burst of changes sends one request once it settles, and never the planning POST', async () => {
    const api = server();
    renderTab(tab);
    await screen.findByText('25 of 25 rows');
    await userEvent.click(screen.getByRole('button', { name: 'Store: All' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Durban' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Pretoria' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sandton' }));
    await waitFor(() => expect(sent(api)).toHaveLength(2));
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(sent(api)).toHaveLength(2);
    expect(sent(api)[1]).toEqual([{ filter_id: 'cat:store', values: ['Durban', 'Pretoria', 'Sandton'] }]);
    expect(await screen.findByText('9 of 25 rows')).toBeInTheDocument();
    expect(api.plans()).toHaveLength(0);
  });

  it('while the next results load the previous ones stay, dimmed; a late answer for older filters is ignored', async () => {
    const held: Array<(reply: { body: unknown }) => void> = [];
    const answerFor = (n: number) => ({ body: data([result('w1', { rows: [{ n }] })], { rows_in_scope: n }) });
    const api = server((filters) => {
      if (filters.length === 0) return answerFor(25);
      return new Promise((resolve) => held.push(resolve));
    });
    renderTab(tab);
    await screen.findByText('25 of 25 rows');
    const grid = document.querySelector('[data-widget-grid]')!;
    expect(grid).toHaveAttribute('aria-busy', 'false');

    await userEvent.click(screen.getByRole('button', { name: 'Store: All' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Durban' }));
    await waitFor(() => expect(sent(api)).toHaveLength(2));
    // Previous results on screen, dimmed and marked busy.
    expect(grid).toHaveAttribute('aria-busy', 'true');
    expect(grid.className).toMatch(/opacity-60/);
    expect(kpi()).toHaveTextContent('25');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Durban' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Pretoria' }));
    await waitFor(() => expect(sent(api)).toHaveLength(3));
    // The answer for Pretoria arrives first, then the late one for Durban.
    await act(async () => held[1]!(answerFor(7)));
    expect(await screen.findByText('7 of 25 rows')).toBeInTheDocument();
    expect(grid).toHaveAttribute('aria-busy', 'false');
    await act(async () => held[0]!(answerFor(3)));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByText('7 of 25 rows')).toBeInTheDocument();
    expect(kpi()).toHaveTextContent('7');
  });

  it('a filtered answer never changes the layout: the widgets and their order come from the dashboard', async () => {
    const two = dashboard({ widgets: [widget('w2', { title: 'Second', position: 2 }), widget('w1', { title: 'First', position: 1 })] });
    fakeCalls((call) => {
      if (!call.path.endsWith('/data')) return { body: two };
      const filtered = (call.body as { filters: unknown[] }).filters.length > 0;
      // A filtered answer lists the widgets in another order.
      return { body: data(filtered ? [result('w2'), result('w1')] : [result('w1'), result('w2')]) };
    });
    renderTab(tab);
    await screen.findByText('25 of 25 rows');
    const titles = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles()).toEqual(['First', 'Second']);
    await userEvent.click(screen.getByRole('button', { name: 'Store: All' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Durban' }));
    await waitFor(() => expect(document.querySelector('[data-widget-grid]')).toHaveAttribute('aria-busy', 'false'));
    expect(titles()).toEqual(['First', 'Second']);
  });

  it('429 on a filter change: the server message, a manual Retry, no automatic retry', async () => {
    let limited = true;
    const api = server((filters) =>
      filters.length && limited ? { status: 429, body: { code: 'rate_limited', message: 'Too many filter changes.' } } : undefined,
    );
    renderTab(tab);
    await screen.findByText('25 of 25 rows');
    await userEvent.click(screen.getByRole('button', { name: 'Store: All' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Durban' }));
    expect(await screen.findByText('Too many filter changes.')).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(sent(api)).toHaveLength(2);
    limited = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('9 of 25 rows')).toBeInTheDocument();
  });
});
