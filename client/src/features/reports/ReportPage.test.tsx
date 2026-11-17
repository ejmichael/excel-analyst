import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { configureApiClient, type Transport } from '@/api/client';
import { BLOCK_TEMPLATES, blockFrom } from '@/api/mocks/blockFixtures';
import { DELETED_FILE_MESSAGE, WORKSPACE_RULE_MESSAGE } from '@/api/mocks/reports';
import type { Block, Brand, ReportDetail } from '@/api/types';
import { ReportPage } from './ReportPage';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const EVIL = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 1">';

const makeBlock = (key: string, over: Partial<Block> = {}): Block => ({
  ...blockFrom(BLOCK_TEMPLATES.find((t) => t.key === key)!, { question: `Question ${key}`, datasetId: 'd1', source: 'user', createdAt: '2026-11-02T10:00:00+02:00' }),
  id: `b-${key}`,
  ...over,
});

function makeReport(over: Partial<ReportDetail> = {}, brand: Partial<Brand> = {}): ReportDetail {
  return {
    id: 'r1',
    workspace_id: 'w1',
    title: 'October review',
    subtitle: 'Three stores',
    period_label: 'October 2026',
    notes: null,
    template_id: null,
    block_count: 3,
    created_at: '2026-11-02T10:00:00+02:00',
    updated_at: '2026-11-02T10:00:00+02:00',
    brand: { business_name: 'Mokoena Bakery', logo_url: 'https://files.example/logo.png', color: '#7A1E3C', ...brand },
    watermark: true,
    blocks: [
      { position: 0, heading_override: null, block: makeBlock('by-store') },
      { position: 1, heading_override: 'Card fees', block: makeBlock('fees') },
      { position: 2, heading_override: null, block: makeBlock('flagged') },
    ],
    comparison: null,
    ...over,
  };
}

function setup(report: ReportDetail, extra: (url: string, init: RequestInit) => Response | null = () => null) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let current = report;
  const transport: Transport = async (url, init) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname.replace('/api/v1', '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null });
    const handled = extra(url, init);
    if (handled) return handled;
    if (path === '/reports/r1' && method === 'GET') return json(200, { data: current });
    if (path === '/reports/r1' && method === 'PATCH') {
      current = { ...current, ...(JSON.parse(String(init.body)) as object) } as ReportDetail;
      return json(200, { data: { ...report, title: (current as ReportDetail).title } });
    }
    if (path === '/reports/r1' && method === 'DELETE') return json(200, { data: { deleted: true } });
    if (path.startsWith('/datasets/d1') && !path.endsWith('/blocks')) {
      return json(200, { data: { id: 'd1', workspace_id: 'w1', name: 'Card sales', status: 'ready', expires_at: null, columns: [] } });
    }
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/reports/r1']}>
        <Routes>
          <Route path="/reports/:id" element={<ReportPage />} />
          <Route path="/reports" element={<p>Reports list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, patches: () => calls.filter((c) => c.method === 'PATCH').map((c) => c.body), unmount: view.unmount };
}

const blockHeadings = () =>
  within(screen.getByRole('list', { name: 'Answers in this report' }))
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent);

