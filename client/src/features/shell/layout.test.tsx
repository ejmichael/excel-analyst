import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { configureApiClient } from '@/api/client';
import { mockAuthBackend } from '@/api/mocks/auth';
import { mockTransport, setMockLatency } from '@/api/mocks/handlers';
import { addReport } from '@/api/mocks/reports';
import { mockStore } from '@/api/mocks/store';
import { SessionProvider } from '@/auth/SessionProvider';
import { routes } from '@/routes';

/** Opens a signed-in page; `path` may use {dataset} and {report} for a ready file and a report on it. */
async function openAt(path: string) {
  setMockLatency(0);
  mockStore.reset();
  await mockAuthBackend.signIn('demo@example.co.za', 'password123');
  const user = mockStore.findUser('demo@example.co.za')!;
  user.popia_consent_at = '2026-11-01T09:00:00+02:00';
  const dataset = user.datasets!.find((d) => d.detail.name === 'Bank statement October')!.detail;
  const report = addReport(user, { workspace_id: dataset.workspace_id, title: 'October review', subtitle: null, period_label: null, block_ids: [] });
  configureApiClient({ transport: mockTransport, refreshAccessToken: async () => null });
  const url = path.replace('{dataset}', dataset.id).replace('{report}', report.report.id);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={mockAuthBackend}>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [url] })} />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

const container = () => document.querySelector<HTMLElement>('[data-page-container]')!;
const column = () => container().firstElementChild as HTMLElement;

describe('page widths', () => {
  it('the file workspace uses the wide container (1800px, side padding 16, 24 and 32px)', async () => {
    await openAt('/datasets/{dataset}/data');
    await screen.findByRole('tab', { name: 'Data', selected: true });
    expect(container()).toHaveAttribute('data-page-container', 'wide');
    expect(container().className).toMatch(/\bpx-4\b.*\bsm:px-6\b.*\blg:px-8\b/);
    expect(column().className).toMatch(/max-w-\[1800px\]/);
    // The Data tab and the Dashboard use the full width.
    expect(screen.getByRole('tabpanel').className).not.toMatch(/max-w/);
  });

  it('the Datasets list is wide', async () => {
    await openAt('/datasets');
    await screen.findByRole('heading', { level: 1, name: 'Datasets' });
    expect(container()).toHaveAttribute('data-page-container', 'wide');
  });

  it.each([
    ['ask', 'max-w-[1100px]'],
    ['reports', 'max-w-[1100px]'],
    ['quality', 'max-w-[1200px]'],
  ])('the %s tab is capped at %s', async (tab, cap) => {
    await openAt(`/datasets/{dataset}/${tab}`);
    await screen.findByRole('tab', { selected: true });
    expect(screen.getByRole('tabpanel').className.split(' ')).toContain(cap);
  });

  it('notices and the reading line stay at most 80 characters wide', async () => {
    await openAt('/datasets/{dataset}/data');
    const bar = (await screen.findByText('How we read this file:')).closest('section')!;
    expect(bar.className.split(' ')).toContain('max-w-[80ch]');
    expect(document.querySelector('[data-file-summary]')!.className.split(' ')).toContain('max-w-[80ch]');
  });

  it.each([
    ['the report view', '/reports/{report}', 'October review'],
    ['the reports list', '/reports', 'Reports'],
    ['Settings', '/settings', 'Settings'],
  ])('%s keeps the narrow container', async (_name, path, heading) => {
    await openAt(path);
    await screen.findByRole('heading', { level: 1, name: heading });
    expect(container()).toHaveAttribute('data-page-container', 'narrow');
    expect(column().className.split(' ')).toContain('max-w-4xl');
  });

  it('nothing on a page sets a fixed width that could scroll the page sideways at 390px', async () => {
    await openAt('/datasets/{dataset}/data');
    await screen.findByRole('tab', { name: 'Data', selected: true });
    // Widths above a phone's only ever appear as max-widths.
    const fixed = [...document.querySelectorAll<HTMLElement>('[class]')].filter((el) => /(^|\s)(min-)?w-\[(\d{4}|[4-9]\d\d)px\]/.test(el.className));
    expect(fixed).toEqual([]);
  });
});
