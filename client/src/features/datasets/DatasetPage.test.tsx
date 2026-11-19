import { describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
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

async function openDataset(name: string, path = '') {
  setMockLatency(0);
  mockStore.reset();
  await mockAuthBackend.signIn('demo@example.co.za', 'password123');
  const user = mockStore.findUser('demo@example.co.za')!;
  user.popia_consent_at = '2026-11-01T09:00:00+02:00';
  const dataset = user.datasets!.find((d) => d.detail.name === name)!;
  configureApiClient({ transport: mockTransport, refreshAccessToken: async () => null });
  const router = createMemoryRouter(routes, { initialEntries: [`/datasets/${dataset.detail.id}${path}`] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={mockAuthBackend}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { router, id: dataset.detail.id };
}

const at = (router: { state: { location: { pathname: string } } }) => router.state.location.pathname;

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

  it('a file without warnings: Change in the "How we read this file" bar opens the same dialog', async () => {
    await openDataset('Bank statement October');
    const bar = (await screen.findByText('How we read this file:')).closest('section')!;
    expect(bar).toHaveTextContent('Columns are separated by');
    await userEvent.click(within(bar).getByRole('button', { name: 'Change how we read this file' }));
    expect(await screen.findByRole('dialog', { name: LABEL })).toBeInTheDocument();
  });
});

describe('the file workspace: tabs and their URLs', () => {
  const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

  it('the old dataset URL opens the default tab, Ask', async () => {
    const { router, id } = await openDataset('Bank statement October');
    const tab = await screen.findByRole('tab', { name: 'Ask' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(at(router)).toBe(`/datasets/${id}/ask`);
    expect(tabNames()).toEqual(['Data', 'Ask', 'Reports']);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tab.id);
  });

  it.each(['data', 'ask', 'reports'])('/%s opens that tab', async (key) => {
    await openDataset('Bank statement October', `/${key}`);
    const selected = await screen.findByRole('tab', { selected: true });
    expect(selected.getAttribute('href')).toMatch(new RegExp(`/${key}$`));
  });

  it('an unknown tab opens the default tab', async () => {
    const { router, id } = await openDataset('Bank statement October', '/nonsense');
    expect(await screen.findByRole('tab', { name: 'Ask', selected: true })).toBeInTheDocument();
    expect(at(router)).toBe(`/datasets/${id}/ask`);
  });

  it('a tab click adds a history entry, so Back returns to the previous tab', async () => {
    const { router, id } = await openDataset('Bank statement October', '/data');
    await userEvent.click(await screen.findByRole('tab', { name: 'Reports' }));
    expect(at(router)).toBe(`/datasets/${id}/reports`);
    expect(screen.getByRole('tab', { name: 'Reports' })).toHaveAttribute('aria-selected', 'true');
    await act(() => router.navigate(-1));
    expect(at(router)).toBe(`/datasets/${id}/data`);
    expect(await screen.findByRole('tab', { name: 'Data', selected: true })).toBeInTheDocument();
  });

  it('arrow keys, Home and End move between tabs and open them; only the open tab is in the Tab order', async () => {
    const { router, id } = await openDataset('Bank statement October', '/data');
    const data = await screen.findByRole('tab', { name: 'Data' });
    expect(data).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Ask' })).toHaveAttribute('tabindex', '-1');
    data.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(at(router)).toBe(`/datasets/${id}/ask`);
    expect(screen.getByRole('tab', { name: 'Ask' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(at(router)).toBe(`/datasets/${id}/reports`);
    await userEvent.keyboard('{ArrowRight}');
    expect(at(router)).toBe(`/datasets/${id}/data`);
    await userEvent.keyboard('{ArrowLeft}');
    expect(at(router)).toBe(`/datasets/${id}/reports`);
    await userEvent.keyboard('{Home}');
    expect(at(router)).toBe(`/datasets/${id}/data`);
    // A visible focus ring on the focused tab.
    expect(screen.getByRole('tab', { name: 'Data' }).className).toMatch(/focus-visible:ring-2/);
  });

  it('no tabs while the file is being read, or when it could not be read', async () => {
    await openDataset('Card sales full year', '/data');
    expect(await screen.findByText('We could not read this file')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('no tabs while the file is being read', async () => {
    setMockLatency(0);
    await openDataset('Card sales October');
    expect(await screen.findByText(/Reading your file/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('an expired file keeps its earlier answers and reports, without Data', async () => {
    const { router, id } = await openDataset('Card sales August', '/data');
    expect(await screen.findByRole('tab', { name: 'Ask', selected: true })).toBeInTheDocument();
    expect(tabNames()).toEqual(['Ask', 'Reports']);
    expect(at(router)).toBe(`/datasets/${id}/ask`);
    expect(screen.getByText(/The original file was deleted/)).toBeInTheDocument();
  });

  it('the header: name, status in words, and rows, columns and upload date', async () => {
    await openDataset('Bank statement October');
    expect(await screen.findByRole('heading', { level: 1, name: 'Bank statement October' })).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('150 rows, 4 columns, uploaded 21 Oct 2026')).toBeInTheDocument();
  });
});
