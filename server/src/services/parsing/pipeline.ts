import type { ColumnDataType, ColumnSemantic, ParseOptions } from '../../types/api.js';
import type { DateOrder } from './dates.js';
import type { Delimiter } from './delimiter.js';
import { cleanHeaders, toSqlNames } from './headers.js';
import { ColumnEvidence, inferSemantic, normaliseValue } from './infer.js';
import { findHeaderRow, isBlank, isTotalRow, width } from './layout.js';
import type { DecimalSeparator } from './numbers.js';
import { openCsv, openXlsx, ParseFailure, type Row, type RowSource, TOO_SLOW } from './sources.js';

/**
 * The profiling pipeline (ARCHITECTURE 2b-2f and 6), as plain functions over a file buffer:
 * header row, row exclusion, column types, decimal and date conventions, normalised CSV and stats.
 * Two streaming passes over the rows: the first gathers evidence, the second writes the normalised file.
 * Throws ParseFailure with a user-safe message; never puts cell values in an error.
 */

export interface ProfiledColumn {
  position: number; // 1-based
  name: string;
  sql_name: string;
  data_type: ColumnDataType;
  semantic: ColumnSemantic;
  is_pii: boolean;
  null_count: number;
  distinct_count: number;
  min_value: string | null;
  max_value: string | null;
  /** Up to 5 distinct values, NOT masked. Mask before storing or showing for PII columns. */
  samples: string[];
}

export interface ProfileResult {
  /** CSV only: the detected text encoding. */
  encoding: 'utf-8' | 'windows-1252' | null;
  normalisedCsv: Buffer;
  rowCount: number;
  excludedRows: number;
  warnings: string[];
  sheetNames: string[];
  preambleLines: string[];
  parseOptions: Required<ParseOptions>;
  columns: ProfiledColumn[];
  /** The first 5 data rows, normalised, keyed by sql_name. NOT masked. */
  sampleRows: Array<Record<string, string>>;
}

export interface ProfileInput {
  buffer: Buffer;
  fileType: 'csv' | 'xlsx';
  /** Only non-null fields override detection. */
  options: ParseOptions;
  maxRows: number;
  signal?: AbortSignal;
}

const ROW_COUNT_CAP = 1_000_000;
const HEAD_ROWS = 60;
const MAX_PREAMBLE = 10;
const MAX_PENDING_TOTALS = 1000;

/** 1234567 -> "1 234 567" (plain spaces, as in the user-facing messages). */
export const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const plural = (n: number, one: string, many: string) => `${groupDigits(n)} ${n === 1 ? one : many}`;

