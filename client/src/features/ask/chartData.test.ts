import { describe, expect, it } from 'vitest';
import type { Block, ChartSpec, ResultColumn } from '@/api/types';
import { buildChartModel, columnLabel, formatOf, shortLabel } from './chartData';

const spec = (over: Partial<ChartSpec> & Pick<ChartSpec, 'type'>): ChartSpec => ({
  x: null,
  y: [],
  series: null,
  orientation: 'vertical',
  stacked: false,
  value_format: {},
  ...over,
});

const block = (chart: ChartSpec, columns: ResultColumn[], rows: Block['rows']) => ({ chart, columns, rows });

describe('buildChartModel', () => {
  const storeColumns: ResultColumn[] = [
    { name: 'store', format: 'text' },
    { name: 'net', format: 'zar' },
  ];
  const storeRows = [
    { store: 'A', net: 100 },
    { store: 'B', net: 250.5 },
  ];

  it('bar: one point per x value in API order, values as given', () => {
    const model = buildChartModel(block(spec({ type: 'bar', x: 'store', y: ['net'], value_format: { net: 'zar' } }), storeColumns, storeRows));
    expect(model).toMatchObject({ kind: 'cartesian', type: 'bar', orientation: 'vertical', stacked: false, xColumn: 'store' });
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.series).toEqual([{ key: 'y::net', label: 'Net', column: 'net', format: 'zar' }]);
    expect(model.data).toEqual([
      { x: 'A', 'y::net': 100 },
      { x: 'B', 'y::net': 250.5 },
    ]);
  });

  it('honours horizontal orientation and stacking', () => {
    const model = buildChartModel(
      block(spec({ type: 'bar', x: 'store', y: ['net'], orientation: 'horizontal', stacked: true }), storeColumns, storeRows),
    );
    expect(model).toMatchObject({ kind: 'cartesian', orientation: 'horizontal', stacked: true });
  });

  it('line and area with several value columns become several series', () => {
    const columns: ResultColumn[] = [
      { name: 'day', format: 'date' },
      { name: 'gross', format: 'zar' },
      { name: 'net', format: 'zar' },
    ];
    const rows = [{ day: '2026-10-01', gross: 10, net: 9 }];
    for (const type of ['line', 'area'] as const) {
      const model = buildChartModel(block(spec({ type, x: 'day', y: ['gross', 'net'] }), columns, rows));
      if (model.kind !== 'cartesian') throw new Error(type);
      expect(model.type).toBe(type);
      expect(model.series.map((s) => s.label)).toEqual(['Gross', 'Net']);
      expect(model.xFormat).toBe('date');
      expect(model.data).toEqual([{ x: '2026-10-01', 'y::gross': 10, 'y::net': 9 }]);
    }
  });

  it('pivots by series, and a missing combination is a gap (null), not zero', () => {
    const columns: ResultColumn[] = [
      { name: 'store', format: 'text' },
      { name: 'card', format: 'text' },
      { name: 'net', format: 'zar' },
    ];
    const rows = [
      { store: 'A', card: 'DEBIT', net: 5 },
      { store: 'A', card: 'CREDIT', net: 3 },
      { store: 'B', card: 'DEBIT', net: 7 },
    ];
    const model = buildChartModel(block(spec({ type: 'bar', x: 'store', y: ['net'], series: 'card', stacked: true }), columns, rows));
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.series.map((s) => [s.key, s.label])).toEqual([
      ['s::DEBIT', 'DEBIT'],
      ['s::CREDIT', 'CREDIT'],
    ]);
    expect(model.data).toEqual([
      { x: 'A', 's::DEBIT': 5, 's::CREDIT': 3 },
      { x: 'B', 's::DEBIT': 7, 's::CREDIT': null },
    ]);
  });

  it('keeps a date axis in the order the API sent, with null values as gaps', () => {
    const columns: ResultColumn[] = [
      { name: 'day', format: 'date' },
      { name: 'net', format: 'zar' },
    ];
    const rows = [
      { day: '2026-10-02', net: 4 },
      { day: '2026-10-01', net: null },
    ];
    const model = buildChartModel(block(spec({ type: 'line', x: 'day', y: ['net'] }), columns, rows));
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.data.map((d) => d.x)).toEqual(['2026-10-02', '2026-10-01']);
    expect(model.data[1]?.['y::net']).toBeNull();
  });

  it('reads numeric text as a number but never invents one', () => {
    const rows = [
      { store: 'A', net: '12.50' },
      { store: 'B', net: 'n/a' },
    ];
    const model = buildChartModel(block(spec({ type: 'bar', x: 'store', y: ['net'] }), storeColumns, rows));
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.data.map((d) => d['y::net'])).toEqual([12.5, null]);
  });

  it('pie: slices with labels and values', () => {
    const columns: ResultColumn[] = [
      { name: 'card', format: 'text' },
      { name: 'share', format: 'percent' },
    ];
    const model = buildChartModel(
      block(spec({ type: 'pie', x: 'card', y: ['share'], value_format: { share: 'percent' } }), columns, [
        { card: 'DEBIT', share: 0.6 },
        { card: 'CREDIT', share: 0.4 },
      ]),
    );
    expect(model).toEqual({
      kind: 'pie',
      labelColumn: 'card',
      valueColumn: 'share',
      labelFormat: 'text',
      format: 'percent',
      slices: [
        { name: 'DEBIT', label: 'DEBIT', value: 0.6 },
        { name: 'CREDIT', label: 'CREDIT', value: 0.4 },
      ],
    });
  });

  it('kpi: the first row of the first value column, with its label', () => {
    const model = buildChartModel(block(spec({ type: 'kpi', y: ['total_fees'], value_format: { total_fees: 'zar' } }), [{ name: 'total_fees', format: 'zar' }], [{ total_fees: 8040.79 }]));
    expect(model).toEqual({ kind: 'kpi', label: 'Total fees', column: 'total_fees', value: 8040.79, format: 'zar' });
  });

  it('table stays a table', () => {
    expect(buildChartModel(block(spec({ type: 'table' }), storeColumns, storeRows))).toEqual({ kind: 'table' });
  });

  it('a single row still charts', () => {
    const model = buildChartModel(block(spec({ type: 'bar', x: 'store', y: ['net'] }), storeColumns, [{ store: 'A', net: 1 }]));
    expect(model.kind === 'cartesian' && model.data).toEqual([{ x: 'A', 'y::net': 1 }]);
  });

  it('an empty result is "empty", never an empty chart', () => {
    expect(buildChartModel(block(spec({ type: 'bar', x: 'store', y: ['net'] }), storeColumns, []))).toEqual({ kind: 'empty' });
  });

  it('falls back to a table when the chart spec names columns that are not in the result', () => {
    expect(buildChartModel(block(spec({ type: 'bar', x: 'missing', y: ['net'] }), storeColumns, storeRows))).toEqual({ kind: 'table' });
  });
});

describe('helpers', () => {
  it('columnLabel turns result names into words', () => {
    expect(columnLabel('net_sales_total')).toBe('Net sales total');
  });

  it('formatOf prefers chart.value_format, then the column format', () => {
    const b = { chart: spec({ type: 'table', value_format: { a: 'zar' } }), columns: [{ name: 'a', format: 'number' as const }, { name: 'b', format: 'date' as const }] };
    expect(formatOf(b, 'a')).toBe('zar');
    expect(formatOf(b, 'b')).toBe('date');
    expect(formatOf(b, 'zzz')).toBe('text');
  });

  it('shortLabel cuts long labels with an ellipsis', () => {
    expect(shortLabel('Pietermaritzburg Padstal', 10)).toBe('Pietermar…');
    expect(shortLabel('Short', 10)).toBe('Short');
  });
});
