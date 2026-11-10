import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { profileFile, type ProfileResult } from '../../src/services/parsing/pipeline.js';
import { buildSuggestionsPrompt } from '../../src/services/suggestions.js';

/**
 * Every fixture must parse with auto-detection alone and reproduce fixtures/expected.json.
 * Expected values are read from that file, never copied into the tests.
 */

const FIXTURES = new URL('../../../fixtures/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')).files as Record<string, Expected>;

interface Expected {
  encoding: string;
  delimiter: string;
  decimal_separator: string;
  date_order: string;
  header_line_1based: number;
  data_rows: number;
  excluded_rows: number;
  columns: number;
  column_names: string[];
  pii_columns: string[];
  date_range?: [string, string];
  sums: Record<string, number>;
}

const file = (name: string) => readFileSync(new URL(name, FIXTURES));
const profile = (name: string, options = {}) => profileFile({ buffer: file(name), fileType: 'csv', options, maxRows: 200_000 });

type NormalisedRow = Record<string, string>;
const rowsOf = (r: ProfileResult) => parse(r.normalisedCsv, { columns: true }) as NormalisedRow[];
const sum = (rows: NormalisedRow[], col: string, where: (r: NormalisedRow) => boolean = () => true) =>
  Math.round(rows.filter(where).reduce((s, r) => s + Math.round(Number(r[col] || 0) * 100), 0)) / 100;

/** How each expected sum is computed from the normalised rows. Logic only; the numbers live in expected.json. */
const SUMS: Record<string, Record<string, (rows: NormalisedRow[]) => number>> = {
  '01_card_sales_semicolon_win1252.csv': {
    gross_amount: (r) => sum(r, 'gross_amount'),
    fee: (r) => sum(r, 'fee'),
    net_amount: (r) => sum(r, 'net_amount'),
  },
  '02_webstore_orders_utf8bom.csv': {
    total_all_statuses: (r) => sum(r, 'total'),
    total_paid_only: (r) => sum(r, 'total', (x) => x.payment_status === 'paid'),
    discount: (r) => sum(r, 'discount'),
  },
  '03_bank_statement_comma_quoted.csv': {
    amount_net: (r) => sum(r, 'amount'),
    credits: (r) => sum(r, 'amount', (x) => Number(x.amount) > 0),
    debits: (r) => sum(r, 'amount', (x) => Number(x.amount) < 0),
  },
  '04_ambiguous_dates.csv': {
    amount: (r) => sum(r, 'amount'),
  },
};

const DATE_ORDER: Record<string, string> = { dmy: 'dmy', mdy: 'mdy', iso: 'ymd' };

