import type { DashboardFilter, DashboardFilterValue } from '@/api/types';

/** A date filter's range (either end may be open). */
export interface DateRange {
  from: string | null;
  to: string | null;
}

/** The active filters, by filter id: a date range, or the selected category values. Absent = no filter. */
export type FilterState = Record<string, DateRange | string[]>;

/** The contract allows at most 50 values per category filter. */
export const MAX_VALUES = 50;

/** The URL parameter: compact JSON, for example {"date":["2026-10-01",null],"cat:province":["Limpopo"]}. */
export const FILTERS_PARAM = 'filters';

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** True when From is later than To: no request is sent until it is fixed. ISO dates compare as text. */
export const rangeIsBackwards = ({ from, to }: DateRange) => from !== null && to !== null && from > to;

/**
 * The filters in `?filters=`, kept only where they fit this dashboard: an unknown filter, a malformed date range, or a
 * value that is not one of the filter's options is ignored (never an error).
 */
export function parseFilters(raw: string | null, filters: DashboardFilter[]): FilterState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const input = parsed as Record<string, unknown>;
  const state: FilterState = {};
  for (const filter of filters) {
    const value = input[filter.id];
    if (!Array.isArray(value)) continue;
    if (filter.kind === 'date_range') {
      if (value.length !== 2) continue;
      const [from, to] = value.map((v) => (isIsoDate(v) ? v : null));
      const range = { from: from ?? null, to: to ?? null };
      // A backwards range is kept (the bar says so) but never sent: see sendable().
      if (range.from || range.to) state[filter.id] = range;
    } else {
      const options = new Set(filter.options);
      const values = [...new Set(value.filter((v): v is string => typeof v === 'string' && options.has(v)))].slice(0, MAX_VALUES);
      if (values.length > 0) state[filter.id] = values;
    }
  }
  return state;
}

/** The `?filters=` value for these filters, in the dashboard's order; null when none is active. */
export function serialiseFilters(state: FilterState, filters: DashboardFilter[]): string | null {
  const out: Record<string, unknown> = {};
  for (const filter of filters) {
    const value = state[filter.id];
    if (value === undefined) continue;
    out[filter.id] = Array.isArray(value) ? value : [value.from, value.to];
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** The request body's filters, in the dashboard's order. */
export function toRequest(state: FilterState, filters: DashboardFilter[]): DashboardFilterValue[] {
  return filters.flatMap((filter): DashboardFilterValue[] => {
    const value = state[filter.id];
    if (value === undefined) return [];
    return Array.isArray(value)
      ? [{ filter_id: filter.id, values: value }]
      : [{ filter_id: filter.id, from: value.from, to: value.to }];
  });
}

/** True when any date range has From later than To. */
export const hasBackwardsRange = (state: FilterState) => Object.values(state).some((v) => !Array.isArray(v) && rangeIsBackwards(v));

/** The filters that can be sent: a backwards date range is left out (the server would refuse it). */
export function sendable(state: FilterState): FilterState {
  return Object.fromEntries(Object.entries(state).filter(([, v]) => Array.isArray(v) || !rangeIsBackwards(v)));
}

/** Sets or clears one filter (an empty range or selection clears it). */
export function withFilter(state: FilterState, id: string, value: DateRange | string[] | null): FilterState {
  const next = { ...state };
  const empty = value === null || (Array.isArray(value) ? value.length === 0 : !value.from && !value.to);
  if (empty) delete next[id];
  else next[id] = value;
  return next;
}
