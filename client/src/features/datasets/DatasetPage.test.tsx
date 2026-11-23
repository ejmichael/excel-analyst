import { describe, expect, it, vi } from 'vitest';
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
import type { DatasetDetail } from '@/api/types';

const LABEL = 'Check how we read your file';

async function openDataset(name: string, path = '', edit?: (detail: DatasetDetail) => void) {
  setMockLatency(0);
  mockStore.reset();
  await mockAuthBackend.signIn('demo@example.co.za', 'password123');
  const user = mockStore.findUser('demo@example.co.za')!;
  user.popia_consent_at = '2026-11-01T09:00:00+02:00';
  const dataset = user.datasets!.find((d) => d.detail.name === name)!;
  edit?.(dataset.detail);
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
    await userEvent.click(await screen.findByRole('button', { name: '1 thing to check' }));
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
  // The label only (the Quality tab adds its score once loaded).
  const tabNames = () => screen.getAllByRole('tab').map((t) => t.firstChild?.textContent);

  it('the old dataset URL opens the default tab, Dashboard', async () => {
    const { router, id } = await openDataset('Bank statement October');
    const tab = await screen.findByRole('tab', { name: 'Dashboard' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(at(router)).toBe(`/datasets/${id}/dashboard`);
    expect(tabNames()).toEqual(['Dashboard', 'Data', 'Quality', 'Ask', 'Reports']);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tab.id);
  });

  it.each(['dashboard', 'data', 'quality', 'ask', 'reports'])('/%s opens that tab', async (key) => {
    await openDataset('Bank statement October', `/${key}`);
    const selected = await screen.findByRole('tab', { selected: true });
    expect(selected.getAttribute('href')).toMatch(new RegExp(`/${key}$`));
  });

  it('an unknown tab opens the default tab', async () => {
    const { router, id } = await openDataset('Bank statement October', '/nonsense');
    expect(await screen.findByRole('tab', { name: 'Dashboard', selected: true })).toBeInTheDocument();
    expect(at(router)).toBe(`/datasets/${id}/dashboard`);
  });

  it('an older link with ?q= (no tab) opens Ask, which asks the question', async () => {
    const { router, id } = await openDataset('Bank statement October', '?q=What%20are%20my%20biggest%20expenses%3F');
    expect(await screen.findByRole('tab', { name: 'Ask', selected: true })).toBeInTheDocument();
    expect(at(router)).toBe(`/datasets/${id}/ask`);
    expect(await screen.findByText('What are my biggest expenses?', {}, { timeout: 4000 })).toBeInTheDocument();
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
    expect(at(router)).toBe(`/datasets/${id}/quality`);
    expect(screen.getByRole('tab', { name: /^Quality/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(at(router)).toBe(`/datasets/${id}/ask`);
    expect(screen.getByRole('tab', { name: 'Ask' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(at(router)).toBe(`/datasets/${id}/reports`);
    await userEvent.keyboard('{ArrowRight}');
    expect(at(router)).toBe(`/datasets/${id}/dashboard`);
    await userEvent.keyboard('{ArrowLeft}');
    expect(at(router)).toBe(`/datasets/${id}/reports`);
    await userEvent.keyboard('{Home}');
    expect(at(router)).toBe(`/datasets/${id}/dashboard`);
    await userEvent.keyboard('{ArrowRight}');
    expect(at(router)).toBe(`/datasets/${id}/data`);
    // A visible focus ring on the focused tab.
    expect(screen.getByRole('tab', { name: 'Data' }).className).toMatch(/focus-visible:ring-2/);
  });

  it('the Quality tab shows the server score as a badge once it has loaded, without opening the tab', async () => {
    await openDataset('Webstore orders October', '/ask');
    const quality = await screen.findByRole('tab', { name: /^Quality/ });
    expect(quality).toHaveAttribute('aria-selected', 'false');
    expect(await within(quality).findByText('70')).toBeInTheDocument();
    expect(quality).toHaveAccessibleName('Quality70, score out of 100');
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
    expect(screen.getByText(/The original file was deleted on/)).toBeInTheDocument();
  });

  it('the header: name, status in words, and every fact about the file on one line', async () => {
    await openDataset('Bank statement October');
    expect(await screen.findByRole('heading', { level: 1, name: 'Bank statement October' })).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    const line = document.querySelector('[data-file-summary]')!;
    expect(line.textContent).toMatch(/^150 rows, 4 columns, 03_bank_statement_comma_quoted\.csv, \S+\s?kB, uploaded 21 Oct 2026\./);
    expect(line).toHaveTextContent('We left out 1 row that looked like a total or a blank line.');
    expect(line.textContent).toMatch(/We delete the file on \d+ \w+ \d{4}\.$/);
  });
});

describe('the compact header', () => {
  it('Rename and Delete live in a More menu: keyboard, Escape and focus return', async () => {
    await openDataset('Bank statement October');
    const more = await screen.findByRole('button', { name: 'More actions for this file' });
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    more.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Delete']);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(more).toHaveFocus();

    await userEvent.click(more);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByLabelText('File name in Analyst')).toHaveValue('Bank statement October');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('button', { name: 'More actions for this file' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: 'Delete “Bank statement October”?' })).toBeInTheDocument();
  });

  it('the reading line keeps its text in a title, with More to show it all', async () => {
    await openDataset('Bank statement October');
    const bar = (await screen.findByText('How we read this file:')).closest('section')!;
    const line = bar.querySelector('p')!;
    expect(line.getAttribute('title')).toMatch(/^How we read this file: Columns are separated by/);
    expect(line.className).toMatch(/sm:truncate/);
    await userEvent.click(within(bar).getByRole('button', { name: 'More of how we read this file' }));
    expect(line.className).not.toMatch(/sm:truncate/);
    expect(within(bar).getByRole('button', { name: 'Less of how we read this file' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('warnings: one line, collapsed by default, expands in place; the choice is remembered per file', async () => {
    sessionStorage.clear();
    const { id } = await openDataset('Office expenses');
    const toggle = await screen.findByRole('button', { name: '1 thing to check' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: LABEL })).toBeVisible();
    expect(sessionStorage.getItem(`analyst:warnings-open:${id}`)).toBe('1');
    sessionStorage.clear();
  });

  it('a remembered choice wins over the default', async () => {
    await openDataset('Office expenses', '', (d) => sessionStorage.setItem(`analyst:warnings-open:${d.id}`, '1'));
    expect(await screen.findByRole('button', { name: '1 thing to check' })).toHaveAttribute('aria-expanded', 'true');
    sessionStorage.clear();
  });

  it('starts open with 5 or more warnings', async () => {
    sessionStorage.clear();
    await openDataset('Bank statement October', '', (d) => {
      d.warnings = ['One', 'Two', 'Three', 'Four', 'Five'];
    });
    expect(await screen.findByRole('button', { name: '5 things to check' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('starts open when the file could not be read', async () => {
    sessionStorage.clear();
    await openDataset('Card sales full year', '', (d) => {
      d.warnings = ['Row 3 has more cells than the header.'];
    });
    expect(await screen.findByRole('button', { name: '1 thing to check' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Row 3 has more cells than the header.')).toBeVisible();
  });

  it('works when sessionStorage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      await openDataset('Office expenses');
      const toggle = await screen.findByRole('button', { name: '1 thing to check' });
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(screen.getByRole('button', { name: LABEL }));
      expect(await screen.findByRole('dialog', { name: LABEL })).toBeInTheDocument();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

