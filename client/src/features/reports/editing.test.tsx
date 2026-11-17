import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { configureApiClient, type Transport } from '@/api/client';
import { BLOCK_TEMPLATES, blockFrom } from '@/api/mocks/blockFixtures';
import { buildMe, newMockUser } from '@/api/mocks/data';
import type { Block, ReportDetail } from '@/api/types';
import { SessionProvider } from '@/auth/SessionProvider';
import { signedIn } from '@/test/session';
import { ALL_IN_REPORT } from './AddAnswersDialog';
import { EDIT_BAR_GAP, REPORT_FULL, ReportPage } from './ReportPage';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const EVIL = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 1">';

const makeBlock = (key: string, over: Partial<Block> = {}): Block => ({
  ...blockFrom(BLOCK_TEMPLATES.find((t) => t.key === key)!, { question: `Question ${key}`, datasetId: 'd1', source: 'user', createdAt: '2026-11-02T10:00:00+02:00' }),
  id: `b-${key}`,
  ...over,
});

function makeReport(blocks: Block[]): ReportDetail {
  return {
    id: 'r1',
    workspace_id: 'w1',
    title: 'October review',
    subtitle: null,
    period_label: null,
    notes: null,
    template_id: null,
    block_count: blocks.length,
    created_at: '2026-11-02T10:00:00+02:00',
    updated_at: '2026-11-02T10:00:00+02:00',
    brand: { business_name: null, logo_url: null, color: '#1E7A5F' },
    watermark: false,
    blocks: blocks.map((block, position) => ({ position, heading_override: null, block })),
    comparison: null,
  };
}

/** The file's answers: one already in the report, two that are not (newest first). */
const HISTORY = [makeBlock('daily', { id: 'n1', title: 'Sales per day', question: 'What were sales per day?' }), makeBlock('refunds', { id: 'n2', title: 'Refunds in October' }), makeBlock('by-store')];

function setup(report: ReportDetail, opts: { history?: Block[]; ask?: (body: unknown) => Response } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const user = newMockUser('owner@example.co.za', 'x');
  user.plan = 'solo';
  const transport: Transport = async (url, init) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname.replace('/api/v1', '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === '/me') return json(200, { data: buildMe(user) });
    if (path === '/reports/r1' && method === 'GET') return json(200, { data: report });
    if (path === '/reports/r1' && method === 'PATCH') return json(200, { data: report });
    if (path === '/datasets') {
      return json(200, { data: { items: [{ id: 'd1', workspace_id: 'w1', name: 'Card sales', status: 'ready', expires_at: null }], total: 1, limit: 200, offset: 0 } });
    }
    if (path === '/datasets/d1/blocks') return json(200, { data: { items: opts.history ?? HISTORY, total: (opts.history ?? HISTORY).length, limit: 20, offset: 0 } });
    if (path === '/datasets/d1/ask' && method === 'POST') return opts.ask ? opts.ask(body) : json(500, { error: { code: 'internal', message: 'x' } });
    if (path.startsWith('/datasets/d1')) return json(200, { data: { id: 'd1', workspace_id: 'w1', name: 'Card sales', status: 'ready', expires_at: null, columns: [] } });
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={signedIn}>
        <MemoryRouter initialEntries={['/reports/r1']}>
          <Routes>
            <Route path="/reports/:id" element={<ReportPage />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { calls, view, patches: () => calls.filter((c) => c.method === 'PATCH') };
}

const answerHeadings = () =>
  within(screen.getByRole('list', { name: 'Answers in this report' }))
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent);

async function openPicker() {
  await userEvent.click(await screen.findByRole('button', { name: 'Edit report' }));
  await userEvent.click(screen.getAllByRole('button', { name: 'Add an answer' })[0]!);
  return screen.findByRole('dialog');
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { __pwned?: number }).__pwned;
});

describe('editing a report: the bottom bar', () => {
  it('never covers content: the report keeps room for the bar, and focused fields scroll clear of it', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-edit-bar') ? 120 : 0;
    });
    setup(makeReport([makeBlock('by-store')]));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit report' }));
    const root = document.querySelector<HTMLElement>('[data-report-root]')!;
    await waitFor(() => expect(root.style.paddingBottom).toBe(`${120 + EDIT_BAR_GAP}px`));
    expect(document.documentElement.style.scrollPaddingBottom).toBe(`${120 + EDIT_BAR_GAP}px`);
    await userEvent.click(within(document.querySelector<HTMLElement>('[data-edit-bar]')!).getByRole('button', { name: 'Cancel' }));
    expect(root.style.paddingBottom).toBe('');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('');
  });

  it('"Add an answer" is at the end of the answers and in the bar, with the count; at 30 it is disabled and says why', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => makeBlock('fees', { id: `m${i}` }));
    setup(makeReport(thirty));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit report' }));
    const buttons = screen.getAllByRole('button', { name: 'Add an answer' });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toBeDisabled();
    expect(screen.getAllByText('30 of 30 answers')).toHaveLength(2);
    expect(screen.getAllByText(REPORT_FULL)).toHaveLength(2);
  });
});

