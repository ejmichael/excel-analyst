const LOCALE = 'en-ZA';
const TIME_ZONE = 'Africa/Johannesburg';

const zar = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'ZAR' });
const percent = new Intl.NumberFormat(LOCALE, {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
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

/** Takes a fraction (0.123) and shows one decimal (12,3%). */
export function formatPercent(fraction: number): string {
  return percent.format(fraction);
}

/** '2026-11-02' or an ISO timestamp -> '2 November 2026', read in SAST. */
export function formatDate(value: string | Date): string {
  const date =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00+02:00`) // a bare date is a SAST calendar day
      : new Date(value);
  return longDate.format(date);
}