describe.each(Object.keys(expected))('fixture %s (no manual options)', (name) => {
  const exp = expected[name]!;
  let result: ProfileResult;

  it('parses', async () => {
    result = await profile(name);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it('detects encoding, delimiter, decimal separator, date order and header row', () => {
    expect(exp.encoding.startsWith(result.encoding!)).toBe(true);
    expect(result.parseOptions.delimiter).toBe(exp.delimiter);
    expect(result.parseOptions.decimal_separator).toBe(exp.decimal_separator);
    expect(result.parseOptions.date_format).toBe(DATE_ORDER[exp.date_order]);
    expect(result.parseOptions.header_row).toBe(exp.header_line_1based);
  });

  it('counts data rows and excluded rows', () => {
    expect(result.rowCount).toBe(exp.data_rows);
    expect(result.excludedRows).toBe(exp.excluded_rows);
    expect(rowsOf(result)).toHaveLength(exp.data_rows);
  });

  it('keeps the column names and flags exactly the PII columns', () => {
    expect(result.columns).toHaveLength(exp.columns);
    expect(result.columns.map((c) => c.name)).toEqual(exp.column_names);
    expect(result.columns.filter((c) => c.is_pii).map((c) => c.name)).toEqual(exp.pii_columns);
  });

  it('finds the date range', () => {
    if (!exp.date_range) return;
    const dateCol = result.columns.find((c) => c.data_type === 'date' || c.data_type === 'datetime')!;
    expect([dateCol.min_value!.slice(0, 10), dateCol.max_value!.slice(0, 10)]).toEqual(exp.date_range);
  });

  it('reproduces the money sums from the normalised CSV', () => {
    const rows = rowsOf(result);
    for (const [key, value] of Object.entries(exp.sums)) {
      const compute = SUMS[name]![key];
      expect(compute, `no rule for ${key}`).toBeDefined();
      expect(compute!(rows), key).toBeCloseTo(value, 2);
    }
  });

  it('writes the normalised CSV with sql_name headers, ISO dates and dot decimals', () => {
    const [headerLine] = result.normalisedCsv.toString('utf8').split('\n');
    expect(headerLine).toBe(result.columns.map((c) => c.sql_name).join(','));
    const rows = rowsOf(result);
    for (const c of result.columns) {
      for (const r of rows.slice(0, 20)) {
        const v = r[c.sql_name]!;
        if (v === '') continue;
        if (c.data_type === 'date') expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (c.data_type === 'datetime') expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        if (c.data_type === 'decimal' || c.data_type === 'integer') expect(v).toMatch(/^-?\d+(\.\d+)?$/);
      }
    }
  });
});

describe('fixture 04: ambiguous dates', () => {
  const name = '04_ambiguous_dates.csv';

  it('assumes day-first and warns', async () => {
    const r = await profile(name);
    expect(r.parseOptions.date_format).toBe('dmy');
    expect(r.warnings.some((w) => /day-first/.test(w) && /month-first/.test(w))).toBe(true);
  });

  it('reparsed month-first changes the dates but not the sum, and drops the warning', async () => {
    const dmy = await profile(name);
    const mdy = await profile(name, { date_format: 'mdy' });
    expect(mdy.parseOptions.date_format).toBe('mdy');
    expect(mdy.warnings.some((w) => /day-first/.test(w))).toBe(false);
    const dmyDates = rowsOf(dmy).map((r) => r.date_col);
    const mdyDates = rowsOf(mdy).map((r) => r.date_col);
    expect(mdyDates).not.toEqual(dmyDates);
    expect(mdyDates[0]).toBe(`${dmyDates[0]!.slice(0, 4)}-${dmyDates[0]!.slice(8, 10)}-${dmyDates[0]!.slice(5, 7)}`);
    const dateCol = (r: ProfileResult) => r.columns.find((c) => c.sql_name === 'date_col')!;
    expect([dateCol(mdy).min_value, dateCol(mdy).max_value]).not.toEqual([dateCol(dmy).min_value, dateCol(dmy).max_value]);
    expect(sum(rowsOf(mdy), 'amount')).toBeCloseTo(expected[name]!.sums.amount!, 2);
  });
});

describe('row limit', () => {
  it('fails with the plan message when a file has more rows than allowed', async () => {
    await expect(
      profileFile({ buffer: file('03_bank_statement_comma_quoted.csv'), fileType: 'csv', options: {}, maxRows: 100 }),
    ).rejects.toThrow('Your plan allows 100 rows; this file has 150.');
  });

  it('groups large numbers with spaces', async () => {
    const big = Buffer.from(['a,b', ...Array.from({ length: 1_234 }, (_, i) => `${i},x`)].join('\n'));
    await expect(profileFile({ buffer: big, fileType: 'csv', options: {}, maxRows: 1_000 })).rejects.toThrow(
      'Your plan allows 1 000 rows; this file has 1 234.',
    );
  });
});

describe('privacy: suggestions prompt for the webstore fixture', () => {
  it('contains placeholders and none of the names, emails or phone numbers', async () => {
    const name = '02_webstore_orders_utf8bom.csv';
    const r = await profile(name);
    const { user } = buildSuggestionsPrompt({
      datasetName: 'Webstore orders',
      rowCount: r.rowCount,
      columns: r.columns.map((c) => ({ ...c, display_name: null })),
      sampleRows: r.sampleRows,
    });
    expect(user).toContain('[name]');
    expect(user).toContain('[email]');
    expect(user).toContain('[phone]');
    expect(user).toMatch(/<data>[\s\S]*<\/data>/);

    // Every value of every PII column in the original file, checked against the prompt.
    const raw = parse(file(name), { bom: true, columns: true }) as Array<Record<string, string>>;
    const piiValues = new Set<string>();
    for (const col of expected[name]!.pii_columns) {
      for (const row of raw) {
        const v = row[col]!.trim();
        piiValues.add(v);
        for (const part of v.split(/\s+/)) if (part.length >= 3) piiValues.add(part); // first names and surnames alone
        piiValues.add(v.replace(/\s/g, '')); // phone without spaces
      }
    }
    expect(piiValues.size).toBeGreaterThan(100);
    const leaked = [...piiValues].filter((v) => user.includes(v));
    expect(leaked).toEqual([]);
  });
});
