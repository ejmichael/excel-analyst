import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardWidget, WidgetResult } from '@/api/types';
import { dataset } from '@/features/datasets/workspace/testing';
import { formatValue } from '@/lib/format';
import { DashboardTab } from './DashboardTab';
import { widthClass } from './layout';
import { chart, dashboard, data, fakeCalls, renderTab, result, widget } from './testing';
import { NO_VALUE, TABLE_ROWS, Widget } from './Widget';

function show(w: DashboardWidget, r: WidgetResult | undefined, filtered = false) {
  return render(<Widget widget={w} result={r} filtered={filtered} />);
}

const card = () => document.querySelector('[data-widget]') as HTMLElement;
const kpiText = () => document.querySelector('[data-kpi-value]')?.textContent;

const byProduct = widget('w5', {
  title: 'Revenue by product',
  width: 'half',
  chart: chart('bar', 'product', ['revenue'], { revenue: 'zar' }),
});
const productRows: WidgetResult = result('w5', {
  columns: [{ name: 'product', format: 'text' }, { name: 'revenue', format: 'zar' }],
  rows: [
    { product: 'Biltong', revenue: 1200.5 },
    { product: 'Candle', revenue: 830 },
  ],
  total_rows: 2,
});

describe('kpi tiles', () => {
  it.each([
    ['zar', 1234.5],
    ['integer', 25310],
    ['percent', 0.125],
    ['number', 3.75],
  ] as const)('formats a %s value with the app formatter', (format, value) => {
    show(widget('k', { chart: chart('kpi', null, ['v'], { v: format }) }), result('k', { columns: [{ name: 'v', format }], rows: [{ v: value }] }));
    expect(kpiText()).toBe(formatValue(value, format));
  });

  it('shows the en-ZA forms: rand, grouping and percent from a fraction', () => {
    expect(formatValue(1234.5, 'zar').replace(/\s/g, ' ')).toBe('R 1 234,50');
    expect(formatValue(25310, 'integer').replace(/\s/g, ' ')).toBe('25 310');
    expect(formatValue(0.125, 'percent')).toBe('12,5%');
  });

  it('a null value reads "–"; nothing else is on the tile but the title and the working', () => {
    show(widget('k', { title: 'Largest refund', chart: chart('kpi', null, ['v'], { v: 'zar' }) }), result('k', { columns: [{ name: 'v', format: 'zar' }], rows: [{ v: null }] }));
    expect(kpiText()).toBe(NO_VALUE);
    expect(within(card()).getByRole('heading', { name: 'Largest refund' })).toBeInTheDocument();
    expect(within(card()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Show the working']);
  });

  it('the value comes from the first row and the first y column only', () => {
    show(
      widget('k', { chart: chart('kpi', null, ['b', 'a'], { a: 'integer', b: 'integer' }) }),
      result('k', { columns: [{ name: 'a', format: 'integer' }, { name: 'b', format: 'integer' }], rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] }),
    );
    expect(kpiText()).toBe('2');
  });
});

describe('charts', () => {
  it.each(['bar', 'line', 'area', 'pie'] as const)('%s: drawn by the answer chart, named by its title, with a data table', async (type) => {
    show({ ...byProduct, chart: { ...byProduct.chart, type } }, productRows);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toContain('Revenue by product');
    await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const table = screen.getByRole('region', { name: /Table: Revenue by product/ });
    expect(within(table).getByRole('columnheader', { name: 'Revenue' })).toBeInTheDocument();
    expect(within(table).getByText('Biltong')).toBeInTheDocument();
    expect(within(table).getByText((_, el) => el?.textContent === formatValue(1200.5, 'zar') && el.tagName === 'TD')).toBeInTheDocument();
  });
});

describe('tables', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ order_id: `#${1001 + i}`, total: 100 + i }));
  const tableWidget = widget('t', { title: 'Refunded orders', width: 'full', chart: chart('table', null, ['total'], { total: 'zar' }) });
  const tableResult = result('t', { columns: [{ name: 'order_id', format: 'text' }, { name: 'total', format: 'zar' }], rows, total_rows: 12 });

  it(`shows ${TABLE_ROWS} rows under a sticky header; Show all expands to the rows sent`, async () => {
    show(tableWidget, tableResult);
    const region = screen.getByRole('region', { name: 'Table: Refunded orders' });
    expect(within(region).getAllByRole('row')).toHaveLength(TABLE_ROWS + 1);
    expect(within(region).getAllByRole('columnheader')[0]!.className).toMatch(/sticky top-0/);
    await userEvent.click(screen.getByRole('button', { name: 'Show all 12' }));
    expect(within(region).getAllByRole('row')).toHaveLength(13);
    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(region).getAllByRole('row')).toHaveLength(TABLE_ROWS + 1);
  });

  it('no Show all when every row fits', () => {
    show(tableWidget, { ...tableResult, rows: rows.slice(0, 4), total_rows: 4 });
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('a truncated result says so, with the server numbers', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ order_id: `#${i}`, total: i }));
    show(tableWidget, { ...tableResult, rows: many, total_rows: 180, truncated: true });
    expect(screen.getByText('Showing the first 50 of 180 rows')).toBeInTheDocument();
  });
});

