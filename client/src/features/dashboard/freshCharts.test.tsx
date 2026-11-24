import { cloneElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { BLOCK_TEMPLATES, blockFrom } from '@/api/mocks/blockFixtures';
import type { Block } from '@/api/types';
import { AnswerCard } from '@/features/ask/AnswerCard';
import { BAR_RADIUS, BlockChart, barRadius } from '@/features/ask/BlockChart';
import { CHART_COLOURS, FRESH_COLOURS, colourAt } from '@/features/ask/chartPalette';
import { MIN_SERIES_DELTA_E, contrastRatio, deltaE76 } from '@/lib/color';
import { chart } from './testing';

// jsdom has no layout, so the responsive container would draw nothing: give every chart a fixed size instead.
vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  return {
    ...recharts,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 300 }),
  };
});

type ChartType = 'bar' | 'line' | 'area' | 'pie';
const ROWS = [
  { month: '2026-08', sales: 120, refunds: 4 },
  { month: '2026-09', sales: 150, refunds: 6 },
  { month: '2026-10', sales: 90, refunds: 2 },
];
const block = (type: ChartType, y: string[] = ['sales']): Pick<Block, 'title' | 'chart' | 'columns' | 'rows'> => ({
  title: 'Sales by month',
  chart: chart(type, 'month', y, { sales: 'integer', refunds: 'integer' }),
  columns: [
    { name: 'month', format: 'text' },
    { name: 'sales', format: 'integer' },
    { name: 'refunds', format: 'integer' },
  ],
  rows: ROWS,
});

const BLOCK = {
  ...blockFrom(BLOCK_TEMPLATES[0]!, { question: 'Sales by month?', datasetId: 'd1', source: 'user', createdAt: '2026-11-02T10:00:00+02:00' }),
  id: 'b1',
};

const fills = (container: HTMLElement, selector: string) =>
  [...container.querySelectorAll(selector)].map((el) => el.getAttribute('fill'));

describe('the app palette (W2c)', () => {
  it('is the new order, green first', () => {
    expect(FRESH_COLOURS[0]).toBe('#0E9F6E');
    expect(colourAt(0, 'fresh')).toBe('#0E9F6E');
    expect(FRESH_COLOURS).toHaveLength(10);
  });

  it('every colour is at least 3:1 on white', () => {
    for (const colour of FRESH_COLOURS) expect(contrastRatio(colour, '#FFFFFF'), colour).toBeGreaterThanOrEqual(3);
  });

  it(`every pair of the ten is at least ${MIN_SERIES_DELTA_E} apart (the Part 5c rule)`, () => {
    for (let i = 0; i < FRESH_COLOURS.length; i++) {
      for (let j = i + 1; j < FRESH_COLOURS.length; j++) {
        expect(deltaE76(FRESH_COLOURS[i]!, FRESH_COLOURS[j]!), `${FRESH_COLOURS[i]} / ${FRESH_COLOURS[j]}`).toBeGreaterThanOrEqual(MIN_SERIES_DELTA_E);
      }
    }
  });
});

describe('app charts and report charts', () => {
  it('a dashboard or Ask chart with one series is drawn in green', () => {
    const { container } = render(<BlockChart block={block('bar')} fresh />);
    const bars = fills(container, '.recharts-bar-rectangle path');
    expect(bars.length).toBe(3);
    expect(new Set(bars)).toEqual(new Set(['#0E9F6E']));
    expect(container.querySelector('[data-chart-style]')).toHaveAttribute('data-chart-style', 'fresh');
  });

  it('a report chart still uses the previous series colours (swappable by the document look)', () => {
    const { container } = render(<BlockChart block={block('bar', ['sales', 'refunds'])} />);
    const bars = fills(container, '.recharts-bar-rectangle path');
    expect(bars).toContain(`var(--series-1, ${CHART_COLOURS[0]})`);
    expect(bars).toContain(`var(--series-2, ${CHART_COLOURS[1]})`);
    expect(container.querySelector('[data-chart-style]')).toHaveAttribute('data-chart-style', 'report');
    // And none of the W2c styling: square bars, no gradients.
    expect(container.querySelector('linearGradient')).toBeNull();
  });

  it.each<['answer' | 'report' | 'public', string]>([
    ['answer', 'fresh'],
    ['report', 'report'],
    ['public', 'report'],
  ])('an answer card in %s mode draws its chart in the %s style', (mode, style) => {
    const answer = { ...BLOCK, chart: block('bar').chart, columns: block('bar').columns, rows: ROWS } as Block;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AnswerCard block={answer} dataset={{ exists: true, status: 'ready', expires_at: null, columns: [] }} mode={mode} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(document.querySelector('[data-chart-style]')).toHaveAttribute('data-chart-style', style);
  });

  it('a printed report chart keeps the previous colours too', () => {
    const { container } = render(<BlockChart block={block('bar')} look="print" />);
    expect(new Set(fills(container, '.recharts-bar-rectangle path'))).toEqual(new Set([`var(--series-1, ${CHART_COLOURS[0]})`]));
  });
});