describe('editing a report: the picker', () => {
  it('opens on the report’s main file and lists only answers not yet in the report, newest first', async () => {
    setup(makeReport([makeBlock('by-store')]));
    const dialog = await openPicker();
    expect(await within(dialog).findByLabelText('File')).toHaveValue('d1');
    const list = await within(dialog).findByRole('list', { name: 'Answers from this file' });
    const titles = within(list).getAllByRole('checkbox').map((c) => c.closest('li')!.querySelector('span')!.textContent);
    expect(titles).toEqual(['Sales per day', 'Refunds in October']);
    expect(within(list).queryByText('Net sales by store')).not.toBeInTheDocument();
  });

  it('search narrows the list by title or question', async () => {
    setup(makeReport([makeBlock('by-store')]));
    const dialog = await openPicker();
    await userEvent.type(await within(dialog).findByRole('searchbox', { name: "Search this file's answers" }), 'per day');
    const list = within(dialog).getByRole('list', { name: 'Answers from this file' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
    expect(list).toHaveTextContent('Sales per day');
  });

  it('says so in one sentence when every answer for the file is already in the report', async () => {
    setup(makeReport([makeBlock('by-store')]), { history: [makeBlock('by-store')] });
    const dialog = await openPicker();
    expect(await within(dialog).findByText(ALL_IN_REPORT)).toBeInTheDocument();
  });
});

describe('editing a report: asking a new question in the picker', () => {
  it('adds the new answer at the end of the edit list and enables Save; nothing is sent to the report until Save', async () => {
    const answer = makeBlock('fees', { id: 'new1', title: EVIL, question: 'How much were the fees?' });
    const { calls, patches } = setup(makeReport([makeBlock('by-store')]), { ask: () => json(201, { data: answer }) });
    const dialog = await openPicker();
    expect(within(dialog).getByText(/questions used this month/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Ask a new question about this file' }), 'How much were the fees?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask and add to the report' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: '/datasets/d1/ask', body: { question: 'How much were the fees?', source: 'user' } });
    // At the end, as text (the title from the API stays inert).
    expect(answerHeadings()).toEqual(['Net sales by store', EVIL]);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect((patches()[0]!.body as { blocks: Array<{ block_id: string }> }).blocks.map((b) => b.block_id)).toEqual(['b-by-store', 'new1']);
  });

  it.each([
    [409, { code: 'dataset_not_ready', message: 'x' }, {}, 'This file is not ready for questions yet. Open the file to see how it is going.'],
    [410, { code: 'dataset_expired', message: 'x' }, {}, 'The original file was deleted. You can still read your earlier answers.'],
    [422, { code: 'cannot_answer', message: 'This file has no weather data.' }, {}, 'This file has no weather data.'],
    [429, { code: 'rate_limited', message: 'x' }, { 'Retry-After': '12' }, "You're asking quickly; wait 12 seconds and try again."],
    [502, { code: 'llm_failed', message: 'x' }, {}, "We couldn't get an answer just now. Nothing was used from your allowance. Try again."],
  ])('%s is said in words and nothing is added', async (status, error, headers, message) => {
    setup(makeReport([makeBlock('by-store')]), { ask: () => json(status, { error }, headers) });
    const dialog = await openPicker();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Ask a new question about this file' }), 'Will it rain tomorrow?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask and add to the report' }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    if (error.code === 'cannot_answer') expect(within(dialog).getByText('Nothing was added to the report.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(answerHeadings()).toEqual(['Net sales by store']);
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });

  it('402 opens the upgrade dialog, and nothing is added', async () => {
    setup(makeReport([makeBlock('by-store')]), {
      ask: () => json(402, { error: { code: 'plan_limit', message: 'x', details: { limit_key: 'max_questions_per_month', limit: 300, used: 300, upgrade_to: 'practice' } } }),
    });
    const dialog = await openPicker();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Ask a new question about this file' }), 'How much were the fees?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask and add to the report' }));
    expect(await screen.findByText('Your Solo plan includes 300 questions a month. You have used 300 this month.')).toBeInTheDocument();
    // Closing the upgrade dialog returns to the picker; leaving it changes nothing.
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]!);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(answerHeadings()).toEqual(['Net sales by store']);
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });

  it('a question that is too short is refused before anything is sent', async () => {
    const { calls } = setup(makeReport([makeBlock('by-store')]));
    const dialog = await openPicker();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Ask a new question about this file' }), 'hi');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask and add to the report' }));
    expect(within(dialog).getByText('Write at least 3 characters.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
