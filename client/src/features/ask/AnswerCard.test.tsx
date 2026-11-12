import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureApiClient, type Transport } from '@/api/client';
import type { Block, SourceRows } from '@/api/types';
import { AnswerCard, downloadAnswerCsv } from './AnswerCard';
import type { DatasetState } from './HowCalculated';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const baseBlock = (over: Partial<Block> = {}): Block => ({
  id: 'b1',
  dataset_id: 'd1',
  question: 'Which store sold most?',
  title: 'Net sales by store',
  sql: 'SELECT "store", SUM("net") AS net FROM data GROUP BY 1',
  columns: [
    { name: 'store', format: 'text' },
    { name: 'net', format: 'zar' },
  ],
  rows: [
    { store: 'A', net: 100 },
    { store: 'B', net: 50 },
  ],
  row_count: 2,
  truncated: false,
  chart: { type: 'bar', x: 'store', y: ['net'], series: null, orientation: 'vertical', stacked: false, value_format: { net: 'zar' } },
  narrative: 'A sold the most.',
  follow_ups: ['Why?', 'And last month?'],
  checks: [
    { type: 'sql_read_only', ok: true, label: 'The query only reads your data' },
    { type: 'total_reconciles', ok: true, label: 'Total of net matches your file', expected: 150, actual: 150 },
  ],
  status: 'ok',
  source: 'user',
  has_source_rows: true,
  created_at: '2026-11-02T10:15:00+02:00',
  ...over,
});

const readyDataset: DatasetState = { exists: true, status: 'ready', expires_at: '2026-12-02T10:00:00+02:00', columns: [] };

function renderCard(block: Block, { dataset = readyDataset, transport, newest = true }: { dataset?: DatasetState; transport?: Transport; newest?: boolean } = {}) {
  configureApiClient({
    transport: transport ?? (async () => json(500, { error: { code: 'internal', message: 'unexpected call' } })),
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => null,
    onUnauthorized: () => {},
  });
  const onFollowUp = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AnswerCard block={block} dataset={dataset} newest={newest} onFollowUp={onFollowUp} />
    </QueryClientProvider>,
  );
  return { onFollowUp };
}