describe('errors and empty results', () => {
  it('a widget with an error keeps its title and says it could not be built', () => {
    show(byProduct, result('w5', { error: 'Binder Error', columns: [], rows: [] }));
    expect(within(card()).getByRole('heading', { name: 'Revenue by product' })).toBeInTheDocument();
    expect(card()).toHaveTextContent('This could not be built for this selection.');
    expect(card()).not.toHaveTextContent('Try changing the filters.');
  });

  it('…and, with filters on, suggests changing them', () => {
    show(byProduct, result('w5', { error: 'Binder Error', columns: [], rows: [] }), true);
    expect(card()).toHaveTextContent('This could not be built for this selection.Try changing the filters.');
  });

  it('an empty result under filters: "No rows match these filters."', () => {
    show(byProduct, { ...productRows, rows: [], total_rows: 0 }, true);
    expect(card()).toHaveTextContent('No rows match these filters.');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('one failing widget leaves the rest of the page as it is', async () => {
    const board = dashboard({
      widgets: [widget('w1', { title: 'Orders' }), { ...byProduct, position: 2 }],
    });
    fakeCalls((call) =>
      call.path.endsWith('/data') ? { body: data([result('w1', { rows: [{ n: 180 }] }), result('w5', { error: 'Binder Error', columns: [], rows: [] })]) } : { body: board },
    );
    renderTab(<DashboardTab dataset={dataset()} />);
    expect(await screen.findByText('This could not be built for this selection.')).toBeInTheDocument();
    expect(kpiText()).toBe('180');
  });
});

describe('Show the working', () => {
  it('the SQL with Copy, the checks (a failed one is a visible warning) and the result rows', async () => {
    const checks = [
      { type: 'sql_read_only' as const, ok: true, label: 'The query only reads your file' },
      { type: 'result_not_truncated' as const, ok: false, label: 'Only the first 50 result rows are shown' },
    ];
    show(byProduct, { ...productRows, checks });
    // The failed check shows on the card itself, before the working is opened.
    expect(card()).toHaveTextContent('A check did not pass.');
    const toggle = screen.getByRole('button', { name: 'Show the working' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const working = document.querySelector('[data-working]') as HTMLElement;
    expect(within(working).getByText(byProduct.sql)).toBeInTheDocument();
    expect(within(working).getByText(byProduct.sql).closest('pre')).toHaveClass('font-mono');
    expect(within(working).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    const list = within(working).getByRole('list', { name: 'Checks' });
    expect(list).toHaveTextContent('Passed: The query only reads your file');
    expect(list).toHaveTextContent('Did not pass: Only the first 50 result rows are shown');
    const rows = within(working).getByRole('region', { name: 'Result rows: Revenue by product' });
    expect(within(rows).getByText('Candle')).toBeInTheDocument();
  });

  it('every widget has it, also one that could not be built', () => {
    show(byProduct, result('w5', { error: 'Binder Error: column "x" not found', columns: [], rows: [], checks: [] }));
    expect(screen.getByRole('button', { name: 'Show the working' })).toBeInTheDocument();
  });
});

describe('the grid', () => {
  it.each([
    ['quarter', ['col-span-6', 'lg:col-span-3']],
    ['half', ['col-span-12', 'lg:col-span-6']],
    ['full', ['col-span-12']],
  ] as const)('%s: phone and tablet, then desktop from 1024px', (width, classes) => {
    expect(widthClass(width).split(' ')).toEqual(classes);
    show(widget('k', { width }), result('k'));
    for (const c of classes) expect(card()).toHaveClass(c);
  });

  it('widgets in position order, in a 12-column grid; none of the actions this part does not build', async () => {
    const board = dashboard({
      widgets: [
        widget('w3', { title: 'Third', position: 3, width: 'full', chart: chart('table', null, []) }),
        widget('w1', { title: 'First', position: 1 }),
        { ...byProduct, id: 'w2', title: 'Second', position: 2 },
      ],
    });
    fakeCalls((call) =>
      call.path.endsWith('/data')
        ? { body: data([result('w1'), { ...productRows, widget_id: 'w2' }, result('w3', { columns: [{ name: 'n', format: 'integer' }] })]) }
        : { body: board },
    );
    renderTab(<DashboardTab dataset={dataset()} />);
    await screen.findByText('25 of 25 rows');
    const grid = document.querySelector('[data-widget-grid]')!;
    expect(grid).toHaveClass('grid-cols-12');
    expect(within(grid as HTMLElement).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['First', 'Second', 'Third']);
    const labels = [...screen.getAllByRole('button'), ...screen.queryAllByRole('link')].map((b) => b.textContent ?? '');
    for (const label of labels) {
      expect(label).not.toMatch(/customi[sz]e|save to|report|excel|pdf|download|share|snapshot|insight|previous period|compare/i);
    }
  });
});
