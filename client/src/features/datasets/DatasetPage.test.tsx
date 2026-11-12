import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { configureApiClient } from '@/api/client';
import { mockAuthBackend } from '@/api/mocks/auth';
import { mockTransport, setMockLatency } from '@/api/mocks/handlers';
import { mockStore } from '@/api/mocks/store';
import { SessionProvider } from '@/auth/SessionProvider';
import { routes } from '@/routes';

const LABEL = 'Check how we read your file';

async function openDataset(name: string) {
  setMockLatency(0);
  mockStore.reset();
  await mockAuthBackend.signIn('demo@example.co.za', 'password123');
  const user = mockStore.findUser('demo@example.co.za')!;
  user.popia_consent_at = '2026-11-01T09:00:00+02:00';
  const dataset = user.datasets!.find((d) => d.detail.name === name)!;
  configureApiClient({ transport: mockTransport, refreshAccessToken: async () => null });
  const router = createMemoryRouter(routes, { initialEntries: [`/datasets/${dataset.detail.id}`] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={mockAuthBackend}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('every way into the parse dialog says "Check how we read your file"', () => {
  it('a file that could not be read', async () => {
    await openDataset('Card sales full year');
    const button = await screen.findByRole('button', { name: LABEL });
    expect(screen.queryByText('Try other options')).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByRole('dialog', { name: LABEL })).toBeInTheDocument();
  });

  it('a file with a warning (the warning text names the same button)', async () => {
    await openDataset('Office expenses');
    expect(await screen.findByText(/choose month-first under "Check how we read your file"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LABEL })).toBeInTheDocument();
  });

  it('a file without warnings (the link above the preview)', async () => {
    await openDataset('Bank statement October');
    expect(await screen.findByRole('button', { name: LABEL })).toBeInTheDocument();
  });
});
