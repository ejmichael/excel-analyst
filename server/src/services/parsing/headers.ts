import { RESERVED_WORDS } from './reservedWords.js';

const MAX_SQL_NAME = 60;

/** One header to a safe identifier: lower snake_case ASCII, no leading digit, never a reserved word. */
export function toSqlName(header: string, position: number): string {
  let s = header
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents: "Müller" -> "Muller"
    .toLowerCase()
    .replace(/%/g, ' pct ')
    .replace(/#/g, ' no ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SQL_NAME)
    .replace(/_+$/, '');
  if (s === '') s = `column_${position}`;
  if (/^\d/.test(s)) s = `col_${s}`;
  if (RESERVED_WORDS.has(s)) s = `${s}_col`;
  return s;
}

/** sql_names for a whole header row, made unique with _2, _3, ... */
export function toSqlNames(headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((h, i) => {
    const base = toSqlName(h, i + 1);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return name;
  });
}

/**
 * Display names for a header row: empty headers become "Column_7" (1-based position) and duplicates
 * "Amount_2". Returns the names and whether anything was renamed (which becomes a warning).
 */
export function cleanHeaders(raw: string[]): { names: string[]; renamed: number } {
  const seen = new Map<string, number>();
  let renamed = 0;
  const names = raw.map((h, i) => {
    let name = h.replace(/\s+/g, ' ').trim();
    if (name === '') {
      name = `Column_${i + 1}`;
      renamed++;
    }
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) {
      renamed++;
      name = `${name}_${count}`;
      seen.set(name.toLowerCase(), 1);
    }
    return name;
  });
  return { names, renamed };
}
