import { parse } from 'csv-parse/sync';

export type Delimiter = ',' | ';' | '\t' | '|';
export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];

/** Reads up to `limit` records of a text sample with a given delimiter; null if it cannot be parsed. */
export function sampleRecords(sample: string, delimiter: Delimiter, limit = 50): string[][] | null {
  try {
    return parse(sample, {
      delimiter,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
      to: limit,
    }) as string[][];
  } catch {
    return null;
  }
}

/**
 * Picks the delimiter with the most consistent column count across the first 50 records.
 * Score = (records with the most common count) x (that count), counting only counts of 2 or more,
 * so ';' (9 columns) beats ',' when amounts like "1 234,56" also contain commas.
 * Returns null when no candidate splits the rows into at least two columns consistently.
 */
export function detectDelimiter(sample: string): Delimiter | null {
  let best: { delimiter: Delimiter; score: number } | null = null;
  for (const delimiter of DELIMITERS) {
    const records = sampleRecords(sample, delimiter);
    if (!records || records.length === 0) continue;
    const freq = new Map<number, number>();
    for (const r of records) freq.set(r.length, (freq.get(r.length) ?? 0) + 1);
    let modal = 0;
    let modalFreq = 0;
    for (const [len, f] of freq) {
      if (len >= 2 && (f > modalFreq || (f === modalFreq && len > modal))) {
        modal = len;
        modalFreq = f;
      }
    }
    if (modal < 2) continue;
    // A single matching line is not a pattern unless the sample is that small.
    if (modalFreq < Math.min(2, records.length)) continue;
    const score = modalFreq * modal;
    if (!best || score > best.score) best = { delimiter, score };
  }
  return best?.delimiter ?? null;
}
