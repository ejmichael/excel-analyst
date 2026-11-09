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

/** A cell from a result or preview: numbers keep every decimal the API sent, with en-ZA grouping. */
export function formatCell(value: string | number | boolean | null, type?: string): string {
  if (value === null) return '';
  if (typeof value === 'number') return formatNumber(value, 10);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  if (type === 'datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return `${formatDate(value.slice(0, 10))}, ${value.slice(11, 16)}`;
  }
  return value;
}

/** '2026-11-02' or an ISO timestamp -> '2 November 2026', read in SAST. */
export function formatDate(value: string | Date): string {
  const date =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00+02:00`) // a bare date is a SAST calendar day
      : new Date(value);
  return longDate.format(date);
}
