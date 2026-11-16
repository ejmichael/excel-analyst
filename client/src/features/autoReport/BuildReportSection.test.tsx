import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { configureApiClient, type Transport } from '@/api/client';
import { buildMe, newMockUser } from '@/api/mocks/data';
import type { AutoReportRun, DatasetDetail } from '@/api/types';
import { SessionProvider } from '@/auth/SessionProvider';
import { signedIn } from '@/test/session';
import { ALREADY_RUNNING, TOO_FEW_SUGGESTIONS } from './autoReportErrors';
import { autoReportFieldErrors, autoReportRequest } from './BuildReportDialog';
import { BuildReportSection, SLOW_MESSAGE } from './BuildReportSection';
import { AUTO_POLL_MS, AUTO_SLOW_AFTER_MS, AUTO_SLOW_POLL_MS, nextAutoReportPoll } from './queries';
import { runStore } from './runStore';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const SUGGESTIONS = ['Net sales by store?', 'Card fees in total?', 'Net sales per day?', 'Refunds?', 'Average sale per store?'].map((question) => ({
  question,
  why: 'Because.',
}));

function makeDataset(over: Partial<DatasetDetail> = {}): DatasetDetail {
  return {
    id: 'd1',
    workspace_id: 'w1',
    name: 'Card sales October',
    original_filename: 'card_sales.csv',
    file_type: 'csv',
    size_bytes: 20_000,
    row_count: 240,
    status: 'ready',
    error_message: null,
    error_details: null,
    warnings: [],
    expires_at: '2026-12-16T10:00:00+02:00',
    created_at: '2026-11-16T10:00:00+02:00',
    columns: [],
    parse_options: { delimiter: ';', header_row: 5, decimal_separator: ',', date_format: 'dmy' },
    sheet_names: [],
    preamble_lines: [],
    excluded_rows: 1,
    suggestions: SUGGESTIONS,
    ...over,
  };
}

const run = (over: Partial<AutoReportRun> = {}): AutoReportRun => ({
  id: 'run1',
  dataset_id: 'd1',
  status: 'running',
  blocks_done: 0,
  blocks_total: 5,
  report_id: null,
  error_message: null,
  created_at: '2026-11-16T10:00:00+02:00',
  ...over,
});

function Location() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname + location.search}</p>;
}

/** Renders the section on a dataset page. `answer` handles the auto-report calls; /me is answered here. */
function setup(answer: (path: string, init: RequestInit) => Response | null, dataset = makeDataset()) {
  const me = buildMe(newMockUser('owner@example.co.za', 'x'));
  me.usage.questions = 5; // 15 of 20 left on Free
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (path === '/me') return json(200, { data: me });
    return answer(path, init) ?? json(500, { error: { code: 'internal', message: 'x' } });
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={signedIn}>
        <MemoryRouter initialEntries={['/datasets/d1']}>
          <Routes>
            <Route path="/datasets/d1" element={<BuildReportSection dataset={dataset} />} />
            <Route path="*" element={<p>Elsewhere</p>} />
          </Routes>
          <Location />
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  const gets = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/auto-reports/')).length;
  return { calls, gets, view };
}

const remember = (over: Partial<{ run_id: string; started_at: number }> = {}) =>
  runStore.set('d1', { run_id: 'run1', request: { title: 'October' }, started_at: Date.now(), ...over });

beforeEach(() => {
  window.sessionStorage.clear();
  runStore.resetMemory();
});
afterEach(() => vi.restoreAllMocks());

describe('Build my report: the button', () => {
  it('shows the button, the sentence and the quota from Me on a ready file with at least 3 suggestions', async () => {
    setup(() => null);
    expect(screen.getByRole('button', { name: 'Build my report' })).toBeInTheDocument();
    expect(screen.getByText('Analyst answers the questions below and puts them in a draft report. You can change anything afterwards.')).toBeInTheDocument();
    expect(await screen.findByText('Uses up to 5 of your 15 questions left this month and 1 report.')).toBeInTheDocument();
  });

  it.each([
    ['fewer than 3 suggestions', makeDataset({ suggestions: SUGGESTIONS.slice(0, 2) })],
    ['a file that is not ready', makeDataset({ status: 'profiling' })],
  ])('is not shown for %s', (_name, dataset) => {
    setup(() => null, dataset);
    expect(screen.queryByRole('button', { name: 'Build my report' })).not.toBeInTheDocument();
  });
});