function escapeCsv(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function readHead(src: RowSource, upTo: number, signal?: AbortSignal): Promise<Row[]> {
  const head: Row[] = [];
  for await (const row of src.rows(signal)) {
    head.push(row);
    if (head.length >= upTo) break;
  }
  return head;
}

export async function profileFile(input: ProfileInput): Promise<ProfileResult> {
  const { options, signal } = input;
  const src =
    input.fileType === 'xlsx'
      ? await openXlsx(input.buffer, options.sheet_name, signal)
      : openCsv(input.buffer, (options.delimiter ?? null) as Delimiter | null);
  const warnings: string[] = [];

  // ----- header row -----
  const headerOverride = options.header_row ?? null;
  const head = await readHead(src, Math.max(HEAD_ROWS, headerOverride ?? 0), signal);
  let header: Row | null;
  if (headerOverride !== null) {
    header = head.find((r) => r.n === headerOverride) ?? null;
    if (!header || isBlank(header.cells)) throw new ParseFailure(`Row ${headerOverride} is empty or beyond the end of the file.`);
  } else {
    header = findHeaderRow(head);
    if (!header) {
      header = head.find((r) => !isBlank(r.cells)) ?? null;
      if (!header) throw new ParseFailure('This file is empty.');
      warnings.push(`We could not find a clear header row, so we used row ${header.n}. Change it in the parse options if that is wrong.`);
    }
  }
  const headerRow = header.n;
  const w = width(header.cells);
  const preambleLines = head
    .filter((r) => r.n < headerRow && !isBlank(r.cells))
    .slice(0, MAX_PREAMBLE)
    .map((r) => r.cells.map((c) => c.trim()).filter((c) => c !== '').join(' ').slice(0, 200));

  // ----- pass A: evidence, row counts, footers -----
  const evidence = Array.from({ length: w }, () => new ColumnEvidence());
  let dataRows = 0;
  let blankRows = 0;
  let widerRows = 0;
  let overCap = false;
  let pending: Row[] = [];
  const addRow = (row: Row) => {
    dataRows++;
    for (let c = 0; c < w; c++) evidence[c]!.add(row.cells[c] ?? '');
    if (width(row.cells) > w) widerRows++;
  };
  for await (const row of src.rows(signal)) {
    if (row.n <= headerRow) continue;
    if (isBlank(row.cells)) {
      blankRows++;
      continue;
    }
    // Total rows only count as footers when nothing but totals and blanks follows them.
    // Bounded: past MAX_PENDING_TOTALS the "totals" are data, not a footer, so stop holding them back.
    if (isTotalRow(row.cells) && pending.length < MAX_PENDING_TOTALS) {
      pending.push(row);
      continue;
    }
    for (const p of pending) addRow(p);
    pending = [];
    addRow(row);
    if (dataRows > ROW_COUNT_CAP) {
      overCap = true;
      break;
    }
  }
  const trailing = new Set(pending.map((r) => r.n));
  if (dataRows > input.maxRows) {
    const found = overCap ? `more than ${groupDigits(ROW_COUNT_CAP)}` : groupDigits(dataRows);
    throw new ParseFailure(`Your plan allows ${groupDigits(input.maxRows)} rows; this file has ${found}.`, {
      limit_key: 'max_rows',
      limit: input.maxRows,
      used: dataRows, // past the counting cap this is 1 000 001
    });
  }
  if (dataRows === 0) throw new ParseFailure('We found a header row but no data rows below it.');
  const excludedRows = blankRows + trailing.size;

  // ----- conventions -----
  const votes = evidence.reduce((acc, e) => ({ dot: acc.dot + e.dotOnly, comma: acc.comma + e.commaOnly }), { dot: 0, comma: 0 });
  const dec: DecimalSeparator = options.decimal_separator ?? (votes.comma > votes.dot ? ',' : '.');

  let order: DateOrder = 'dmy';
  const numericDateCols = evidence.filter((e) => e.isNumericDateColumn);
  if (options.date_format) {
    order = options.date_format;
  } else if (numericDateCols.length > 0) {
    const firstOver12 = numericDateCols.some((e) => e.maxFirst > 12);
    const secondOver12 = numericDateCols.some((e) => e.maxSecond > 12);
    if (secondOver12 && !firstOver12) order = 'mdy';
    else if (firstOver12 && secondOver12) {
      warnings.push('Some dates are written day-first and others month-first. We read them day-first; check the date columns.');
    } else if (!firstOver12) {
      warnings.push(
        'Every date in this file could be read day-first or month-first. We assumed day-first (dd/mm/yyyy), the South African norm. If that is wrong, choose month-first in the parse options.',
      );
    }
  }
  const types = evidence.map((e) => e.dataType(dec, order));
  const dateCols = evidence.filter((_, i) => types[i] === 'date' || types[i] === 'datetime');
  const dateFormat: DateOrder | null =
    options.date_format ?? (numericDateCols.length > 0 ? order : dateCols.length === 0 ? null : dateCols.every((e) => e.date.ymd === e.nonEmpty) ? 'ymd' : 'dmy');

  const { names, renamed } = cleanHeaders(header.cells.slice(0, w));
  const sqlNames = toSqlNames(names);
  if (renamed > 0) warnings.push(`${plural(renamed, 'column header was', 'column headers were')} empty or repeated, so we renamed them.`);
  if (widerRows > 0) warnings.push(`${plural(widerRows, 'row has', 'rows have')} more values than there are headers; the extra values were left out.`);
  if (excludedRows > 0) warnings.push(`We left out ${plural(excludedRows, 'empty or total row', 'empty or total rows')}.`);
  if (src.sheetNames.length > 1 && !options.sheet_name) {
    warnings.push(`This workbook has ${src.sheetNames.length} sheets. We used "${src.sheetName}", the one with the most numbers.`);
  }

  // ----- pass B: normalise, stats, samples -----
  if (signal?.aborted) throw new ParseFailure(TOO_SLOW);
  const distinct = Array.from({ length: w }, () => new Set<string>());
  const nulls = new Array<number>(w).fill(0);
  const mins: Array<string | null> = new Array<string | null>(w).fill(null);
  const maxs: Array<string | null> = new Array<string | null>(w).fill(null);
  const numeric = types.map((t) => t === 'integer' || t === 'decimal');
  const ordered = types.map((t) => t === 'integer' || t === 'decimal' || t === 'date' || t === 'datetime');
  const sampleRows: Array<Record<string, string>> = [];
  const out: Buffer[] = [];
  let batch: string[] = [sqlNames.map(escapeCsv).join(',')];
  let written = 0;
  for await (const row of src.rows(signal)) {
    if (row.n <= headerRow || isBlank(row.cells) || trailing.has(row.n)) continue;
    if (written >= dataRows) break;
    written++;
    const values = new Array<string>(w);
    for (let c = 0; c < w; c++) {
      const v = normaliseValue(row.cells[c] ?? '', types[c]!, dec, order);
      values[c] = v;
      if (v === '') {
        nulls[c]!++;
        continue;
      }
      distinct[c]!.add(v);
      if (ordered[c]) {
        const less = numeric[c] ? (a: string, b: string) => Number(a) < Number(b) : (a: string, b: string) => a < b;
        if (mins[c] === null || less(v, mins[c]!)) mins[c] = v;
        if (maxs[c] === null || less(maxs[c]!, v)) maxs[c] = v;
      }
    }
    if (sampleRows.length < 5) sampleRows.push(Object.fromEntries(sqlNames.map((n, c) => [n, values[c]!])));
    batch.push(values.map(escapeCsv).join(','));
    if (batch.length >= 5000) {
      out.push(Buffer.from(`${batch.join('\n')}\n`, 'utf8'));
      batch = [];
    }
  }
  if (batch.length > 0) out.push(Buffer.from(`${batch.join('\n')}\n`, 'utf8'));

  const columns: ProfiledColumn[] = names.map((name, c) => {
    const { semantic, isPii } = inferSemantic({ name, dataType: types[c]!, evidence: evidence[c]!, distinct: distinct[c]!.size });
    return {
      position: c + 1,
      name,
      sql_name: sqlNames[c]!,
      data_type: types[c]!,
      semantic,
      is_pii: isPii,
      null_count: nulls[c]!,
      distinct_count: distinct[c]!.size,
      min_value: mins[c]!,
      max_value: maxs[c]!,
      samples: [...distinct[c]!].slice(0, 5),
    };
  });

  return {
    encoding: src.encoding,
    normalisedCsv: Buffer.concat(out),
    rowCount: dataRows,
    excludedRows,
    warnings,
    sheetNames: src.sheetNames,
    preambleLines,
    parseOptions: {
      sheet_name: src.sheetName,
      header_row: headerRow,
      delimiter: src.delimiter,
      decimal_separator: dec,
      date_format: dateFormat,
    },
    columns,
    sampleRows,
  };
}
