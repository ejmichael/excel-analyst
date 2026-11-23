import type { CellValue, ChartSpec } from '../../types/api.js';

/**
 * A pie says its slices are parts of one whole. When the slices are counts of rows (value_format integer) that add up
 * to more than the file has rows, they overlap (for example rows that have a phone, an email, a website), so the pie
 * would say something false: it is shown as a horizontal bar of the same columns instead. Used by the Ask pipeline
 * and the dashboard planner.
 */
export function overlappingPieAsBar(chart: ChartSpec, rows: Array<Record<string, CellValue>>, fileRows: number): ChartSpec {
  if (chart.type !== 'pie') return chart;
  const value = chart.y[0];
  if (!value || chart.value_format[value] !== 'integer') return chart;
  let total = 0;
  for (const r of rows) total += typeof r[value] === 'number' ? (r[value] as number) : 0;
  if (total <= fileRows) return chart;
  return { ...chart, type: 'bar', orientation: 'horizontal', stacked: false };
}
