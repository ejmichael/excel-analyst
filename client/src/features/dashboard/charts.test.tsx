import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Block, WidgetResult } from '@/api/types';
import { BlockChart, TOOLTIP_PLACEMENT, readableAxisWidth } from '@/features/ask/BlockChart';
import { FULL_LABEL_MAX, buildChartModel, needsHorizontal, readableLines } from '@/features/ask/chartData';
import { formatValue } from '@/lib/format';
import { chart, result, widget } from './testing';
import { Widget } from './Widget';

type Rows = Array<{ niche: string; leads: number }>;
const block = (rows: Rows, type: 'bar' | 'pie' = 'bar'): Pick<Block, 'title' | 'chart' | 'columns' | 'rows'> => ({
  title: 'Leads by niche',
  chart: chart(type, 'niche', ['leads'], { leads: 'integer' }),
  columns: [{ name: 'niche', format: 'text' }, { name: 'leads', format: 'integer' }],
  rows,
});
const cartesian = (rows: Rows) => {
  const model = buildChartModel(block(rows));
  if (model.kind !== 'cartesian') throw new Error('expected a cartesian model');
  return model;
};
const LONG = [
  { niche: 'Barbershops and salons', leads: 12 },
  { niche: 'Dieticians', leads: 7 },
  { niche: 'Hairdressers', leads: 5 },
];
const SHORT = [
  { niche: 'Barbers', leads: 12 },
  { niche: 'Dentists', leads: 7 },
];
const orientation = () => screen.getByRole('img').getAttribute('data-orientation');

describe('dashboard bar charts read their categories', () => {
  it('turn horizontal when a label is longer than 10 characters', () => {
    expect(needsHorizontal(cartesian([{ niche: 'Hairdresser', leads: 1 }]))).toBe(true);
    expect(needsHorizontal(cartesian([{ niche: 'Hairdresse', leads: 1 }]))).toBe(false);
  });

  it('turn horizontal with more than 6 categories', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ niche: `N${i}`, leads: i }));
    expect(needsHorizontal(cartesian(rows(7)))).toBe(true);
    expect(needsHorizontal(cartesian(rows(6)))).toBe(false);
  });

  it('a dashboard widget draws the switched chart on its side; the data and order are unchanged', async () => {
    const w = widget('b', { title: 'Leads by niche', width: 'half', chart: chart('bar', 'niche', ['leads'], { leads: 'integer' }) });
    const r: WidgetResult = result('b', { columns: block(LONG).columns, rows: LONG, total_rows: 3 });
    render(<Widget widget={w} result={r} filtered={false} />);
    expect(orientation()).toBe('horizontal');
    await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const table = screen.getByRole('region', { name: /Table: Leads by niche/ });
    // The full label and the server's order, in the table view.
    expect(within(table).getAllByRole('row').slice(1).map((row) => row.firstElementChild?.textContent)).toEqual([
      'Barbershops and salons',
      'Dieticians',
      'Hairdressers',
    ]);
  });

  it('short labels and few categories stay vertical on the dashboard', () => {
    render(<BlockChart block={block(SHORT)} readable />);
    expect(orientation()).toBe('vertical');
  });

  it('the Ask answer card is not changed: the same long labels stay vertical', () => {
    render(<BlockChart block={block(LONG)} />);
    expect(orientation()).toBe('vertical');
  });

  it(`labels up to ${FULL_LABEL_MAX} characters are shown in full on at most two lines; longer ones are cut`, () => {
    for (const label of ['Barber', 'Hairdressers', 'Barbershops and salons', 'Physiotherapy practices, CT', 'Supercalifragilisticexpialid']) {
      const lines = readableLines(label);
      expect(label.length).toBeLessThanOrEqual(FULL_LABEL_MAX);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines.join(' ').replace(/\s+/g, '')).toBe(label.replace(/\s+/g, ''));
      expect(lines.some((l) => l.endsWith('…'))).toBe(false);
    }
    const long = readableLines('Independent veterinary clinics and animal hospitals');
    expect(long).toHaveLength(2);
    expect(long[1]!.endsWith('…')).toBe(true);
  });

  it('the label column fits the longest line, at most 45% of the chart', () => {
    expect(readableAxisWidth(['Barbershops and salons'], 600)).toBeGreaterThan(readableAxisWidth(['Barber'], 600));
    expect(readableAxisWidth(['Barbershops and salons and spas'], 300)).toBeLessThanOrEqual(135);
  });
});

describe('tooltips', () => {
  it('are offset from the pointer and kept inside the plot area (clear of the axis labels)', () => {
    expect(TOOLTIP_PLACEMENT.offset).toBeGreaterThanOrEqual(24);
    expect(TOOLTIP_PLACEMENT.allowEscapeViewBox).toEqual({ x: false, y: false });
    expect(TOOLTIP_PLACEMENT.wrapperStyle.pointerEvents).toBe('none');
  });
});

describe('the donut legend', () => {
  const statuses = [
    { niche: 'paid', leads: 146 },
    { niche: 'refunded', leads: 20 },
    { niche: 'pending', leads: 14 },
  ];

  it('on the dashboard: one entry per line with a swatch, the label and the formatted value', () => {
    render(<BlockChart block={block(statuses, 'pie')} readable />);
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(legend.className).not.toMatch(/grid-cols/);
    const items = within(legend).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    items.forEach((item, i) => {
      const [swatch, label, value] = [...item.children];
      expect(swatch).toHaveAttribute('aria-hidden', 'true');
      expect(label).toHaveTextContent(statuses[i]!.niche);
      expect(value!.textContent).toBe(formatValue(statuses[i]!.leads, 'integer'));
    });
  });

  it('the Ask answer card keeps its two-column legend', () => {
    const { container } = render(<BlockChart block={block(statuses, 'pie')} />);
    expect(container.querySelector('[data-pie-legend]')).toBeNull();
    expect(container.querySelector('ul')!.className).toMatch(/sm:grid-cols-2/);
  });
});
