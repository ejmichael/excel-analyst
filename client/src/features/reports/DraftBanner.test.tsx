import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router';
import { configureApiClient, type Transport } from '@/api/client';
import { BLOCK_TEMPLATES, blockFrom } from '@/api/mocks/blockFixtures';
import type { Block, ReportDetail } from '@/api/types';
import { draftDismissals, draftSummary } from './DraftBanner';
import { ReportPage } from './ReportPage';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const EVIL = '<img src=x onerror="window.__pwned = 1">';
const BANNER = 'This is a draft. Check it before you send it.';

const makeBlock = (key: string, over: Partial<Block> = {}): Block => ({
  ...blockFrom(BLOCK_TEMPLATES.find((t) => t.key === key)!, { question: `Question ${key}`, datasetId: 'd1', source: 'suggested', createdAt: '2026-11-16T10:00:00+02:00' }),
  id: `b-${key}`,
  ...over,
});

function makeReport(keys: string[], over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    id: 'r1',
    workspace_id: 'w1',
    title: 'Card sales October',
    subtitle: null,
    period_label: 'October 2026',
    notes: null,
    template_id: null,
    block_count: keys.length,
    created_at: '2026-11-16T10:00:00+02:00',
    updated_at: '2026-11-16T10:00:00+02:00',
    brand: { business_name: null, logo_url: null, color: '#1E7A5F' },
    watermark: true,
    blocks: keys.map((key, position) => ({ position, heading_override: null, block: makeBlock(key) })),
    comparison: null,
    ...over,
  };
}

function Location() {
  const location = useLocation();
  const type = useNavigationType();
  return <p data-testid="location">{`${location.pathname}${location.search} ${type}`}</p>;
}

function setup(report: ReportDetail, entry = '/reports/r1?draft=1') {
  const transport: Transport = async (url) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    if (path === '/reports/r1') return json(200, { data: report });
    if (path === '/datasets/d1') return json(200, { data: { id: 'd1', workspace_id: 'w1', name: 'Card sales', status: 'ready', expires_at: null, columns: [] } });
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/reports/:id" element={<ReportPage />} />
        </Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const banner = () => screen.findByRole('region', { name: BANNER });

beforeEach(() => {
  window.localStorage.clear();
  draftDismissals.resetMemory();
});

describe('draft report banner', () => {
  it('counts the flagged answers from their statuses and points to the "Check the numbers" label', async () => {
    setup(makeReport(['by-store', 'fees', 'flagged']));
    expect(await banner()).toHaveTextContent('3 answers, 1 of them needs a closer look. Answers marked “Check the numbers” failed a check.');
    // The flagged answer carries the label the banner refers to.
    const flaggedNote = screen.getAllByRole('note').find((n) => n.textContent?.includes('Check the numbers'));
    expect(flaggedNote).toBeDefined();
    expect(draftSummary(makeReport(['flagged', 'flagged', 'fees']))).toMatch(/^3 answers, 2 of them need a closer look\./);
  });

  it('says all checks passed when none is flagged, and never that the report is final', async () => {
    setup(makeReport(['by-store', 'fees', 'daily']));
    const region = await banner();
    expect(region).toHaveTextContent('All checks passed on every answer.');
    expect(region).not.toHaveTextContent(/final|ready to send/i);
  });

  it('is shown above the report header, only with ?draft=1', async () => {
    setup(makeReport(['by-store', 'fees', 'daily']));
    const region = await banner();
    const header = screen.getByRole('heading', { level: 1, name: 'Card sales October' });
    expect(region.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not shown without ?draft=1', async () => {
    setup(makeReport(['by-store']), '/reports/r1');
    await screen.findByRole('heading', { level: 1, name: 'Card sales October' });
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it('dismissing removes the draft parameter (replace, not push) and it is not shown again for that report', async () => {
    const view = setup(makeReport(['by-store', 'flagged']));
    await userEvent.click(within(await banner()).getByRole('button', { name: 'Dismiss the draft notice' }));
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/reports/r1 REPLACE');
    view.unmount();

    setup(makeReport(['by-store', 'flagged']));
    await screen.findByRole('heading', { level: 1, name: 'Card sales October' });
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it('"Edit report" turns on edit mode; "Add your own question" opens the file\'s Ask page', async () => {
    setup(makeReport(['by-store', 'flagged']));
    const region = await banner();
    expect(within(region).getByRole('link', { name: 'Add your own question' })).toHaveAttribute('href', '/datasets/d1/ask');
    await userEvent.click(within(region).getByRole('button', { name: 'Edit report' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as template (Coming soon)' })).toBeDisabled();
  });

  it('renders API text as text', async () => {
    setup(makeReport(['by-store'], { title: EVIL }));
    await banner();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(EVIL);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
