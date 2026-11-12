import { describe, expect, it } from 'vitest';
import type { Block, ChartSpec, ResultColumn } from '@/api/types';
import { buildChartModel, columnLabel, formatOf, groupKeyColumns, shortLabel } from './chartData';

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
    expect(model.series).toEqual([{ key: 'v0', label: 'Net', column: 'net', format: 'zar' }]);
    expect(model.data).toEqual([
      { x: 'A', xLabel: 'A', v0: 100 },
      { x: 'B', xLabel: 'B', v0: 250.5 },
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
      expect(model.data).toEqual([{ x: '2026-10-01', xLabel: '1 October 2026', v0: 10, v1: 9 }]);
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
      ['s0_0', 'DEBIT'],
      ['s0_1', 'CREDIT'],
    ]);
    expect(model.data).toEqual([
      { x: 'A', xLabel: 'A', s0_0: 5, s0_1: 3 },
      { x: 'B', xLabel: 'B', s0_0: 7, s0_1: null },
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
    expect(model.data[1]?.v0).toBeNull();
  });

  it('reads numeric text as a number but never invents one', () => {
    const rows = [
      { store: 'A', net: '12.50' },
      { store: 'B', net: 'n/a' },
    ];
    const model = buildChartModel(block(spec({ type: 'bar', x: 'store', y: ['net'] }), storeColumns, rows));
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.data.map((d) => d.v0)).toEqual([12.5, null]);
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
        { name: 'p0', label: 'DEBIT', value: 0.6 },
        { name: 'p1', label: 'CREDIT', value: 0.4 },
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
    expect(model.kind === 'cartesian' && model.data).toEqual([{ x: 'A', xLabel: 'A', v0: 1 }]);
  });

  it('an empty result is "empty", never an empty chart', () => {
    expect(buildChartModel(block(spec({ type: 'bar', x: 'store', y: ['net'] }), storeColumns, []))).toEqual({ kind: 'empty' });
  });

  it('falls back to a table when the chart spec names columns that are not in the result', () => {
    expect(buildChartModel(block(spec({ type: 'bar', x: 'missing', y: ['net'] }), storeColumns, storeRows))).toEqual({ kind: 'table' });
  });
});

describe('a null group key reads "(blank)"', () => {
  // The API sends JSON null for a missing key (the CSV export has an empty cell instead).
  const cases = [
    { name: 'text', column: { name: 'store', format: 'text' as const }, value: 'Café Rosé', label: 'Café Rosé' },
    { name: 'numeric', column: { name: 'terminal_no', format: 'integer' as const }, value: 1002, label: new Intl.NumberFormat('en-ZA').format(1002) },
    { name: 'date', column: { name: 'day', format: 'date' as const }, value: '2026-10-01', label: '1 October 2026' },
  ];

  for (const { name, column, value, label } of cases) {
    const columns: ResultColumn[] = [column, { name: 'net', format: 'zar' }];
    const rows = [
      { [column.name]: value, net: 10 },
      { [column.name]: null, net: 4 },
    ];
    const formats = { [column.name]: column.format, net: 'zar' as const };

    it(`${name} key on the axis (and so in the tooltip): formatted, or "(blank)"`, () => {
      const model = buildChartModel(block(spec({ type: 'bar', x: column.name, y: ['net'], value_format: formats }), columns, rows));
      if (model.kind !== 'cartesian') throw new Error();
      expect(model.data.map((d) => d.xLabel)).toEqual([label, '(blank)']);
      expect(model.data[1]).toMatchObject({ x: null, v0: 4 });
    });

    it(`${name} key as a series (the legend): formatted, or "(blank)"`, () => {
      const seriesColumns: ResultColumn[] = [{ name: 'store_group', format: 'text' }, ...columns];
      const seriesRows = rows.map((r) => ({ store_group: 'All', ...r }));
      const model = buildChartModel(
        block(spec({ type: 'bar', x: 'store_group', y: ['net'], series: column.name, value_format: formats }), seriesColumns, seriesRows),
      );
      if (model.kind !== 'cartesian') throw new Error();
      expect(model.series.map((s) => s.label)).toEqual([label, '(blank)']);
      expect(model.data).toEqual([{ x: 'All', xLabel: 'All', s0_0: 10, s0_1: 4 }]);
    });

    it(`${name} key on a pie slice: formatted, or "(blank)"`, () => {
      const model = buildChartModel(block(spec({ type: 'pie', x: column.name, y: ['net'], value_format: formats }), columns, rows));
      if (model.kind !== 'pie') throw new Error();
      expect(model.slices.map((s) => s.label)).toEqual([label, '(blank)']);
    });
  }

  it('an empty string key also reads "(blank)", and is the same group as null', () => {
    const columns: ResultColumn[] = [{ name: 'store', format: 'text' }, { name: 'net', format: 'zar' }];
    const model = buildChartModel(
      block(spec({ type: 'bar', x: 'store', y: ['net'] }), columns, [{ store: '', net: 1 }, { store: 'A', net: 2 }]),
    );
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.data.map((d) => d.xLabel)).toEqual(['(blank)', 'A']);
  });

  it('a real text value "(blank)" stays a different group from a missing key', () => {
    const columns: ResultColumn[] = [{ name: 'store', format: 'text' }, { name: 'net', format: 'zar' }];
    const model = buildChartModel(
      block(spec({ type: 'bar', x: 'store', y: ['net'] }), columns, [{ store: '(blank)', net: 1 }, { store: null, net: 2 }]),
    );
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.data.map((d) => d.v0)).toEqual([1, 2]);
  });

  it('series values with dots still get safe keys', () => {
    const columns: ResultColumn[] = [{ name: 'x', format: 'text' }, { name: 'version', format: 'text' }, { name: 'n', format: 'integer' }];
    const model = buildChartModel(block(spec({ type: 'line', x: 'x', y: ['n'], series: 'version' }), columns, [{ x: 'a', version: 'v1.2', n: 3 }]));
    if (model.kind !== 'cartesian') throw new Error();
    expect(model.series[0]).toMatchObject({ key: 's0_0', label: 'v1.2' });
    expect(model.series.every((s) => !s.key.includes('.'))).toBe(true);
  });
});

describe('groupKeyColumns', () => {
  it('is x, series and every non-value column; in a plain table, the text and date columns', () => {
    const columns: ResultColumn[] = [
      { name: 'store', format: 'text' },
      { name: 'terminal_no', format: 'integer' },
      { name: 'day', format: 'date' },
      { name: 'net', format: 'zar' },
    ];
    expect([...groupKeyColumns({ chart: spec({ type: 'bar', x: 'terminal_no', y: ['net'] }), columns })].sort()).toEqual(['day', 'store', 'terminal_no']);
    expect([...groupKeyColumns({ chart: spec({ type: 'table' }), columns })].sort()).toEqual(['day', 'store']);
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