describe('ReportPage: reading', () => {
  it('shows the header in the brand, the answers in order and the watermark', async () => {
    setup(makeReport());
    expect(await screen.findByRole('heading', { level: 1, name: 'October review' })).toBeInTheDocument();
    const band = screen.getByTestId('report-brand-band');
    expect(band).toHaveStyle({ backgroundColor: 'rgb(122, 30, 60)', color: 'rgb(255, 255, 255)' });
    expect(within(band).getByText('Mokoena Bakery')).toBeInTheDocument();
    expect(within(band).getByRole('img', { name: 'Mokoena Bakery logo' })).toBeInTheDocument();
    expect(screen.getByText('October 2026 · 2 November 2026')).toBeInTheDocument();
    expect(blockHeadings()).toEqual(['Net sales by store', 'Card fees', 'Average sale per store']);
    // On screen under the report (hidden in print), and in the closing note that prints instead.
    const watermarks = screen.getAllByText('Made with Analyst');
    expect(watermarks).toHaveLength(2);
    expect(watermarks[0]).toHaveAttribute('data-print', 'hide');
    expect(watermarks[1]!.closest('[data-closing-note]')).not.toBeNull();
    // In a report: no follow-ups, no feedback, delete or add-to-report.
    expect(screen.queryByText('Ask next')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'This looks wrong' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add to report/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'How this was calculated' })[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save as template (Coming soon)' })).toBeDisabled();
  });

  it('keeps a flagged answer\'s warning', async () => {
    setup(makeReport());
    expect(await screen.findByText('Some checks did not pass, so check these numbers before you rely on them.')).toBeInTheDocument();
  });

  it('marks what prints: controls hidden, the document parts marked, the working left out, the closing note with the Excel sentence', async () => {
    setup(makeReport());
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    expect(screen.getByRole('group', { name: 'Report actions' })).toHaveAttribute('data-print', 'hide');
    expect(screen.getByRole('link', { name: 'All reports' })).toHaveAttribute('data-print', 'hide');
    // The report root carries the brand for the document look: the colour, its 3:1 mark colour and the table tint.
    const root = document.querySelector<HTMLElement>('[data-report-root]')!;
    expect(root.style.getPropertyValue('--brand')).toBe('#7A1E3C');
    expect(root.style.getPropertyValue('--brand-mark')).toBe('#7A1E3C');
    expect(root.style.getPropertyValue('--brand-tint')).toMatch(/^#[0-9A-F]{6}$/);
    expect(screen.getByTestId('report-header')).toHaveAttribute('data-report-header');
    expect(screen.getByRole('list', { name: 'Answers in this report' })).toHaveAttribute('data-report-answers');
    // How each answer may break on paper comes from its chart type, never from a figure.
    expect([...document.querySelectorAll('[data-print-answer]')].map((a) => a.getAttribute('data-answer-kind'))).toEqual(['chart', 'chart', 'chart']);
    // Per-answer timestamps are marked so the document leaves them out.
    expect(document.querySelectorAll('[data-answer-time]')).toHaveLength(3);
    // "How this was calculated" (and with it the SQL and source rows) is inside what print leaves out.
    for (const toggle of screen.getAllByRole('button', { name: 'How this was calculated' })) {
      expect(toggle.closest('[data-answer-working]')).not.toBeNull();
    }
    // The owner's closing note says where the working is.
    const note = document.querySelector('[data-closing-note]')!;
    expect(note).toHaveTextContent('Check important figures against your source file.');
    expect(note).toHaveTextContent('The working for each figure is in the Excel download.');
    expect(note).toHaveTextContent('Made with Analyst');
  });

  it('a flagged answer prints its warning and not the passed line', async () => {
    setup(makeReport());
    const flagged = (await screen.findAllByRole('article'))[2]!;
    expect(flagged.querySelector('[data-flagged-note]')).toHaveTextContent('Check the numbers');
    expect(flagged.querySelector('[data-check-line]')).toBeNull();
    const passed = screen.getAllByRole('article')[0]!;
    expect(passed.querySelector('[data-check-line]')).toHaveTextContent('All checks passed.');
    expect(passed.querySelector('[data-flagged-note]')).toBeNull();
  });

  it('the tab title is the report title while the page is open, and is restored on leaving', async () => {
    document.title = 'Analyst';
    const { unmount } = setup(makeReport());
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    expect(document.title).toBe('October review');
    unmount();
    expect(document.title).toBe('Analyst');
  });

  it('no watermark when the API says so; no business name invented when it is empty', async () => {
    setup(makeReport({ watermark: false }, { business_name: null, logo_url: null }));
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    expect(screen.queryByText(/Made with/)).not.toBeInTheDocument();
    // No logo and no business name: nothing in their place (no initials, no placeholder); only the date.
    const band = screen.getByTestId('report-brand-band');
    expect(within(band).queryByRole('img')).not.toBeInTheDocument();
    expect(band.querySelector('[data-business-name]')).toBeNull();
    expect(band).toHaveTextContent(/^2 November 2026$/);
  });

  it('refetches once when the logo fails (expired signed URL), then hides it quietly', async () => {
    const { calls } = setup(makeReport());
    const logo = await screen.findByRole('img', { name: 'Mokoena Bakery logo' });
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/reports/r1').length;
    const before = reads();
    fireEvent.error(logo);
    await waitFor(() => expect(reads()).toBe(before + 1));
    fireEvent.error(screen.getByRole('img', { name: 'Mokoena Bakery logo' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Mokoena Bakery logo' })).not.toBeInTheDocument());
    expect(reads()).toBe(before + 1);
  });

  it('renders API text as inert text', async () => {
    const report = makeReport({ title: `T ${EVIL}`, notes: `N ${EVIL}` });
    report.blocks[0] = { position: 0, heading_override: `H ${EVIL}`, block: makeBlock('by-store', { question: `Q ${EVIL}` }) };
    setup(report);
    expect(await screen.findByRole('heading', { level: 1, name: `T ${EVIL}` })).toBeInTheDocument();
    expect(screen.getByText(`N ${EVIL}`)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: `H ${EVIL}` })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelectorAll('img[src="x"]')).toHaveLength(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('ReportPage: editing', () => {
  it('Save is disabled until something changes, then sends only the changed field', async () => {
    const { patches } = setup(makeReport());
    await userEvent.click(await screen.findByRole('button', { name: 'Edit report' }));
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    const title = screen.getByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'November review');
    await userEvent.click(save);
    await waitFor(() => expect(patches()).toEqual([{ title: 'November review' }]));
  });

  it('reorders and removes (with a confirm), sending the full blocks list', async () => {
    const { patches } = setup(makeReport());
    await userEvent.click(await screen.findByRole('button', { name: 'Edit report' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move down: Net sales by store' }));
    expect(blockHeadings()).toEqual(['Card fees', 'Net sales by store', 'Average sale per store']);
    await userEvent.click(screen.getByRole('button', { name: 'Remove from report: Average sale per store' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(patches()).toEqual([
        {
          blocks: [
            { block_id: 'b-fees', heading_override: 'Card fees' },
            { block_id: 'b-by-store', heading_override: null },
          ],
        },
      ]),
    );
  });

  it('delete asks first, says the answers are kept, then returns to the list', async () => {
    const { calls } = setup(makeReport());
    await userEvent.click(await screen.findByRole('button', { name: 'Delete report' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('The answers in it are kept in your history.');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete report' }));
    expect(await screen.findByText('Reports list')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/reports/r1')).toBe(true);
  });

  it('a 422 for the workspace rule highlights each refused answer by its position in the request', async () => {
    // The real server's shape: one entry per refused answer, blocks.<i>.block_id, i = position in the PATCH body.
    setup(makeReport(), (_url, init) =>
      init.method === 'PATCH'
        ? json(422, {
            error: {
              code: 'validation_failed',
              message: WORKSPACE_RULE_MESSAGE,
              details: {
                fields: [
                  { location: 'body', path: 'blocks.1.block_id', message: WORKSPACE_RULE_MESSAGE },
                  { location: 'body', path: 'blocks.2.block_id', message: DELETED_FILE_MESSAGE },
                ],
              },
            },
          })
        : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Edit report' }));
    // After the move the request order is: Card fees, Net sales by store, Average sale per store.
    await userEvent.click(screen.getByRole('button', { name: 'Move down: Net sales by store' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(document.querySelectorAll('[data-refused="true"]')).toHaveLength(2));
    const refused = [...document.querySelectorAll<HTMLElement>('[data-refused="true"]')];
    expect(within(refused[0]!).getByRole('textbox', { name: 'Heading for answer 2' })).toHaveAttribute('placeholder', 'Net sales by store');
    expect(refused[0]).toHaveTextContent(`This answer cannot stay in the report. ${WORKSPACE_RULE_MESSAGE}`);
    expect(within(refused[1]!).getByRole('textbox', { name: 'Heading for answer 3' })).toHaveAttribute('placeholder', 'Average sale per store');
    expect(refused[1]).toHaveTextContent(DELETED_FILE_MESSAGE);
    expect(screen.getByText(`${WORKSPACE_RULE_MESSAGE} Highlighted above: “Net sales by store”, “Average sale per store”.`)).toBeInTheDocument();

    // Removing one keeps the other highlighted; removing both clears the message.
    for (const [title, left] of [['Net sales by store', 1], ['Average sale per store', 0]] as const) {
      await userEvent.click(screen.getByRole('button', { name: `Remove from report: ${title}` }));
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
      expect(document.querySelectorAll('[data-refused="true"]')).toHaveLength(left);
    }
    expect(screen.queryByText(/Highlighted above/)).not.toBeInTheDocument();
  });
});
