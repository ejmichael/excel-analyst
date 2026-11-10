export type DecimalSeparator = '.' | ',';

export interface ParsedNumber {
  /** Canonical decimal string: optional '-', digits, optional '.' + digits. No thousands separators. */
  value: string;
  isInteger: boolean;
  /** "0821234567"-style values: digits with a leading zero are identifiers, not numbers. */
  leadingZero: boolean;
  percent: boolean;
  currency: boolean;
  /** More than 15 integer digits: not safe as a number (account or ID numbers). */
  tooLong: boolean;
}

const THOUSANDS = [' ', ' ', ' ', "'", ',', '.'];
const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parses an amount as written in South African exports, under a given decimal separator.
 * Handles thousands separators (space, NBSP, ',', '.', "'"), currency markers (R, ZAR),
 * percentages, and negatives written as -12.50, (12.50), 12.50- and 12.50 DR. Returns null if not a number.
 */
export function parseNumber(raw: string, dec: DecimalSeparator): ParsedNumber | null {
  let s = raw.trim();
  if (s === '') return null;
  let negative = false;
  let currency = false;
  let percent = false;

  const drcr = /^(.*?)\s*(DR|CR)$/i.exec(s);
  if (drcr && /\d/.test(drcr[1]!)) {
    if (drcr[2]!.toUpperCase() === 'DR') negative = true;
    s = drcr[1]!.trim();
  }
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1).trim();
  }
  const takeSign = () => {
    if (/^[-−]/.test(s)) {
      negative = true;
      s = s.slice(1).trim();
    } else if (s.startsWith('+')) {
      s = s.slice(1).trim();
    }
  };
  takeSign();
  const cur = /^(ZAR|R)\s*/.exec(s);
  if (cur && /\d/.test(s.charAt(cur[0].length) || '')) {
    currency = true;
    s = s.slice(cur[0].length);
    takeSign();
  }
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }

  const d = escape(dec);
  let intPart: string;
  let frac = '';
  let grouped = false;
  const plain = new RegExp(`^(\\d+)(?:${d}(\\d+))?$`).exec(s);
  if (plain) {
    intPart = plain[1]!;
    frac = plain[2] ?? '';
  } else {
    let match: RegExpExecArray | null = null;
    for (const t of THOUSANDS) {
      if (t === dec) continue;
      match = new RegExp(`^(\\d{1,3}(?:${escape(t)}\\d{3})+)(?:${d}(\\d+))?$`).exec(s);
      if (match) {
        intPart = match[1]!.split(t).join('');
        frac = match[2] ?? '';
        grouped = true;
        break;
      }
    }
    if (!match) return null;
    intPart = intPart!;
  }

  const leadingZero = !grouped && intPart.length > 1 && intPart.startsWith('0');
  intPart = intPart.replace(/^0+(?=\d)/, '');
  const tooLong = intPart.length > 15;
  if (percent) [intPart, frac] = shiftLeft(intPart, frac, 2);
  const isZero = /^0*$/.test(intPart + frac);
  const value = `${negative && !isZero ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
  // "95.00" is written as a decimal, so it is not an integer.
  return { value, isInteger: frac === '', leadingZero, percent, currency, tooLong };
}

/** Divides by 10^n on the decimal string, without floating point. */
function shiftLeft(intPart: string, frac: string, n: number): [string, string] {
  const padded = intPart.padStart(n + 1, '0');
  const newInt = padded.slice(0, padded.length - n).replace(/^0+(?=\d)/, '');
  const newFrac = (padded.slice(padded.length - n) + frac).replace(/0+$/, '');
  return [newInt, newFrac];
}

/** Which decimal separator a single value votes for, or null when it reads the same (or not at all) either way. */
export function decimalVote(raw: string): DecimalSeparator | null {
  const dot = parseNumber(raw, '.');
  const comma = parseNumber(raw, ',');
  if (dot && !comma) return '.';
  if (comma && !dot) return ',';
  return null;
}
