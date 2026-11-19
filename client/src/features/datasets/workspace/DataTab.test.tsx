import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DatasetPreview } from '@/api/types';
import { formatNumber, formatZar } from '@/lib/format';
import { DataTab } from './DataTab';
import { column, dataset, fakeApi, renderAt } from './testing';

const COLUMNS = [
  column('Store', 'text'),
  column('Amount', 'decimal', { semantic: 'currency_zar', display_name: 'Net amount' }),
  column('Qty', 'integer'),
  column('Day', 'date'),
  column('Note', 'text'),
];

/** A preview for a request: row labels say which page, sort and search they answer. */
function page(url: URL, { total = 120, matched }: { total?: number; matched?: number } = {}): DatasetPreview {
  const offset = Number(url.searchParams.get('offset'));
  const limit = Number(url.searchParams.get('limit'));
  const count = matched ?? total;
  const tag = `${url.searchParams.get('sort') ?? 'file'}-${url.searchParams.get('dir') ?? ''}-${url.searchParams.get('q') ?? ''}`;
  return {
    columns: COLUMNS.map((c) => ({ sql_name: c.sql_name, label: c.name, data_type: c.data_type })),
    rows: Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, i) => ({
      store: `Row ${offset + i + 1} ${tag}`,
      amount: 1234.5,
      qty: 25310,
      day: '2026-10-01',
      note: i === 0 ? null : 'A long note that is shown on one line with the full value on hover',
    })),
    total_rows: total,
    matched_rows: count,
  };
}

const ds = dataset({ columns: COLUMNS, row_count: 120 });
const caption = () => screen.getByText(/^Showing/);
const firstCell = () => screen.getAllByRole('row')[1]!.querySelector('td')!;

describe('Data tab: paging', () => {
  it('asks for 50 rows at a time and pages with Previous and Next', async () => {
    const requests = fakeApi((url) => ({ body: page(url) }));
    renderAt(<DataTab dataset={ds} />);
    expect(await screen.findByText(`Showing 1 to 50 of ${formatNumber(120, 0)} rows`)).toBeInTheDocument();
    expect(requests[0]!.pathname).toBe('/api/v1/datasets/d1/preview');
    expect(requests[0]!.searchParams.get('limit')).toBe('50');
    expect(requests[0]!.searchParams.get('offset')).toBe('0');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51 to 100 of 120 rows')).toBeInTheDocument();
    expect(requests.at(-1)!.searchParams.get('offset')).toBe('50');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 101 to 120 of 120 rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 51 to 100 of 120 rows')).toBeInTheDocument();
  });
});

describe('Data tab: sorting', () => {
  it('the header button cycles ascending, descending, off, with aria-sort and the word in its name', async () => {
    const requests = fakeApi((url) => ({ body: page(url) }));
    renderAt(<DataTab dataset={ds} />);
    await screen.findByText(/^Showing 1 to 50/);
    // Go to page 2 first: sorting starts again at row 1.
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/^Showing 51 to 100/);

    const header = screen.getByRole('columnheader', { name: /Net amount/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    await userEvent.click(within(header).getByRole('button'));
    await screen.findByText(/^Showing 1 to 50/);
    let last = requests.at(-1)!.searchParams;
    expect([last.get('sort'), last.get('dir'), last.get('offset')]).toEqual(['amount', 'asc', '0']);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(within(header).getByRole('button', { name: 'Net amount. Sorted ascending' })).toBeInTheDocument();

    await userEvent.click(within(header).getByRole('button'));
    await waitFor(() => expect(header).toHaveAttribute('aria-sort', 'descending'));
    last = requests.at(-1)!.searchParams;
    expect([last.get('sort'), last.get('dir')]).toEqual(['amount', 'desc']);
    expect(within(header).getByRole('button', { name: 'Net amount. Sorted descending' })).toBeInTheDocument();

    await userEvent.click(within(header).getByRole('button'));
    await waitFor(() => expect(header).toHaveAttribute('aria-sort', 'none'));
    expect(requests.at(-1)!.searchParams.has('sort')).toBe(false);
    expect(within(header).getByRole('button', { name: 'Net amount' })).toBeInTheDocument();
  });

  it('sort buttons are reachable and work from the keyboard', async () => {
    const requests = fakeApi((url) => ({ body: page(url) }));
    renderAt(<DataTab dataset={ds} />);
    await screen.findByText(/^Showing 1 to 50/);
    const button = screen.getByRole('button', { name: 'Store' });
    expect(button.tagName).toBe('BUTTON');
    button.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('sort')).toBe('store'));
    expect(button.className).toMatch(/focus-visible:ring-2/);
  });
});