describe('app chart styling', () => {
  it('bars round their outer end only: the top of a vertical bar, the right of a horizontal one, the outermost of a stack', () => {
    expect(barRadius(false, true)).toEqual([BAR_RADIUS, BAR_RADIUS, 0, 0]);
    expect(barRadius(true, true)).toEqual([0, BAR_RADIUS, BAR_RADIUS, 0]);
    expect(barRadius(false, false)).toBe(0);
    expect(BAR_RADIUS).toBeGreaterThanOrEqual(4);
    expect(BAR_RADIUS).toBeLessThanOrEqual(5);
  });

  it('a rounded bar is drawn with curved corners; a report bar is not', () => {
    const app = render(<BlockChart block={block('bar')} fresh />);
    // A rounded rectangle path uses arcs (A); a square one only lines.
    expect(app.container.querySelector('.recharts-bar-rectangle path')!.getAttribute('d')).toMatch(/A/);
    app.unmount();
    const report = render(<BlockChart block={block('bar')} />);
    expect(report.container.querySelector('.recharts-bar-rectangle path')!.getAttribute('d')).not.toMatch(/A/);
  });

  it('two area charts on one page have their own gradient ids', () => {
    const { container } = render(
      <>
        <BlockChart block={block('area')} fresh />
        <BlockChart block={block('area')} fresh />
      </>,
    );
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // Each area is filled with its own chart's gradient.
    const areaFills = fills(container, '.recharts-area-area');
    expect(areaFills).toEqual(ids.map((id) => `url(#${id})`));
  });

  it('the gradient runs from the series colour at 28% to nothing', () => {
    const { container } = render(<BlockChart block={block('line')} fresh />);
    const stops = [...container.querySelectorAll('linearGradient stop')];
    expect(stops.map((s) => [s.getAttribute('stop-color'), s.getAttribute('stop-opacity')])).toEqual([
      ['#0E9F6E', '0.28'],
      ['#0E9F6E', '0'],
    ]);
  });

  it.each<[ChartType, boolean]>([
    ['line', true],
    ['area', true],
    ['bar', false],
    ['pie', false],
  ])('a %s chart has a gradient fill: %s', (type, expected) => {
    const { container } = render(<BlockChart block={block(type)} fresh />);
    expect(container.querySelector('linearGradient') !== null).toBe(expected);
  });

  it('lines are 2.4px with round joins', () => {
    const { container } = render(<BlockChart block={block('line')} fresh />);
    const line = container.querySelector('.recharts-area-curve')!;
    expect(line.getAttribute('stroke-width')).toBe('2.4');
    expect(line.getAttribute('stroke-linejoin')).toBe('round');
  });

  it('app charts have no axis lines; report charts keep theirs', () => {
    const app = render(<BlockChart block={block('bar')} fresh />);
    expect(app.container.querySelector('.recharts-cartesian-axis-line')).toBeNull();
    app.unmount();
    const report = render(<BlockChart block={block('bar')} />);
    expect(report.container.querySelector('.recharts-cartesian-axis-line')).not.toBeNull();
  });
});
