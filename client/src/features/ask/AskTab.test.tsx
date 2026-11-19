import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { configureApiClient, type Transport } from '@/api/client';
import { mockAuthBackend } from '@/api/mocks/auth';
import { mockTransport, setMockLatency } from '@/api/mocks/handlers';
import { mockStore } from '@/api/mocks/store';
import { SessionProvider } from '@/auth/SessionProvider';
import { routes } from '@/routes';
import { ASK_OWN_HINT, askDisabledReason } from './AskForm';

async function signInDemo() {
  setMockLatency(0);
  mockStore.reset();
  await mockAuthBackend.signIn('demo@example.co.za', 'password123');
  const user = mockStore.findUser('demo@example.co.za')!;
  user.popia_consent_at = '2026-11-01T09:00:00+02:00';
  // The seeded file that is still being read: make it ready now.
  const reading = user.datasets!.find((d) => d.detail.status === 'profiling')!;
  reading.profiling_until = 0;
  return { user, datasetId: reading.detail.id };
}

function renderAt(path: string, transport: Transport = mockTransport) {
  configureApiClient({ transport, refreshAccessToken: async () => null });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider backend={mockAuthBackend}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('Ask page', () => {
  // The route loads AskPage on demand; load it once up front so each test renders straight away.
  beforeAll(async () => {
    await import('./AskTab');
  }, 30_000);

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('auto-asks once from ?q= (as a suggestion when it matches one) and removes q from the URL', async () => {
    const { datasetId } = await signInDemo();
    const calls: Array<{ question: string; source?: string }> = [];
    const transport: Transport = async (url, init) => {
      if (url.endsWith('/ask')) calls.push(JSON.parse(String(init.body)));
      return mockTransport(url, init);
    };
    const q = 'Which store had the highest net sales in October?';
    const router = renderAt(`/datasets/${datasetId}/ask?q=${encodeURIComponent(q)}`, transport);

    const newest = await screen.findByRole('region', { name: 'Newest answer' }, { timeout: 3000 });
    expect(within(newest).getByRole('heading', { name: 'Net sales by store' })).toHaveFocus();
    expect(calls).toEqual([{ question: q, source: 'suggested' }]);
    expect(router.state.location.search).toBe('');
    expect(router.state.historyAction).toBe('REPLACE');
    // The newest answer opens "How this was calculated".
    expect(within(newest).getByRole('button', { name: 'How this was calculated' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('a new answer starts fresh: panels opened on the previous answer are closed again', async () => {
    const { datasetId } = await signInDemo();
    renderAt(`/datasets/${datasetId}/ask`);
    const box = await screen.findByLabelText('Ask your own question about this file');
    await userEvent.type(box, 'Which transactions were refunds?{Enter}');
    let newest = await screen.findByRole('region', { name: 'Newest answer' }, { timeout: 3000 });
    await userEvent.click(within(newest).getByRole('button', { name: 'Show the rows this is based on' }));
    expect(await within(newest).findByText(/Showing 1 to/)).toBeInTheDocument();

    await userEvent.type(box, 'What is the average sale per store?{Enter}');
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Newest answer' })).getByRole('heading', { level: 2 })).toHaveTextContent('Average sale per store'));
    newest = screen.getByRole('region', { name: 'Newest answer' });
    expect(within(newest).getByRole('button', { name: 'Show the rows this is based on' })).toBeInTheDocument();
    expect(within(newest).queryByText(/Showing 1 to/)).not.toBeInTheDocument();
  });

  it('shows cannot_answer in a panel with the suggestions, and keeps the question', async () => {
    const { datasetId } = await signInDemo();
    renderAt(`/datasets/${datasetId}/ask`);
    const box = await screen.findByLabelText('Ask your own question about this file');
    await userEvent.type(box, 'Will it rain tomorrow?{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Analyst can't answer that from this file");
    expect(alert).toHaveTextContent('This file has no weather data');
    expect(within(alert).getAllByRole('button').length).toBeGreaterThan(0);
    expect(box).toHaveValue('Will it rain tomorrow?');
  });

  it('a 429 says how many seconds to wait, from Retry-After', async () => {
    const { datasetId } = await signInDemo();
    const transport: Transport = async (url, init) =>
      url.endsWith('/ask')
        ? new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
          })
        : mockTransport(url, init);
    renderAt(`/datasets/${datasetId}/ask`, transport);
    await userEvent.type(await screen.findByLabelText('Ask your own question about this file'), 'Total fees?{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent("You're asking quickly; wait 30 seconds and try again.");
  });

  it('opens the upgrade dialog on the monthly question limit', async () => {
    const { user, datasetId } = await signInDemo();
    user.question_events = Array.from({ length: 20 }, () => new Date().toISOString());
    renderAt(`/datasets/${datasetId}/ask`);
    await userEvent.type(await screen.findByLabelText('Ask your own question about this file'), 'Total fees?{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Your Free plan includes 20 questions a month. You have used 20 this month.');
  });

  it('pages the history with "Load more" (20 at a time)', async () => {
    const { user, datasetId } = await signInDemo();
    const seeded = user.blocks!.filter((b) => b.block.dataset_id === datasetId);
    // 25 answers in all.
    for (let i = 0; i < 16; i++) {
      const copy = structuredClone(seeded[0]!);
      copy.block.id = crypto.randomUUID();
      copy.block.title = `Extra answer ${i}`;
      copy.block.created_at = `2026-10-01T08:${String(i).padStart(2, '0')}:00+02:00`;
      user.blocks!.push(copy);
    }
    renderAt(`/datasets/${datasetId}/ask`);
    const history = await screen.findByRole('region', { name: 'Earlier answers' });
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(20));
    await userEvent.click(within(history).getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(25));
    expect(within(history).queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('Ask tab: suggestions and your own question', () => {
  beforeAll(async () => {
    await import('./AskTab');
  }, 30_000);

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  function recording() {
    const calls: Array<{ question: string; source?: string }> = [];
    const transport: Transport = async (url, init) => {
      if (url.endsWith('/ask')) calls.push(JSON.parse(String(init.body)));
      return mockTransport(url, init);
    };
    return { calls, transport };
  }

  it('"Click a question to start": a suggestion is asked with source suggested', async () => {
    const { datasetId } = await signInDemo();
    const { calls, transport } = recording();
    renderAt(`/datasets/${datasetId}/ask`, transport);
    expect(await screen.findByText('Click a question to start')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Questions you could ask' });
    const first = within(section).getAllByRole('button')[0]!;
    const question = first.querySelector('.font-medium')!.textContent!;
    await userEvent.click(first);
    await screen.findByRole('region', { name: 'Newest answer' }, { timeout: 3000 });
    expect(calls).toEqual([{ question, source: 'suggested' }]);
  });

  it('the own-question box: a visible label, the plain line, and Ask sends your words as source user', async () => {
    const { datasetId } = await signInDemo();
    const { calls, transport } = recording();
    renderAt(`/datasets/${datasetId}/ask`, transport);
    const box = await screen.findByLabelText('Ask your own question about this file');
    expect(box).toHaveAccessibleDescription(expect.stringContaining(ASK_OWN_HINT));
    expect(screen.getByText(ASK_OWN_HINT)).toBeVisible();
    await userEvent.type(box, 'Total fees per store');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('region', { name: 'Newest answer' }, { timeout: 3000 });
    expect(calls).toEqual([{ question: 'Total fees per store', source: 'user' }]);
  });

  it('too short: says so and asks nothing', async () => {
    const { datasetId } = await signInDemo();
    const { calls, transport } = recording();
    renderAt(`/datasets/${datasetId}/ask`, transport);
    await userEvent.type(await screen.findByLabelText('Ask your own question about this file'), 'ab');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Write at least 3 characters.')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('the old link /datasets/:id?q= opens the Ask tab and asks once', async () => {
    const { datasetId } = await signInDemo();
    const { calls, transport } = recording();
    const router = renderAt(`/datasets/${datasetId}?q=${encodeURIComponent('Total fees per store')}`, transport);
    await screen.findByRole('region', { name: 'Newest answer' }, { timeout: 3000 });
    expect(router.state.location.pathname).toBe(`/datasets/${datasetId}/ask`);
    expect(router.state.location.search).toBe('');
    expect(calls).toEqual([{ question: 'Total fees per store', source: 'user' }]);
  });

  it('an expired file: the box is disabled with the reason in words; earlier answers stay', async () => {
    await signInDemo();
    const user = mockStore.findUser('demo@example.co.za')!;
    const expired = user.datasets!.find((d) => d.detail.status === 'expired')!;
    renderAt(`/datasets/${expired.detail.id}/ask`);
    const box = await screen.findByLabelText('Ask your own question about this file');
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription(expect.stringContaining('The original file was deleted, so new questions cannot be asked about it.'));
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });

  it.each([
    ['ready', null],
    ['profiling', 'This file is still being read. You can ask as soon as it is ready.'],
    ['uploading', 'This file is still being read. You can ask as soon as it is ready.'],
    ['failed', 'This file could not be read, so it cannot answer questions. Open the file to try other options.'],
    ['expired', 'The original file was deleted, so new questions cannot be asked about it.'],
  ] as const)('a %s file: %s', (status, reason) => {
    expect(askDisabledReason(status)).toBe(reason);
  });
});

describe('Reports tab', () => {
  it('has Build my report and a link to the Reports page', async () => {
    await signInDemo();
    const user = mockStore.findUser('demo@example.co.za')!;
    const bank = user.datasets!.find((d) => d.detail.name === 'Bank statement October')!;
    const router = renderAt(`/datasets/${bank.detail.id}/reports`);
    expect(await screen.findByRole('button', { name: 'Build my report' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Open the Reports page' }));
    expect(router.state.location.pathname).toBe('/reports');
  });
});
