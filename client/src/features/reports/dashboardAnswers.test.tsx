import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { configureApiClient, type Transport } from '@/api/client';
import { configurePublicTransport } from '@/api/publicReports';
import type { Block, DashboardFilterValue, PublicReport, ReportDetail } from '@/api/types';
import { describeBlockFilters } from '@/features/ask/blockFilters';
import { column, dataset } from '@/features/datasets/workspace/testing';
import { PublicReportPage } from '@/features/public/PublicReportPage';
import { CHART_COLOURS } from '@/features/ask/chartPalette';
import { ReportPage } from './ReportPage';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const INJECTED = ["x' OR '1'='1", '<b>hi</b>'];
const FILTERS: DashboardFilterValue[] = [
  { filter_id: 'cat:store', values: INJECTED },
  { filter_id: 'date', from: '2026-10-05', to: '2026-10-11' },
];
const CAPTION = `From "Card sales". Filtered to: Store is x' OR '1'='1, <b>hi</b>; Dates from 2026-10-05 to 2026-10-11.`;

/** A block saved from the dashboard, as the server writes it. */
const dashboardBlock = (over: Partial<Block> = {}): Block => ({
  id: 'b-dash',
  dataset_id: 'd1',
  question: 'Sales by store',
  title: 'Sales by store',
  sql: 'SELECT store, sum(amount) AS sales FROM data GROUP BY 1',
  columns: [
    { name: 'store', format: 'text' },
    { name: 'sales', format: 'zar' },
  ],
  rows: [
    { store: 'Durban', sales: 120.5 },
    { store: 'Sandton', sales: 80 },
  ],
  row_count: 2,
  truncated: false,
  chart: { type: 'bar', x: 'store', y: ['sales'], series: null, orientation: 'vertical', stacked: false, value_format: { sales: 'zar' } },
  narrative: CAPTION,
  follow_ups: [],
  checks: [
    { type: 'sql_read_only', ok: true, label: 'The query only reads your data' },
    { type: 'result_not_truncated', ok: true, label: 'Every row of the result is shown' },
  ],
  status: 'ok',
  source: 'dashboard',
  has_source_rows: true,
  filters: FILTERS,
  created_at: '2026-11-24T10:00:00+02:00',
  ...over,
});

const report = (block: Block = dashboardBlock()): ReportDetail => ({
  id: 'r1',
  workspace_id: 'w1',
  title: 'Card sales, dashboard',
  subtitle: null,
  period_label: null,
  notes: null,
  template_id: null,
  block_count: 1,
  created_at: '2026-11-24T10:00:00+02:00',
  updated_at: '2026-11-24T10:00:00+02:00',
  brand: { business_name: null, logo_url: null, color: '#1E7A5F' },
  watermark: false,
  blocks: [{ position: 0, heading_override: null, block }],
  comparison: null,
});

function renderReport(block?: Block) {
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    calls.push(path);
    if (path === '/reports/r1') return json(200, { data: report(block) });
    if (path === '/datasets/d1') return json(200, { data: dataset({ columns: [column('Store', 'text', { display_name: 'Shop' })] }) });
    if (path === '/blocks/b-dash/source-rows') {
      return json(200, { data: { columns: [{ sql_name: 'store', label: 'Shop' }], rows: [{ store: 'Durban' }, { store: 'Sandton' }], total: 41, limit: 50, offset: 0 } });
    }
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/reports/r1']}>
        <Routes>
          <Route path="/reports/:id" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('a dashboard answer in a report', () => {
  it('shows the tag, the caption as plain text, its filters in the working and its source rows', async () => {
    const calls = renderReport();
    const card = (await screen.findByRole('heading', { level: 2, name: 'Sales by store' })).closest('article')!;
    expect(within(card).getByText('From the dashboard')).toBeInTheDocument();
    // The caption is text: the "<b>" is shown, never made bold.
    expect(within(card).getByText(CAPTION)).toBeInTheDocument();
    expect(card.querySelector('b')).toBeNull();

    await userEvent.click(within(card).getByRole('button', { name: 'How this was calculated' }));
    const filters = card.querySelector('[data-answer-filters]') as HTMLElement;
    expect(within(filters).getByRole('heading', { name: 'Filters' })).toBeInTheDocument();
    // The file's own label for the column ("Shop"), the values as typed, dates in words.
    expect(within(filters).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `Shop is x' OR '1'='1, <b>hi</b>`,
      'Dates from 5 October 2026 to 11 October 2026',
    ]);
    expect(filters.querySelector('b')).toBeNull();

    await userEvent.click(within(card).getByRole('button', { name: 'Show the rows this is based on' }));
    expect(await within(card).findByText('Showing 1 to 2 of 41')).toBeInTheDocument();
    expect(calls).toContain('/blocks/b-dash/source-rows');
  });

  it('keeps the report chart colours (not the app style)', async () => {
    renderReport();
    const card = (await screen.findByRole('heading', { level: 2, name: 'Sales by store' })).closest('article')!;
    expect(card.querySelector('[data-chart-style]')).toHaveAttribute('data-chart-style', 'report');
    expect(CHART_COLOURS[0]).toBe('#1E7A5F');
  });

  it('an ordinary answer has no tag and no filters line', async () => {
    renderReport(dashboardBlock({ source: 'user', filters: null, narrative: 'Durban sold the most.' }));
    const card = (await screen.findByRole('heading', { level: 2, name: 'Sales by store' })).closest('article')!;
    expect(within(card).queryByText('From the dashboard')).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'How this was calculated' }));
    expect(card.querySelector('[data-answer-filters]')).toBeNull();
  });
});

describe('describing saved filters', () => {
  it('uses the column name when the file is not known, and open-ended dates', () => {
    expect(
      describeBlockFilters(
        [
          { filter_id: 'cat:payment_status', values: ['paid'] },
          { filter_id: 'date', from: '2026-10-05', to: null },
          { filter_id: 'date', from: null, to: '2026-10-11' },
          { filter_id: 'date', from: null, to: null },
        ],
        [],
      ),
    ).toEqual(['payment_status is paid', 'Dates from 5 October 2026', 'Dates up to 11 October 2026']);
  });
});

describe('a dashboard answer on the shared page', () => {
  it('shows the tag and, with the working, the filters line by column name', async () => {
    const { dataset_id: _d, ...block } = dashboardBlock({ has_source_rows: false });
    const shared: PublicReport = {
      id: 'r1',
      title: 'Card sales, dashboard',
      subtitle: null,
      period_label: null,
      notes: null,
      block_count: 1,
      created_at: '2026-11-24T10:00:00+02:00',
      updated_at: '2026-11-24T10:00:00+02:00',
      brand: { business_name: null, logo_url: null, color: '#1E7A5F' },
      watermark: false,
      blocks: [{ position: 0, heading_override: null, block }],
      comparison: null,
    };
    configurePublicTransport(async () => json(200, { data: shared }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/r/tok']}>
          <Routes>
            <Route path="/r/:token" element={<PublicReportPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const card = (await screen.findByRole('heading', { name: 'Sales by store' })).closest('article')!;
    expect(within(card).getByText('From the dashboard')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'How this was calculated' }));
    expect(within(card.querySelector('[data-answer-filters]') as HTMLElement).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `store is x' OR '1'='1, <b>hi</b>`,
      'Dates from 5 October 2026 to 11 October 2026',
    ]);
    // Never source rows on a shared page.
    expect(within(card).queryByRole('button', { name: 'Show the rows this is based on' })).not.toBeInTheDocument();
  });
});