describe('AnswerCard: status and checks', () => {
  it('a flagged block has the amber panel in words, listing each failed check; the answer still shows', () => {
    renderCard(
      baseBlock({
        status: 'flagged',
        checks: [
          { type: 'sql_read_only', ok: true, label: 'The query only reads your data' },
          { type: 'numbers_from_data', ok: false, label: 'Every number comes from the result', detail: 'The number "10" is not from the result.' },
        ],
      }),
    );
    const panel = screen.getByRole('note');
    expect(panel).toHaveTextContent('Some checks did not pass, so check these numbers before you rely on them.');
    expect(panel).toHaveTextContent('Every number comes from the result: The number "10" is not from the result.');
    expect(panel).not.toHaveTextContent('The query only reads your data');
    expect(screen.getByText('A sold the most.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Net sales by store, 2 rows/ })).toBeInTheDocument();
  });

  it('a passing block says so calmly', () => {
    renderCard(baseBlock());
    expect(screen.getByText('All checks passed.')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('lists every check as Passed or Did not pass, with reconcile totals formatted', () => {
    renderCard(
      baseBlock({
        checks: [
          { type: 'sql_read_only', ok: true, label: 'Reads only' },
          { type: 'total_reconciles', ok: false, label: 'Total of net matches your file', detail: 'Off by a little', expected: 1234.5, actual: 1200 },
        ],
        status: 'flagged',
      }),
    );
    const checks = screen.getByRole('list', { name: 'Checks' });
    const items = within(checks).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Passed: Reads only');
    expect(items[1]).toHaveTextContent('Did not pass: Total of net matches your file');
    expect(items[1]).toHaveTextContent('Off by a little');
    const rand = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
    expect(items[1]!.textContent).toContain(`Your file: ${rand(1234.5)}`);
    expect(items[1]!.textContent).toContain(`This answer: ${rand(1200)}`);
  });

  it('says when the result is truncated', () => {
    renderCard(baseBlock({ truncated: true, row_count: 1240 }));
    const sentence = `Showing the first 2 of ${new Intl.NumberFormat('en-ZA').format(1240)} rows.`;
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === sentence)).toBeInTheDocument();
  });
});

describe('AnswerCard: API text is always inert text', () => {
  it('renders question, SQL and narrative containing markup as plain text', () => {
    const evil = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned = true">';
    const { container } = render(<div />);
    void container;
    renderCard(baseBlock({ question: evil, sql: `SELECT 1 -- ${evil}`, narrative: evil, title: `T ${evil}` }));
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(screen.getByText(evil, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(`SELECT 1 -- ${evil}`)).toBeInTheDocument();
  });
});

describe('AnswerCard: the SQL panel', () => {
  it('shows the query read-only and copies it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderCard(baseBlock());
    expect(screen.getByText(baseBlock().sql)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(baseBlock().sql);
    expect(screen.getByText('Copied the query.')).toBeInTheDocument();
  });
});

describe('AnswerCard: source rows', () => {
  const page = (offset: number, count: number): SourceRows => ({
    columns: [{ sql_name: 'store', label: 'Store' }],
    rows: Array.from({ length: count }, (_, i) => ({ store: `S${offset + i}` })),
    total: 75,
    limit: 50,
    offset,
  });

  it('loads 50 at a time with "Load more", with the privacy note', async () => {
    const urls: string[] = [];
    renderCard(baseBlock(), {
      transport: async (url) => {
        urls.push(url);
        const offset = Number(new URL(url).searchParams.get('offset'));
        return json(200, { data: page(offset, offset === 0 ? 50 : 25) });
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Show the rows this is based on' }));
    expect(await screen.findByText('Showing 1 to 50 of 75')).toBeInTheDocument();
    expect(screen.getByText('These are rows from your file. Only you can see this.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Showing 1 to 75 of 75')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(urls.map((u) => new URL(u).search)).toEqual(['?limit=50&offset=0', '?limit=50&offset=50']);
  });

  it('explains why there are no source rows', () => {
    renderCard(baseBlock({ has_source_rows: false }));
    expect(screen.getByText('This answer uses every row in your file, so there is no smaller set of rows to show.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show the rows this is based on' })).not.toBeInTheDocument();
  });

  it('says the original file was deleted when the dataset expired or is gone', () => {
    renderCard(baseBlock(), { dataset: { ...readyDataset, status: 'expired' } });
    expect(screen.getByText(/The original file was deleted on 2 December 2026/)).toBeInTheDocument();
  });
});

describe('AnswerCard: actions', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
  });

  it('downloads the CSV with the token and saves it under the server file name', async () => {
    let auth: string | null = null;
    configureApiClient({
      transport: async (_url, init) => {
        auth = new Headers(init.headers).get('Authorization');
        return new Response('﻿store,net\r\nA,100\r\n', {
          status: 200,
          headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="net-sales-by-store-2026-11-02.csv"' },
        });
      },
      getAccessToken: async () => 'token',
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let saved = '';
    click.mockImplementation(function (this: HTMLAnchorElement) {
      saved = this.download;
    });
    await downloadAnswerCsv({ id: 'b1', title: 'Net sales by store' });
    expect(auth).toBe('Bearer token');
    expect(saved).toBe('net-sales-by-store-2026-11-02.csv');
    click.mockRestore();
  });

  it('falls back to <title-slug>-<date>.csv when the file name is not readable', async () => {
    configureApiClient({ transport: async () => new Response('a\r\n', { status: 200 }), getAccessToken: async () => 't' });
    let saved = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved = this.download;
    });
    await downloadAnswerCsv({ id: 'b1', title: 'Net sales by store' });
    expect(saved).toMatch(/^net-sales-by-store-\d{4}-\d{2}-\d{2}\.csv$/);
    click.mockRestore();
  });

  it('sends "This looks wrong" with an optional note and confirms in words', async () => {
    const bodies: unknown[] = [];
    renderCard(baseBlock(), {
      transport: async (url, init) => {
        if (url.endsWith('/feedback')) bodies.push(JSON.parse(String(init.body)));
        return json(200, { data: { received: true } });
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'This looks wrong' }));
    const note = screen.getByLabelText('What looks wrong? (optional)');
    expect(note).toHaveAttribute('maxLength', '500');
    await userEvent.type(note, 'The total is too high');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Thank you. We have noted that this answer looks wrong.')).toBeInTheDocument();
    expect(bodies).toEqual([{ kind: 'looks_wrong', note: 'The total is too high' }]);
  });

  it('shows the pinned message on 409 conflict when deleting', async () => {
    renderCard(baseBlock(), { transport: async () => json(409, { error: { code: 'conflict', message: 'pinned' } }) });
    await userEvent.click(screen.getByRole('button', { name: 'Delete this answer' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete answer' }));
    expect(await within(screen.getByRole('dialog')).findByText("This answer is part of a report, so it can't be deleted.")).toBeInTheDocument();
  });

  it('follow-ups ask their question', async () => {
    const { onFollowUp } = renderCard(baseBlock());
    await userEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(onFollowUp).toHaveBeenCalledWith('Why?');
  });
});

describe('AnswerCard: accessibility', () => {
  it('every control is a real button reachable by Tab; disclosures expose aria-expanded', async () => {
    renderCard(baseBlock(), { newest: false });
    const how = screen.getByRole('button', { name: 'How this was calculated' });
    expect(how).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(how);
    expect(how).toHaveAttribute('aria-expanded', 'true');

    const buttons = screen.getAllByRole('button');
    const reached = new Set<Element>();
    for (let i = 0; i < buttons.length + 5; i++) {
      await userEvent.tab();
      if (document.activeElement) reached.add(document.activeElement);
    }
    for (const b of buttons) expect(reached.has(b)).toBe(true);
  });

  it('charts have a table alternative with the same rows', async () => {
    renderCard(baseBlock());
    const toggle = screen.getByRole('button', { name: 'View as table' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    const table = screen.getByRole('region', { name: /Table: Net sales by store/ });
    const cells = within(table).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[0]).toBe('A');
    expect(cells[1]).toBe(new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(100));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View as chart' })).toHaveAttribute('aria-pressed', 'true'));
  });
});

describe('AnswerCard: a null group key reads "(blank)"', () => {
  const keyCases = [
    { name: 'text', column: { name: 'store', format: 'text' as const }, value: 'A' },
    { name: 'numeric', column: { name: 'terminal_no', format: 'integer' as const }, value: 7 },
    { name: 'date', column: { name: 'day', format: 'date' as const }, value: '2026-10-01' },
  ];

  for (const { name, column, value } of keyCases) {
    it(`${name} key: "(blank)" in the table view, while a null value stays empty`, async () => {
      renderCard(
        baseBlock({
          columns: [column, { name: 'net', format: 'zar' }],
          rows: [
            { [column.name]: value, net: null },
            { [column.name]: null, net: 50 },
          ],
          chart: { type: 'bar', x: column.name, y: ['net'], series: null, orientation: 'vertical', stacked: false, value_format: { [column.name]: column.format, net: 'zar' } },
        }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
      const rows = within(screen.getByRole('region', { name: /^Table:/ })).getAllByRole('row');
      const cells = (i: number) => within(rows[i]!).getAllByRole('cell').map((c) => c.textContent);
      expect(cells(1)[1]).toBe(''); // a null value: empty, not "(blank)"
      expect(cells(2)[0]).toBe('(blank)'); // a null key
    });
  }

  it('a plain table shows "(blank)" in its text and date key columns', () => {
    renderCard(
      baseBlock({
        columns: [
          { name: 'store', format: 'text' },
          { name: 'day', format: 'date' },
          { name: 'net', format: 'zar' },
        ],
        rows: [{ store: null, day: null, net: null }],
        chart: { type: 'table', x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: { day: 'date', net: 'zar' } },
      }),
    );
    const cells = within(screen.getByRole('region', { name: /^Table:/ })).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['(blank)', '(blank)', '']);
  });

  it('pie labels written beside the chart show "(blank)"', () => {
    renderCard(
      baseBlock({
        columns: [{ name: 'card', format: 'text' }, { name: 'net', format: 'zar' }],
        rows: [
          { card: 'DEBIT', net: 5 },
          { card: null, net: 2 },
        ],
        chart: { type: 'pie', x: 'card', y: ['net'], series: null, orientation: 'vertical', stacked: false, value_format: { net: 'zar' } },
      }),
    );
    expect(screen.getByText('(blank)')).toBeInTheDocument();
  });
});