describe('Build my report: the dialog', () => {
  it('title up to 120 and period up to 60, both optional; only filled fields are sent', () => {
    expect(autoReportFieldErrors({ title: 'x'.repeat(120), period_label: 'x'.repeat(60) })).toEqual({});
    const long = autoReportFieldErrors({ title: 'x'.repeat(121), period_label: 'x'.repeat(61) });
    expect(long.title).toMatch(/120/);
    expect(long.period_label).toMatch(/60/);
    expect(autoReportRequest({ title: '  ', period_label: '' })).toEqual({});
    expect(autoReportRequest({ title: ' Review ', period_label: ' October 2026 ' })).toEqual({ title: 'Review', period_label: 'October 2026' });
  });

  it('defaults the title to the file name, sends nothing when empty, then shows the progress', async () => {
    const { calls } = setup((path, init) => {
      if (path === '/datasets/d1/auto-report' && init.method === 'POST') return json(202, { data: run() });
      if (path === '/auto-reports/run1') return json(200, { data: run() });
      return null;
    });
    await userEvent.click(screen.getByRole('button', { name: 'Build my report' }));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByRole('textbox', { name: 'Title (optional)' });
    expect(title).toHaveAttribute('placeholder', 'Card sales October');
    expect(title).toHaveAttribute('maxLength', '120');
    const period = within(dialog).getByRole('textbox', { name: 'Period (optional)' });
    expect(period).toHaveAttribute('placeholder', 'October 2026');
    expect(period).toHaveAttribute('maxLength', '60');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Answering question 1 of 5')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({});
    expect(screen.queryByRole('button', { name: 'Build my report' })).not.toBeInTheDocument();
  });

  const startWith = async (response: Response) => {
    setup((path, init) => (path === '/datasets/d1/auto-report' && init.method === 'POST' ? response : null));
    await userEvent.click(screen.getByRole('button', { name: 'Build my report' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start' }));
  };

  it('402 opens the upgrade dialog for the limit in details', async () => {
    await startWith(
      json(402, { error: { code: 'plan_limit', message: 'x', details: { limit_key: 'max_questions_per_month', limit: 20, used: 18, upgrade_to: 'solo' } } }),
    );
    expect(await screen.findByText('Your Free plan includes 20 questions a month. You have used 18 this month.')).toBeInTheDocument();
    expect(screen.getByText('The Solo plan includes more.')).toBeInTheDocument();
  });

  it.each([
    [409, 'conflict', ALREADY_RUNNING],
    [409, 'dataset_not_ready', 'This file is not ready for questions yet. Open the file to see how it is going.'],
    [410, 'dataset_expired', 'The original file was deleted on 16 December 2026. You can still read your earlier answers.'],
  ])('%s %s is said in words', async (status, code, message) => {
    await startWith(json(status, { error: { code, message: 'server text' } }));
    expect(await within(screen.getByRole('dialog')).findByText(message)).toBeInTheDocument();
  });

  it('422 for too few suggestions offers the Ask page; a 422 on the title shows next to it', async () => {
    await startWith(
      json(422, { error: { code: 'validation_failed', message: 'x', details: { fields: [{ location: 'params', path: 'id', message: 'Not enough.' }] } } }),
    );
    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert).toHaveTextContent(TOO_FEW_SUGGESTIONS);
    expect(within(alert).getByRole('link', { name: 'Ask your own questions' })).toHaveAttribute('href', '/datasets/d1/ask');
  });

  it('a 422 on the title shows next to the field', async () => {
    await startWith(
      json(422, { error: { code: 'validation_failed', message: 'x', details: { fields: [{ location: 'body', path: 'title', message: 'At most 120 characters.' }] } } }),
    );
    expect(await screen.findByText('At most 120 characters.')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Title (optional)' })).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Build my report: progress', () => {
  it('polls every 2 s, slower after 3 minutes, and stops at done or failed', () => {
    expect(nextAutoReportPoll('running', 0)).toBe(AUTO_POLL_MS);
    expect(AUTO_POLL_MS).toBe(2000);
    expect(nextAutoReportPoll('running', AUTO_SLOW_AFTER_MS)).toBe(AUTO_SLOW_POLL_MS);
    expect(nextAutoReportPoll('done', 0)).toBe(false);
    expect(nextAutoReportPoll('failed', 0)).toBe(false);
  });

  it('shows a determinate bar from blocks_done of blocks_total, announces the step, and opens the draft on done', async () => {
    remember();
    let polls = 0;
    const { gets } = setup((path) => {
      if (path !== '/auto-reports/run1') return null;
      polls += 1;
      return json(200, { data: polls < 2 ? run({ blocks_done: 1 }) : run({ status: 'done', blocks_done: 5, report_id: 'r9' }) });
    });
    const bar = await screen.findByRole('progressbar', { name: 'Building your report' });
    expect(bar).toHaveAttribute('value', '1');
    expect(bar).toHaveAttribute('max', '5');
    const step = screen.getByText('Answering question 2 of 5');
    expect(step).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/reports/r9?draft=1'));
    expect(gets()).toBe(2);
    // The run is finished: nothing is remembered for the file any more.
    expect(runStore.get('d1')).toBeNull();
  });

  it('stops polling at failed, and shows the message with two buttons; Try again sends the same request', async () => {
    remember();
    const { gets, calls } = setup((path, init) => {
      if (path === '/auto-reports/run1') return json(200, { data: run({ status: 'failed', blocks_done: 5, error_message: '<b>We could only answer 2 of the 5 questions.</b>' }) });
      if (path === '/datasets/d1/auto-report' && init.method === 'POST') return json(202, { data: run({ id: 'run2' }) });
      if (path === '/auto-reports/run2') return json(200, { data: run({ id: 'run2', blocks_done: 1 }) });
      return null;
    });
    const panel = await screen.findByRole('alert');
    // API text is shown as text, never as markup.
    expect(panel).toHaveTextContent('<b>We could only answer 2 of the 5 questions.</b>');
    expect(panel.querySelector('b')).toBeNull();
    expect(panel).toHaveTextContent("Any answers already made are kept in this file's history.");
    expect(within(panel).getByRole('link', { name: 'Ask your own questions' })).toHaveAttribute('href', '/datasets/d1/ask');
    await sleep(AUTO_POLL_MS + 500);
    expect(gets()).toBe(1);

    await userEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Answering question 2 of 5')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title: 'October' });
    expect(runStore.get('d1')?.run_id).toBe('run2');
  });

  it('stops polling when the page is left', async () => {
    remember();
    const { gets, view } = setup((path) => (path === '/auto-reports/run1' ? json(200, { data: run({ blocks_done: 1 }) }) : null));
    await screen.findByText('Answering question 2 of 5');
    view.unmount();
    const before = gets();
    await sleep(AUTO_POLL_MS + 500);
    expect(gets()).toBe(before);
  });

  it('after 3 minutes says it is taking longer than usual', async () => {
    remember({ started_at: Date.now() - AUTO_SLOW_AFTER_MS - 1000 });
    setup((path) => (path === '/auto-reports/run1' ? json(200, { data: run({ blocks_done: 3 }) }) : null));
    expect(await screen.findByText(SLOW_MESSAGE)).toBeInTheDocument();
  });

  it('a run that finished before this visit is offered, and dismissing it brings the button back', async () => {
    remember();
    setup((path) => (path === '/auto-reports/run1' ? json(200, { data: run({ status: 'done', blocks_done: 5, report_id: 'r9' }) }) : null));
    expect(await screen.findByRole('link', { name: 'Open the draft report' })).toHaveAttribute('href', '/reports/r9?draft=1');
    expect(screen.getByTestId('location')).toHaveTextContent('/datasets/d1');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('button', { name: 'Build my report' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem('analyst.auto-report.d1')).toBeNull();
  });
});

describe('Build my report: remembering the run', () => {
  it('resumes from sessionStorage after a reload', async () => {
    window.sessionStorage.setItem('analyst.auto-report.d1', JSON.stringify({ run_id: 'run7', request: {}, started_at: Date.now() }));
    const { calls } = setup((path) => (path === '/auto-reports/run7' ? json(200, { data: run({ id: 'run7', blocks_done: 2 }) }) : null));
    expect(await screen.findByText('Answering question 3 of 5')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auto-reports/run7')).toBe(true);
  });

  it('falls back to memory when sessionStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { view } = setup((path, init) => {
      if (path === '/datasets/d1/auto-report' && init.method === 'POST') return json(202, { data: run() });
      if (path === '/auto-reports/run1') return json(200, { data: run({ blocks_done: 1 }) });
      return null;
    });
    await userEvent.click(screen.getByRole('button', { name: 'Build my report' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Answering question 2 of 5')).toBeInTheDocument();
    view.unmount();
    // Coming back in the same tab: still remembered.
    setup((path) => (path === '/auto-reports/run1' ? json(200, { data: run({ blocks_done: 2 }) }) : null));
    expect(await screen.findByText('Answering question 3 of 5')).toBeInTheDocument();
  });
});
