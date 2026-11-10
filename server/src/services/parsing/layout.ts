import { parseDate } from './dates.js';
import { parseNumber } from './numbers.js';
import type { Row } from './sources.js';

export const isBlank = (cells: string[]) => cells.every((c) => c.trim() === '');

/** Number of cells up to the last non-empty one. */
export function width(cells: string[]): number {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.trim() !== '') return i + 1;
  return 0;
}

const isTextCell = (c: string) => {
  const s = c.trim();
  return s !== '' && !parseNumber(s, '.') && !parseNumber(s, ',') && !parseDate(s, 'dmy');
};

/** A header candidate: mostly filled, mostly non-numeric text, mostly distinct. */
function looksLikeHeader(cells: string[], w: number): boolean {
  const filled = cells.slice(0, w).map((c) => c.trim()).filter((c) => c !== '');
  if (filled.length < Math.ceil(w * 0.5)) return false;
  const text = filled.filter(isTextCell).length;
  if (text < filled.length * 0.75) return false;
  // Merged header cells repeat their value across columns, so allow some repeats.
  return new Set(filled.map((c) => c.toLowerCase())).size >= filled.length * 0.6;
}

/**
 * The header row (ARCHITECTURE 6): the first row followed by at least 5 rows that fit under it
 * (no wider, not empty), containing mostly distinct non-numeric text. Fewer than 5 following rows
 * are accepted only when the file has no more. Returns null when nothing qualifies.
 */
export function findHeaderRow(head: Row[]): Row | null {
  const maxWidth = Math.max(0, ...head.map((r) => width(r.cells)));
  const nonBlank = head.filter((r) => !isBlank(r.cells));
  for (let i = 0; i < nonBlank.length; i++) {
    const row = nonBlank[i]!;
    const w = width(row.cells);
    if (w < 2 && maxWidth >= 2) continue;
    if (!looksLikeHeader(row.cells, w)) continue;
    const following = nonBlank.slice(i + 1, i + 6);
    if (following.length === 0) continue;
    if (following.length < 5 && i + 1 + following.length < nonBlank.length) continue;
    if (following.every((r) => width(r.cells) <= w)) return row;
  }
  return null;
}

const TOTAL_RE = /^(grand[\s-]*total|sub[\s-]*total|totals?)\s*:?$/i;

/** A footer/total row: its first non-empty cell is Total, Totals, Grand total or Sub total. */
export function isTotalRow(cells: string[]): boolean {
  const first = cells.find((c) => c.trim() !== '');
  return first !== undefined && TOTAL_RE.test(first.trim());
}
