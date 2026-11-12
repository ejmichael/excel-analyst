const LOCALE = 'en-ZA';
const TIME_ZONE = 'Africa/Johannesburg';

const zar = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'ZAR' });
const longDate = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: TIME_ZONE,
});

/** Rand amount, e.g. R 1 234,50 (the exact space characters depend on the runtime's ICU data). */
export function formatZar(value: number): string {
  return zar.format(value);
}

/** en-ZA grouping and decimal comma. Up to 2 decimals unless told otherwise. */
export function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits }).format(value);
}

/** Takes a fraction (0.123) and shows one decimal (12,3%), or `digits` decimals. */
export function formatPercent(fraction: number, digits = 1): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction);
}

/** File sizes: 0,8 kB, 21,3 kB, 4,2 MB. */
export function formatBytes(bytes: number): string {
  const [unit, value] =
    bytes >= 1024 * 1024 ? (['megabyte', bytes / (1024 * 1024)] as const) : (['kilobyte', bytes / 1024] as const);
  return new Intl.NumberFormat(LOCALE, { style: 'unit', unit, maximumFractionDigits: 1 }).format(value);
}

/**
 * A cell from a result or preview: numbers keep every decimal the API sent, with en-ZA grouping. Money
 * (`money: true`) always shows 2 decimals, so R66.70 reads 66,70 and not 66,7.
 */
export function formatCell(value: string | number | boolean | null, type?: string, { money = false } = {}): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    return money
      ? new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 10 }).format(value)
      : formatNumber(value, 10);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  if (type === 'datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return `${formatDate(value.slice(0, 10))}, ${value.slice(11, 16)}`;
  }
  return value;
}

/**
 * A result value as a number, or null. DuckDB decimals can arrive as text, so plain numeric strings count too.
 * This only reads the value the API sent; it never calculates one.
 */
export function toNumeric(value: string | number | boolean | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const numberFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const percentDigits = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * A value from an answer, by its `ValueFormat`, exactly as the server writes it in the narrative:
 * zar `R 1 234,56`; integer and number with en-ZA grouping (number up to 2 decimals); percent from a fraction
 * with one decimal; date `2 November 2026`; text as is. Null and empty become ''.
 *
 * The `* 100` for percent is the only arithmetic on answer values anywhere in the client: display scaling of
 * a fraction the API returned. (A test checks the answer components contain none.)
 */
export function formatValue(
  value: string | number | boolean | null | undefined,
  format: 'zar' | 'number' | 'integer' | 'percent' | 'date' | 'text',
): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (format === 'date') {
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? formatDate(text.slice(0, 10)) : text;
  }
  if (format === 'text') return String(value);
  const n = toNumeric(value);
  if (n === null) return String(value);
  switch (format) {
    case 'zar':
      return zar.format(n);
    case 'integer':
      return integerFormat.format(n);
    case 'number':
      return numberFormat.format(n);
    case 'percent':
      return `${percentDigits.format(n * 100)}%`;
  }
}

/** How a missing group key reads. The API sends JSON null (the CSV export has an empty cell). */
export const BLANK_KEY = '(blank)';

/**
 * A group key (a category, date or number that rows are grouped by) for tables, axes, legends and tooltips:
 * formatted like any value, but null or empty reads "(blank)" so the group is still visible and named.
 * Values (the measures) keep using formatValue, where null stays empty.
 */
export function formatKey(
  value: string | number | boolean | null | undefined,
  format: 'zar' | 'number' | 'integer' | 'percent' | 'date' | 'text',
): string {
  return formatValue(value, format) || BLANK_KEY;
}

/** An ISO timestamp as '2 November 2026, 14:05' in SAST. */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  const time = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIME_ZONE }).format(date);
  return `${longDate.format(date)}, ${time}`;
}

/** Today's calendar date in SAST as YYYY-MM-DD (for file names). */
export function isoDateInSast(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE }).format(date);
}

/** '2026-11-02' or an ISO timestamp -> '2 November 2026', read in SAST. */
export function formatDate(value: string | Date): string {
  const date =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00+02:00`) // a bare date is a SAST calendar day
      : new Date(value);
  return longDate.format(date);
}
