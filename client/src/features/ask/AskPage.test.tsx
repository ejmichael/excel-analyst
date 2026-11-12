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
    await import('./AskPage');
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
    const box = await screen.findByLabelText('Your question');
    await userEvent.type(box, 'Which transactions were refunds?{Enter}');
    let newest = await screen.findByRole('region', { name: 'Newest answer' }, { timeout: 3000 });
    await userEvent.click(within(newest).getByRole('button', { name: 'Show the rows this is based on' }));
    expect(await within(newest).findByText(/Showing 1 to/)).toBeInTheDocument();

    await userEvent.type(box, 'What is the average sale per store?{Enter}');
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Newest answer' })).getByRole('heading', { level: 2 })).toHaveTextContent('Average sale per store'));
    newest = screen.getByRole('region', { name: 'Newest answer' });
    expect(within(newest).getByRole('button', { name: 'Show the rows this is based on' })).toBeInTheDocument();
    expect(within(newest).queryByText(/Showing 1 to/)).not.toBeInTheDocument();
  }, 15_000);

  it('shows cannot_answer in a panel with the suggestions, and keeps the question', async () => {
    const { datasetId } = await signInDemo();
    renderAt(`/datasets/${datasetId}/ask`);
    const box = await screen.findByLabelText('Your question');
    await userEvent.type(box, 'Will it rain tomorrow?{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Analyst can't answer that from this file");
    expect(alert).toHaveTextContent('This file has no weather data');
    expect(within(alert).getAllByRole('button').length).toBeGreaterThan(0);
    expect(box).toHaveValue('Will it rain tomorrow?');
  });

  it('opens the upgrade dialog on the monthly question limit', async () => {
    const { user, datasetId } = await signInDemo();
    user.question_events = Array.from({ length: 20 }, () => new Date().toISOString());
    renderAt(`/datasets/${datasetId}/ask`);
    await userEvent.type(await screen.findByLabelText('Your question'), 'Total fees?{Enter}');
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
