import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { type Delimiter, detectDelimiter } from './delimiter.js';
import { decodeChunks, decodeHead, detectEncoding, type TextEncoding } from './encoding.js';
import { MAX_COLUMNS, openWorkbook, readMerges, readSheetRows, XlsxError } from './xlsx.js';

/** A user-safe failure: the message is shown to the user as the dataset's error_message. */
export class ParseFailure extends Error {
  constructor(
    message: string,
    /** Set when the failure is a plan limit; the job adds upgrade_to and stores it as error_details. */
    readonly limit?: { limit_key: 'max_rows'; limit: number; used: number },
  ) {
    super(message);
    this.name = 'ParseFailure';
  }
}

export const TOO_SLOW = 'This file took too long to read.';

export interface Row {
  /** 1-based line (CSV record) or row number in the original file. */
  n: number;
  cells: string[];
}

export interface RowSource {
  encoding: TextEncoding | null;
  delimiter: Delimiter | null;
  sheetNames: string[];
  sheetName: string | null;
  /** Streams every row from the top of the file (or sheet). Can be called more than once. */
  rows(signal?: AbortSignal): AsyncGenerator<Row>;
}

const CHECK_EVERY = 2000;

function checkAbort(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new ParseFailure(TOO_SLOW);
}

// ---------- CSV ----------

export function openCsv(buf: Buffer, delimiterOverride?: Delimiter | null): RowSource {
  const encoding = detectEncoding(buf);
  const delimiter = delimiterOverride ?? detectDelimiter(decodeHead(buf, encoding));
  if (!delimiter) throw new ParseFailure('We could not find separate columns in this file.');
  return {
    encoding,
    delimiter,
    sheetNames: [],
    sheetName: null,
    async *rows(signal) {
      const parser = Readable.from(decodeChunks(buf, encoding)).pipe(
        parse({ delimiter, relax_quotes: true, relax_column_count: true, skip_empty_lines: false, bom: false }),
      );
      let n = 0;
      try {
        for await (const record of parser as AsyncIterable<string[]>) {
          n++;
          if (n % CHECK_EVERY === 0) checkAbort(signal);
          if (record.length > MAX_COLUMNS) throw new ParseFailure(`This file has more than ${MAX_COLUMNS} columns.`);
          yield { n, cells: record };
        }
      } catch (err) {
        if (err instanceof ParseFailure) throw err;
        // csv-parse errors quote file content; replace them with a safe message.
        throw new ParseFailure(`We could not read line ${n + 1} of this file. Check for a quote that is never closed.`);
      } finally {
        parser.destroy();
      }
    },
  };
}

// ---------- XLSX ----------

/** Merged cells are only repeated in the top rows, where headers live. */
const MERGE_ROW_LIMIT = 100;
const MAX_XLSX_ROWS = 2_000_000;

export const XLSX_MESSAGES: Record<XlsxError['reason'], string> = {
  damaged: 'We could not read this Excel file. It may be damaged; try saving it again or exporting it as CSV.',
  too_large: 'This workbook is too large to read once unzipped.',
  too_many_parts: 'This workbook has too many internal parts to be a normal spreadsheet.',
  too_many_columns: `This workbook has more than ${MAX_COLUMNS} columns.`,
  too_many_cells: 'This workbook has too many rows or cells to read.',
  unsafe: 'This Excel file contains a document type declaration, which spreadsheets never need, so we did not read it. Save it again from Excel or export it as CSV.',
};

function xlsxFailure(err: unknown): never {
  if (err instanceof ParseFailure) throw err;
  if (err instanceof XlsxError) throw new ParseFailure(XLSX_MESSAGES[err.reason]);
  throw new ParseFailure(XLSX_MESSAGES.damaged);
}

export async function openXlsx(buf: Buffer, sheetOverride?: string | null, signal?: AbortSignal): Promise<RowSource> {
  let wb: ReturnType<typeof openWorkbook>;
  try {
    wb = openWorkbook(buf);
  } catch (err) {
    xlsxFailure(err);
  }
  if (wb.sheets.length === 0) throw new ParseFailure('This workbook has no sheets.');

  let chosen = wb.sheets[0]!;
  if (sheetOverride) {
    const found = wb.sheets.find((s) => s.name === sheetOverride);
    if (!found) throw new ParseFailure(`There is no sheet called "${sheetOverride}" in this workbook.`);
    chosen = found;
  } else if (wb.sheets.length > 1) {
    // Default to the sheet with the most numeric cells.
    let best = -1;
    for (const sheet of wb.sheets) {
      const stats = { numericCells: 0 };
      try {
        for await (const _ of readSheetRows(buf, wb, sheet, stats)) void _;
      } catch (err) {
        xlsxFailure(err);
      }
      checkAbort(signal);
      if (stats.numericCells > best) {
        best = stats.numericCells;
        chosen = sheet;
      }
    }
  }

  let merges: Awaited<ReturnType<typeof readMerges>>;
  try {
    merges = await readMerges(buf, wb, chosen, MERGE_ROW_LIMIT);
  } catch (err) {
    xlsxFailure(err);
  }

  return {
    encoding: null,
    delimiter: null,
    sheetNames: wb.sheets.map((s) => s.name),
    sheetName: chosen.name,
    async *rows(sig) {
      const topLeft = new Map<string, string>();
      let expected = 1;
      try {
        for await (const row of readSheetRows(buf, wb, chosen)) {
          if (row.n % CHECK_EVERY === 0) checkAbort(sig);
          if (row.n > MAX_XLSX_ROWS) throw new ParseFailure('This workbook has too many rows to read.');
          // Empty rows are absent from the file; yield them so row numbers match what the user sees in Excel.
          for (; expected < row.n; expected++) yield { n: expected, cells: [] };
          expected = row.n + 1;
          const cells = row.cells;
          if (row.n <= MERGE_ROW_LIMIT) {
            for (const m of merges) {
              if (row.n === m.r1) topLeft.set(`${m.r1}:${m.c1}`, cells[m.c1 - 1] ?? '');
              if (row.n < m.r1 || row.n > m.r2) continue;
              const value = topLeft.get(`${m.r1}:${m.c1}`) ?? '';
              for (let c = m.c1; c <= m.c2; c++) {
                while (cells.length < c) cells.push('');
                if (cells[c - 1] === '') cells[c - 1] = value;
              }
            }
          }
          yield { n: row.n, cells };
        }
      } catch (err) {
        xlsxFailure(err);
      }
    },
  };
}
