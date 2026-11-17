import { describe, expect, it } from 'vitest';
import { getNiceTickValues } from 'recharts/lib/util/scale/getNiceTickValues';
import type { Block } from '@/api/types';
import { MIN_SERIES_DELTA_E, deltaE76 } from '@/lib/color';
import { formatValue } from '@/lib/format';
import { documentVars } from '@/features/reports/document';
import { PRINT_CHART_WIDTH, printChartHeight } from './BlockChart';
import { buildChartModel, valueAxis, type ChartModel } from './chartData';
import { CHART_COLOURS, SERIES_COLOURS, colourAt, fillAt, isHatched, swatchAt } from './chartPalette';

type Cartesian = Extract<ChartModel, { kind: 'cartesian' }>;

function model(rows: Array<Record<string, string | number | null>>, format: 'integer' | 'number' | 'zar' | 'percent', extra: Partial<Block['chart']> = {}): Cartesian {
  const block = {
    id: 'b', dataset_id: 'd', question: 'q', title: 't', sql: '', narrative: '', follow_ups: [], checks: [], status: 'ok', source: 'user',
    has_source_rows: false, created_at: '2026-11-01T00:00:00+02:00', truncated: false, row_count: rows.length,
    columns: [{ name: 'k', format: 'text' }, { name: 'v', format }],
    rows,
    chart: { type: 'bar', x: 'k', y: ['v'], series: null, orientation: 'vertical', stacked: false, value_format: { v: format }, ...extra },
  } as unknown as Block;
  const m = buildChartModel(block);
  if (m.kind !== 'cartesian') throw new Error('expected a cartesian model');
  return m;
}

/** The ticks the chart library draws for a value domain with the axis options BlockChart passes. */
const ticksFor = (domain: [number, number], m: Cartesian) => {
  const axis = valueAxis(m);
  return getNiceTickValues(domain, axis.tickCount, axis.allowDecimals);
};

describe('A1: whole-number axes never mislead', () => {
  it.each([
    ['0 to 3', [1, 3, 2], [0, 3], [0, 1, 2, 3]],
    ['0 to 1', [1, 0, 1], [0, 1], [0, 1]],
    ['0 to 5000', [1200, 5000, 3400], [0, 5000], null],
  ] as const)('%s: whole, unique ticks whose labels equal their positions', (_name, values, domain, exact) => {
    const m = model(values.map((v, i) => ({ k: `s${i}`, v })), 'integer');
    expect(valueAxis(m).allowDecimals).toBe(false);
    const ticks = ticksFor([domain[0], domain[1]], m);
    if (exact) expect(ticks).toEqual(exact);
    expect(ticks.every((t) => Number.isInteger(t))).toBe(true);
    expect(new Set(ticks).size).toBe(ticks.length);
    // Each label reads back as the tick's true position (no rounding to a wrong number).
    for (const t of ticks) expect(Number(formatValue(t, 'integer').replace(/\s/g, ''))).toBe(t);
  });

  it('the bug case: without whole-number ticks, 0 to 3 would draw 0.75 steps that round to "0, 1, 2, 2, 3"', () => {
    const fractional = getNiceTickValues([0, 3], 5, true);
    expect(fractional).toEqual([0, 0.75, 1.5, 2.25, 3]);
    expect(fractional.map((t) => formatValue(t, 'integer'))).toEqual(['0', '1', '2', '2', '3']);
  });

  it('whole values in a decimal format also get whole ticks', () => {
    expect(valueAxis(model([{ k: 'a', v: 2 }, { k: 'b', v: 3 }], 'number')).allowDecimals).toBe(false);
  });

  it('a stacked whole-number axis keeps the default tick count (its top is a stack the client does not add up)', () => {
    const m = model([{ k: 'a', v: 1 }, { k: 'b', v: 2 }], 'integer', { stacked: true });
    expect(valueAxis(m)).toEqual({ allowDecimals: false, tickCount: 5 });
  });

  it('percent and ZAR axes with fractions are unchanged: decimals allowed, default tick count', () => {
    expect(valueAxis(model([{ k: 'a', v: 0.42 }, { k: 'b', v: 0.58 }], 'percent'))).toEqual({ allowDecimals: true, tickCount: 5 });
    expect(valueAxis(model([{ k: 'a', v: 99284.58 }, { k: 'b', v: 90501.94 }], 'zar'))).toEqual({ allowDecimals: true, tickCount: 5 });
  });
});

describe('A2: distinct series colours', () => {
  it('ten series get ten different colours; the eleventh is hatched', () => {
    const fills = Array.from({ length: 11 }, (_, i) => fillAt('c1', i));
    expect(new Set(fills.slice(0, 10)).size).toBe(10);
    expect(new Set(CHART_COLOURS).size).toBe(SERIES_COLOURS);
    expect(isHatched(9)).toBe(false);
    expect(isHatched(10)).toBe(true);
    expect(fills[10]).toBe('url(#c1-hatch-10)');
    expect(new Set(fills).size).toBe(11);
    // An HTML swatch (the pie legend) is striped for a hatched series too.
    expect(swatchAt(10)).toMatch(/^repeating-linear-gradient/);
    expect(swatchAt(0)).toBe(colourAt(0));
  });

  it('the palette check: every pair of app colours is at least 25 apart (CIE76 ΔE)', () => {
    let worst = Infinity;
    for (let i = 0; i < CHART_COLOURS.length; i++) {
      for (let j = i + 1; j < CHART_COLOURS.length; j++) worst = Math.min(worst, deltaE76(CHART_COLOURS[i]!, CHART_COLOURS[j]!));
    }
    expect(worst).toBeGreaterThanOrEqual(MIN_SERIES_DELTA_E);
  });

  it.each(['#1E7A5F', '#7A1E3C', '#14213D', '#FFE066', '#1B6FA8', '#E0A100', '#525F7A', '#000000', '#FFFFFF'])(
    'a report in brand %s gets ten clearly different series colours, the brand mark first',
    (brand) => {
      const vars = documentVars({ color: brand }) as Record<string, string>;
      const series = Array.from({ length: 10 }, (_, i) => vars[`--doc-series-${i + 1}`]!);
      expect(series.every(Boolean)).toBe(true);
      expect(series[0]).toBe(vars['--brand-mark']);
      for (let i = 0; i < series.length; i++) {
        for (let j = i + 1; j < series.length; j++) expect(deltaE76(series[i]!, series[j]!)).toBeGreaterThanOrEqual(MIN_SERIES_DELTA_E);
      }
    },
  );
});

describe('A3: print chart sizes', () => {
  const mm = (px: number) => (px * 25.4) / 96;

  it('horizontal bars: about 5mm per category, at most 95mm', () => {
    expect(mm(printChartHeight(true, 3))).toBeCloseTo(31, 5);
    expect(mm(printChartHeight(true, 10))).toBeCloseTo(66, 5);
    expect(mm(printChartHeight(true, 40))).toBeCloseTo(95, 5);
  });

  it('vertical bar, line and area charts: at most 75mm; drawn at the A4 content width', () => {
    expect(mm(printChartHeight(false, 3))).toBeCloseTo(75, 5);
    expect(mm(printChartHeight(false, 31))).toBeCloseTo(75, 5);
    expect(mm(PRINT_CHART_WIDTH)).toBeCloseTo(178, 5);
  });
});
