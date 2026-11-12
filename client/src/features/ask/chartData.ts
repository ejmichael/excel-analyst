import type { Block, CellValue, ChartType, ValueFormat } from '@/api/types';
import { toNumeric } from '@/lib/format';

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
      /** One point per x value, in the order the API returned them. `x` holds the raw x value. */
      data: Array<{ x: CellValue } & Record<string, number | null | CellValue>>;
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

const key = (value: CellValue): string => (value === null ? '(blank)' : String(value));

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

  if (chart.type === 'pie') {
    return {
      kind: 'pie',
      labelColumn: x,
      valueColumn,
      labelFormat: formatOf(block, x),
      format: formatOf(block, valueColumn),
      slices: rows.map((row) => ({
        name: key(row[x] ?? null),
        label: key(row[x] ?? null),
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

  if (seriesColumn) {
    const seriesValues: string[] = [];
    for (const row of rows) {
      const s = key(row[seriesColumn] ?? null);
      if (!seriesValues.includes(s)) seriesValues.push(s);
    }
    series = y.flatMap((column) =>
      seriesValues.map((s) => ({
        key: y.length > 1 ? `${column}::${s}` : `s::${s}`,
        label: y.length > 1 ? `${s} · ${columnLabel(column)}` : s,
        column,
        format: formatOf(block, column),
      })),
    );
    point = (row) =>
      y.map((column) => [
        y.length > 1 ? `${column}::${key(row[seriesColumn] ?? null)}` : `s::${key(row[seriesColumn] ?? null)}`,
        toNumeric(row[column]),
      ]);
  } else {
    series = y.map((column) => ({ key: `y::${column}`, label: columnLabel(column), column, format: formatOf(block, column) }));
    point = (row) => y.map((column) => [`y::${column}`, toNumeric(row[column])]);
  }

  const byX = new Map<string, { x: CellValue } & Record<string, number | null | CellValue>>();
  for (const value of xs) {
    // Every series starts as a gap; only values the API returned fill it.
    byX.set(key(value), { x: value, ...Object.fromEntries(series.map((s) => [s.key, null])) });
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
    xFormat: formatOf(block, x),
    series,
    data: xs.map((value) => byX.get(key(value))!),
  };
}

/** Long category labels are cut for the axis; the full text stays in the tooltip, title and table view. */
export function shortLabel(text: string, max = 18): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