describe('Data tab: search', () => {
  it('is debounced: typing a word sends one request, and the search starts at row 1', async () => {
    const requests = fakeApi((url) => ({ body: page(url, url.searchParams.get('q') ? { matched: 12, total: 25310 } : {}) }));
    renderAt(<DataTab dataset={dataset({ columns: COLUMNS, row_count: 25310 })} />);
    await screen.findByText(/^Showing 1 to 50/);
    expect(screen.getByText('Searches text columns')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'sandton');
    expect((await screen.findByText(/matching rows/)).textContent).toBe(
      `Showing 1 to 12 of 12 matching rows (${formatNumber(25310, 0)} in the file)`,
    );
    const searches = requests.filter((r) => r.searchParams.has('q'));
    expect(searches).toHaveLength(1);
    expect(searches[0]!.searchParams.get('q')).toBe('sandton');
    expect(searches[0]!.searchParams.get('offset')).toBe('0');
  });

  it('Clear empties the box and shows every row again', async () => {
    const requests = fakeApi((url) => ({ body: page(url, url.searchParams.get('q') ? { matched: 3 } : {}) }));
    renderAt(<DataTab dataset={ds} />);
    await screen.findByText(/^Showing 1 to 50/);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'x');
    await screen.findByText(/matching rows/);
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
    expect(await screen.findByText('Showing 1 to 50 of 120 rows')).toBeInTheDocument();
    expect(requests.at(-1)!.searchParams.has('q')).toBe(false);
  });

  it('no match: says so, with a Clear search button', async () => {
    fakeApi((url) => ({ body: page(url, url.searchParams.get('q') ? { matched: 0 } : {}) }));
    renderAt(<DataTab dataset={ds} />);
    await screen.findByText(/^Showing 1 to 50/);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzz');
    const empty = (await screen.findByText('No rows match “zzz”.')).parentElement!;
    await userEvent.click(within(empty).getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Showing 1 to 50 of 120 rows')).toBeInTheDocument();
  });

  it('a file with no text columns has no search box', async () => {
    fakeApi((url) => ({ body: page(url) }));
    renderAt(<DataTab dataset={dataset({ columns: [column('Qty', 'integer'), column('Day', 'date')] })} />);
    await screen.findByText(/^Showing/);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Searches text columns')).not.toBeInTheDocument();
  });

  it('arriving with ?q= (See the rows) fills the box and searches', async () => {
    const requests = fakeApi((url) => ({ body: page(url, url.searchParams.get('q') ? { matched: 2 } : {}) }));
    renderAt(<DataTab dataset={ds} />, '/datasets/d1/data?q=Cafe');
    expect(await screen.findByText(/of 2 matching rows/)).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('Cafe');
    expect(requests.every((r) => r.searchParams.get('q') === 'Cafe')).toBe(true);
  });
});

