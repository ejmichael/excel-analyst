export type DateOrder = 'dmy' | 'mdy' | 'ymd';

export interface ParsedDate {
  kind: 'date' | 'datetime';
  /** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS' (wall-clock time in SAST when the value had an offset). */
  iso: string;
}

/** English and Afrikaans month names and abbreviations. */
const MONTHS: Record<string, number> = {};
const NAMES: Array<[number, string[]]> = [
  [1, ['jan', 'january', 'januarie']],
  [2, ['feb', 'february', 'februarie']],
  [3, ['mar', 'march', 'maart', 'mrt']],
  [4, ['apr', 'april']],
  [5, ['may', 'mei']],
  [6, ['jun', 'june', 'junie']],
  [7, ['jul', 'july', 'julie']],
  [8, ['aug', 'august', 'augustus']],
  [9, ['sep', 'sept', 'september']],
  [10, ['oct', 'october', 'okt', 'oktober']],
  [11, ['nov', 'november']],
  [12, ['dec', 'december', 'des', 'desember']],
];
for (const [n, names] of NAMES) for (const name of names) MONTHS[name] = n;

const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?`;
const ISO_RE = new RegExp(String.raw`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]${TIME})?$`, 'i');
const NUMERIC_RE = new RegExp(String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ]${TIME})?$`, 'i');
const NAMED_RE = new RegExp(String.raw`^(\d{1,2})[ -]([A-Za-z]{3,10})\.?[ ,-]+(\d{4})(?:[T ]${TIME})?$`, 'i');

const SAST_OFFSET_MIN = 120;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isValidDate(y: number, m: number, d: number): boolean {
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function build(y: number, m: number, d: number, time: RegExpExecArray, at: number): ParsedDate | null {
  if (!isValidDate(y, m, d)) return null;
  if (time[at] === undefined) return { kind: 'date', iso: `${y}-${pad(m)}-${pad(d)}` };
  const hh = Number(time[at]);
  const mi = Number(time[at + 1]);
  const ss = time[at + 2] === undefined ? 0 : Number(time[at + 2]);
  if (hh > 23 || mi > 59 || ss > 59) return null;
  const offset = time[at + 3];
  if (offset === undefined) {
    return { kind: 'datetime', iso: `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mi)}:${pad(ss)}` };
  }
  // Convert to SAST wall-clock time (UTC+2, no DST): all date logic in the app is SAST.
  let offsetMin = 0;
  if (offset.toUpperCase() !== 'Z') {
    const digits = offset.replace(':', '');
    offsetMin = (digits.startsWith('-') ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
  }
  const utcMs = Date.UTC(y, m - 1, d, hh, mi, ss) - offsetMin * 60_000;
  const t = new Date(utcMs + SAST_OFFSET_MIN * 60_000);
  return {
    kind: 'datetime',
    iso: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`,
  };
}

/**
 * Recognises yyyy-mm-dd, dd/mm/yyyy (or mm/dd/yyyy under `order: 'mdy'`), dd-mm-yyyy, dd Mon yyyy,
 * each optionally followed by a time and offset. Returns null for anything else.
 */
export function parseDate(raw: string, order: DateOrder): ParsedDate | null {
  const s = raw.trim();
  if (s.length < 8 || s.length > 40) return null;
  let m = ISO_RE.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]), m, 4);
  m = NUMERIC_RE.exec(s);
  if (m) {
    // Under 'ymd' only year-first dates count; dd/mm/yyyy stays unrecognised.
    if (order === 'ymd') return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [day, month] = order === 'mdy' ? [b, a] : [a, b];
    return build(Number(m[3]), month, day, m, 4);
  }
  m = NAMED_RE.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) return null;
    return build(Number(m[3]), month, Number(m[1]), m, 4);
  }
  return null;
}

/** For dd/mm vs mm/dd: the two leading numeric parts of a slash/dash/dot date, or null for other shapes. */
export function numericDateParts(raw: string): [number, number] | null {
  const m = NUMERIC_RE.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
