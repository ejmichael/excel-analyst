import type { Block, CellValue, ChartType, ValueFormat } from '@/api/types';
import { formatKey, toNumeric } from '@/lib/format';

/**
 * Turns a Block into what a chart needs, using only Block.rows, Block.columns and Block.chart.
 * Pure: it rearranges the values the API returned (pivoting rows into series) and never calculates one.
 * A missing x/series combination is a gap (null), never zero.
 */

/** The API sends at most 500 rows; the chart never draws more. */
export const MAX_CHART_ROWS = 500;

export interface SeriesDef {
  /** Key in each data point. */
  key: string;
  label: string;
  /** The result column the values come from. */
  column: string;
  format: ValueFormat;
}

export type ChartModel =
  | { kind: 'empty' }
  | { kind: 'table' }
  | { kind: 'kpi'; label: string; column: string; value: CellValue; format: ValueFormat }
  | {
      kind: 'pie';
      labelColumn: string;
      valueColumn: string;
      labelFormat: ValueFormat;
      format: ValueFormat;
      slices: Array<{ name: string; label: string; value: number | null }>;
    }
  | {
      kind: 'cartesian';
      type: Extract<ChartType, 'bar' | 'line' | 'area'>;
      orientation: 'vertical' | 'horizontal';
      stacked: boolean;
      xColumn: string;
      xFormat: ValueFormat;
      series: SeriesDef[];
      /**
       * One point per x value, in the order the API returned them. `x` is the raw value; `xLabel` its display text
       * for the axis and tooltip (a null key reads "(blank)").
       */
      data: Array<{ x: CellValue; xLabel: string } & Record<string, number | null | CellValue>>;
    };

/** 'total_net' -> 'Total net'. Text only. */
export function columnLabel(name: string): string {
  const spaced = name.replace(/_+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name;
}

/** The display format of a result column: chart.value_format first, then the column's own format, else text. */
export function formatOf(block: Pick<Block, 'chart' | 'columns'>, column: string): ValueFormat {
  return block.chart.value_format[column] ?? block.columns.find((c) => c.name === column)?.format ?? 'text';
}

/** Identity of a group key for grouping and series keys. Null and empty share one identity, distinct from any text. */
const key = (value: CellValue): string => (value === null || value === '' ? '__blank__' : `v:${String(value)}`);

/**
 * The result columns that are group keys (shown as "(blank)" when null): the chart's x and series, and every
 * column that is not a value column. In a plain table with no value columns, the text and date columns.
 */
export function groupKeyColumns(block: Pick<Block, 'chart' | 'columns'>): Set<string> {
  const keys = new Set<string>();
  const { x, y, series } = block.chart;
  if (x) keys.add(x);
  if (series) keys.add(series);
  for (const c of block.columns) {
    const format = formatOf(block, c.name);
    if (y.length > 0 ? !y.includes(c.name) : format === 'text' || format === 'date') keys.add(c.name);
  }
  return keys;
}

export function buildChartModel(block: Pick<Block, 'chart' | 'columns' | 'rows'>): ChartModel {
  const rows = block.rows.slice(0, MAX_CHART_ROWS);
  const { chart } = block;
  if (rows.length === 0 || block.columns.length === 0) return { kind: 'empty' };

  const known = new Set(block.columns.map((c) => c.name));
  const y = chart.y.filter((c) => known.has(c));
  const x = chart.x && known.has(chart.x) ? chart.x : null;
  const seriesColumn = chart.series && known.has(chart.series) ? chart.series : null;

  if (chart.type === 'table') return { kind: 'table' };

  if (chart.type === 'kpi') {
    const column = y[0] ?? block.columns.find((c) => c.format !== 'text')?.name ?? block.columns[0]?.name;
    const first = rows[0];
    if (!column || !first) return { kind: 'table' };
    return { kind: 'kpi', label: columnLabel(column), column, value: first[column] ?? null, format: formatOf(block, column) };
  }

  // Charts below need an axis and at least one value column; otherwise the table says it best.
  const valueColumn = y[0];
  if (!x || !valueColumn) return { kind: 'table' };

  const xFormat = formatOf(block, x);

  if (chart.type === 'pie') {
    return {
      kind: 'pie',
      labelColumn: x,
      valueColumn,
      labelFormat: xFormat,
      format: formatOf(block, valueColumn),
      slices: rows.map((row, i) => ({
        name: `p${i}`,
        label: formatKey(row[x] ?? null, xFormat),
        value: toNumeric(row[valueColumn]),
      })),
    };
  }

  const xs: CellValue[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const k = key(row[x] ?? null);
    if (!seen.has(k)) {
      seen.add(k);
      xs.push(row[x] ?? null);
    }
  }

  let series: SeriesDef[];
  let point: (row: Record<string, CellValue>) => Array<[string, number | null]>;

  // Series keys are plain indexes: data values can contain dots, which Recharts would read as a nested path.
  if (seriesColumn) {
    const seriesFormat = formatOf(block, seriesColumn);
    const seriesIndex = new Map<string, number>();
    const seriesLabels: string[] = [];
    for (const row of rows) {
      const s = key(row[seriesColumn] ?? null);
      if (!seriesIndex.has(s)) {
        seriesIndex.set(s, seriesLabels.length);
        seriesLabels.push(formatKey(row[seriesColumn] ?? null, seriesFormat));
      }
    }
    series = y.flatMap((column, ci) =>
      seriesLabels.map((label, si) => ({
        key: `s${ci}_${si}`,
        label: y.length > 1 ? `${label} · ${columnLabel(column)}` : label,
        column,
        format: formatOf(block, column),
      })),
    );
    point = (row) =>
      y.map((column, ci) => [`s${ci}_${seriesIndex.get(key(row[seriesColumn] ?? null))}`, toNumeric(row[column])]);
  } else {
    series = y.map((column, ci) => ({ key: `v${ci}`, label: columnLabel(column), column, format: formatOf(block, column) }));
    point = (row) => y.map((column, ci) => [`v${ci}`, toNumeric(row[column])]);
  }

  const byX = new Map<string, { x: CellValue; xLabel: string } & Record<string, number | null | CellValue>>();
  for (const value of xs) {
    // Every series starts as a gap; only values the API returned fill it.
    byX.set(key(value), { x: value, xLabel: formatKey(value, xFormat), ...Object.fromEntries(series.map((s) => [s.key, null])) });
  }
  for (const row of rows) {
    const target = byX.get(key(row[x] ?? null));
    if (!target) continue;
    for (const [k, v] of point(row)) target[k] = v;
  }

  return {
    kind: 'cartesian',
    type: chart.type,
    orientation: chart.orientation,
    stacked: chart.stacked,
    xColumn: x,
    xFormat,
    series,
    data: xs.map((value) => byX.get(key(value))!),
  };
}

/** Long category labels are cut for the axis; the full text stays in the tooltip, title and table view. */
export function shortLabel(text: string, max = 18): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
