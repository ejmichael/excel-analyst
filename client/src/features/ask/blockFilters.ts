import type { DashboardFilterValue, DatasetColumn } from '@/api/types';
import { formatDate } from '@/lib/format';

/**
 * A saved dashboard answer's filters in plain words, one line each: "Store is Durban, Sandton" or "Dates from 5 October
 * 2026 to 11 October 2026". A category filter's id is `cat:<sql_name>`; its label is the file's name for that column,
 * or the column name when the file is not known (a shared report). Values are text, shown as they are.
 */
export function describeBlockFilters(filters: DashboardFilterValue[], columns: DatasetColumn[]): string[] {
  return filters.flatMap((filter) => {
    if (filter.values && filter.values.length > 0) {
      const column = filter.filter_id.startsWith('cat:') ? filter.filter_id.slice(4) : filter.filter_id;
      const known = columns.find((c) => c.sql_name === column);
      const label = known ? (known.display_name ?? known.name) : column;
      return [`${label} is ${filter.values.join(', ')}`];
    }
    const from = filter.from ? formatDate(filter.from) : null;
    const to = filter.to ? formatDate(filter.to) : null;
    if (from && to) return [`Dates from ${from} to ${to}`];
    if (from) return [`Dates from ${from}`];
    if (to) return [`Dates up to ${to}`];
    return [];
  });
}