describe('Data tab: stale responses', () => {
  it('a slow answer for an earlier sort never replaces the current one; the old page stays while the next loads', async () => {
    let releaseAsc: () => void = () => {};
    fakeApi((url) => {
      if (url.searchParams.get('dir') === 'asc') {
        return new Promise((resolve) => {
          releaseAsc = () => resolve({ body: page(url) });
        });
      }
      return { body: page(url) };
    });
    renderAt(<DataTab dataset={ds} />);
    await screen.findByText(/^Showing 1 to 50/);
    const button = () => within(screen.getByRole('columnheader', { name: /Store/ })).getByRole('button');

    await userEvent.click(button()); // ascending: held back
    // The previous page stays on screen, marked busy, while the next loads.
    expect(firstCell()).toHaveTextContent('Row 1 file--');
    expect(screen.getByRole('region', { name: /Rows of your file/ })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading the rows…')).toBeInTheDocument();

    await userEvent.click(button()); // descending: answers at once
    await waitFor(() => expect(firstCell()).toHaveTextContent('Row 1 store-desc-'));
    releaseAsc();
    await new Promise((r) => setTimeout(r, 20));
    expect(firstCell()).toHaveTextContent('Row 1 store-desc-');
    expect(screen.getByRole('columnheader', { name: /Store/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('region', { name: /Rows of your file/ })).toHaveAttribute('aria-busy', 'false');
    expect(caption()).toHaveTextContent('Showing 1 to 50 of 120 rows');
  });
});

describe('Data tab: formatting', () => {
  it('rand for money columns, en-ZA numbers right-aligned, dates as sent, nulls empty with a label, long text in a title', async () => {
    fakeApi((url) => ({ body: page(url) }));
    renderAt(<DataTab dataset={ds} />);
    await screen.findByText(/^Showing/);
    const [, first, second] = screen.getAllByRole('row');
    const cells = within(first!).getAllByRole('cell');
    expect(cells[1]!.textContent).toBe(formatZar(1234.5));
    expect(cells[1]!.textContent).toMatch(/^R/);
    expect(cells[2]!.textContent).toBe(formatNumber(25310, 0));
    expect(cells[2]!.className).toMatch(/text-right/);
    expect(cells[3]).toHaveTextContent('2026-10-01');
    // Null: an empty cell that says "empty" to a screen reader.
    expect(within(cells[4]!).getByText('empty')).toHaveClass('sr-only');
    const note = within(second!).getAllByRole('cell')[4]!;
    expect(note).toHaveAttribute('title', 'A long note that is shown on one line with the full value on hover');
    expect(note.className).toMatch(/truncate/);
    // Headers use the display name; the first column stays in view.
    expect(screen.getByRole('columnheader', { name: /Net amount/ })).toBeInTheDocument();
    expect(cells[0]!.className).toMatch(/sticky left-0/);
  });
});

describe('Data tab: errors', () => {
  it.each([
    [409, 'dataset_not_ready', 'This file is still being read. Try again in a moment.'],
    [410, 'dataset_expired', 'This file has expired, so its rows can no longer be shown.'],
  ])('%i %s is said in words, with Retry', async (status, code, words) => {
    let fail = true;
    const requests = fakeApi((url) => (fail ? { status, body: { code, message: 'x' } } : { body: page(url) }));
    renderAt(<DataTab dataset={ds} />);
    expect(await screen.findByText(words)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/^Showing 1 to 50/)).toBeInTheDocument();
    expect(requests).toHaveLength(2);
  });

  it('shows a loading skeleton first', async () => {
    fakeApi(() => new Promise(() => {}));
    renderAt(<DataTab dataset={ds} />);
    expect(await screen.findByRole('status', { name: 'Loading the rows' })).toBeInTheDocument();
  });
});

describe('Data tab: the Columns card', () => {
  it('holds the column editing, and can be hidden and shown again', async () => {
    fakeApi((url) => ({ body: page(url) }));
    renderAt(<DataTab dataset={ds} />);
    const toggle = await screen.findByRole('button', { name: 'Hide columns' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: 'Columns' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Store', level: 3 })).toBeVisible();
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show columns' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Store', level: 3 })).not.toBeInTheDocument();
  });
});
