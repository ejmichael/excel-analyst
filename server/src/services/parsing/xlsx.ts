import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { listEntries, readEntry, streamEntryText, type ZipEntry } from './zip.js';

/**
 * A small streaming XLSX reader: zip entries are found through the central directory (any order),
 * XML is parsed with saxes, nothing is written to disk, and every decompressed byte counts against a cap.
 * It reads cached formula values (never evaluates formulas), shared and inline strings, booleans,
 * and turns date-formatted numbers into ISO strings.
 */

export type XlsxErrorReason = 'damaged' | 'too_large' | 'too_many_parts' | 'too_many_columns' | 'too_many_cells' | 'unsafe';

export class XlsxError extends Error {
  constructor(readonly reason: XlsxErrorReason) {
    super(`xlsx: ${reason}`);
    this.name = 'XlsxError';
  }
}

const MB = 1024 * 1024;

/**
 * Hard limits for reading a workbook. Exceeding any of them is a clear, user-safe failure, never a crash.
 * Sizes are bytes after decompression; "declared" sizes come from the zip directory and are checked up front,
 * and actual inflated bytes are counted again while reading, so a zip that lies about its sizes is still stopped.
 * Mutable only so tests can lower them; nothing else writes to it.
 */
export const XLSX_LIMITS = {
  /** Zip entries in the file (a normal workbook has tens). */
  maxEntries: 10_000,
  /** Sum of all entries' declared uncompressed sizes. */
  maxTotalUncompressed: 500 * MB,
  /** One worksheet XML part, counted as it inflates. */
  maxSheetXml: 500 * MB,
  /** xl/sharedStrings.xml (held in memory as the string table). */
  maxSharedStringsXml: 64 * MB,
  /** Any other XML part we read: workbook.xml, its rels, styles.xml. */
  maxOtherXml: 10 * MB,
  /** Entries in the shared-string table. */
  maxSharedStrings: 2_000_000,
  /** Columns per row (column index, so a single cell in column ZZZ counts). */
  maxColumns: 500,
  /** Row number within a sheet. */
  maxRowNumber: 2_000_000,
  /** Cells read in one pass over a sheet. */
  maxCellsPerPass: 25_000_000,
};

/** For error messages elsewhere. */
export const MAX_COLUMNS = XLSX_LIMITS.maxColumns;

export interface SheetInfo {
  name: string;
  path: string;
}

export interface Workbook {
  sheets: SheetInfo[];
  sharedStrings: string[];
  dateStyles: Set<number>;
  date1904: boolean;
  entries: Map<string, ZipEntry>;
}

/**
 * A saxes parser that refuses any DOCTYPE. OOXML never contains one, and refusing it rules out entity
 * expansion ("billion laughs") and external entities. saxes itself never fetches external entities.
 */
function safeParser(): SaxesParser {
  const p = new SaxesParser();
  p.on('doctype', () => {
    throw new XlsxError('unsafe');
  });
  return p;
}

function parseSmall(xml: string, on: { open?: (t: SaxesTagPlain) => void; text?: (t: string) => void; close?: (t: SaxesTagPlain) => void }) {
  const p = safeParser();
  if (on.open) p.on('opentag', on.open);
  if (on.text) p.on('text', on.text);
  if (on.close) p.on('closetag', on.close as (t: SaxesTagPlain) => void);
  p.on('cdata', (t) => on.text?.(t));
  try {
    p.write(xml).close();
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    throw new XlsxError('damaged');
  }
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);

/** Built-in number formats that are dates or times. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

export function isDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .split(';')[0]!;
  return /[dmyhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

function readXml(buf: Buffer, entry: ZipEntry | undefined, maxBytes: number): string | null {
  if (!entry) return null;
  try {
    return readEntry(buf, entry, maxBytes).toString('utf8');
  } catch {
    throw new XlsxError('too_large');
  }
}

/** Checks the zip directory against the entry-count and total-size limits (also used at upload time). */
export function checkZipLimits(list: ZipEntry[]): void {
  if (list.length > XLSX_LIMITS.maxEntries) throw new XlsxError('too_many_parts');
  if (list.reduce((s, e) => s + e.uncompressedSize, 0) > XLSX_LIMITS.maxTotalUncompressed) throw new XlsxError('too_large');
}

export function openWorkbook(buf: Buffer): Workbook {
  const list = listEntries(buf);
  if (!list) throw new XlsxError('damaged');
  checkZipLimits(list);
  const entries = new Map(list.map((e) => [e.name, e]));

  const workbookXml = readXml(buf, entries.get('xl/workbook.xml'), XLSX_LIMITS.maxOtherXml);
  if (!workbookXml) throw new XlsxError('damaged');
  const declared: Array<{ name: string; rid: string }> = [];
  let date1904 = false;
  parseSmall(workbookXml, {
    open(t) {
      const n = local(t.name);
      if (n === 'sheet') declared.push({ name: t.attributes.name ?? '', rid: t.attributes['r:id'] ?? '' });
      if (n === 'workbookPr') date1904 = t.attributes.date1904 === '1' || t.attributes.date1904 === 'true';
    },
  });

  const targets = new Map<string, string>();
  const relsXml = readXml(buf, entries.get('xl/_rels/workbook.xml.rels'), XLSX_LIMITS.maxOtherXml);
  if (relsXml) {
    parseSmall(relsXml, {
      open(t) {
        if (local(t.name) !== 'Relationship') return;
        const target = t.attributes.Target ?? '';
        targets.set(t.attributes.Id ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
      },
    });
  }
  const sheets = declared
    .map((s) => ({ name: s.name, path: targets.get(s.rid) ?? '' }))
    .filter((s) => entries.has(s.path));

  const sharedStrings: string[] = [];
  const ssXml = readXml(buf, entries.get('xl/sharedStrings.xml'), XLSX_LIMITS.maxSharedStringsXml);
  if (ssXml) {
    let current: string | null = null;
    let inText = false;
    let inPhonetic = false;
    parseSmall(ssXml, {
      open(t) {
        const n = local(t.name);
        if (n === 'si') current = '';
        else if (n === 'rPh') inPhonetic = true;
        else if (n === 't' && !inPhonetic) inText = true;
      },
      text(text) {
        if (inText && current !== null) current += text;
      },
      close(t) {
        const n = local(t.name);
        if (n === 't') inText = false;
        else if (n === 'rPh') inPhonetic = false;
        else if (n === 'si') {
          if (sharedStrings.length >= XLSX_LIMITS.maxSharedStrings) throw new XlsxError('too_large');
          sharedStrings.push(current ?? '');
          current = null;
        }
      },
    });
  }

  const dateStyles = new Set<number>();
  const stylesXml = readXml(buf, entries.get('xl/styles.xml'), XLSX_LIMITS.maxOtherXml);
  if (stylesXml) {
    const custom = new Map<number, string>();
    let inCellXfs = false;
    let xfIndex = 0;
    parseSmall(stylesXml, {
      open(t) {
        const n = local(t.name);
        if (n === 'numFmt') custom.set(Number(t.attributes.numFmtId), t.attributes.formatCode ?? '');
        else if (n === 'cellXfs') inCellXfs = true;
        else if (n === 'xf' && inCellXfs) {
          const id = Number(t.attributes.numFmtId ?? 0);
          const code = custom.get(id);
          if (code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id)) dateStyles.add(xfIndex);
          xfIndex++;
        }
      },
      close(t) {
        if (local(t.name) === 'cellXfs') inCellXfs = false;
      },
    });
  }

  return { sheets, sharedStrings, dateStyles, date1904, entries };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function numberToString(n: number): string {
  if (!Number.isFinite(n)) return '';
  const r = Number(n.toPrecision(15));
  const s = String(r);
  return /e/i.test(s) ? r.toFixed(12).replace(/\.?0+$/, '') : s;
}

/** Excel serial to 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM:SS', or 'HH:MM:SS' for a time of day. */
export function serialToString(serial: number, date1904: boolean): string {
  const seconds = Math.round((serial + (date1904 ? 1462 : 0)) * 86_400);
  const d = new Date((seconds - 25_569 * 86_400) * 1000);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (serial < 1) return time;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return time === '00:00:00' ? date : `${date}T${time}`;
}

export const colNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

export interface SheetRow {
  n: number;
  cells: string[];
}

export interface SheetStats {
  numericCells: number;
}

/**
 * Streams a sheet's rows (only rows present in the file; the caller fills gaps).
 * When `stats` is given, only numeric cells are counted and no rows are yielded.
 */
export async function* readSheetRows(
  buf: Buffer,
  wb: Workbook,
  sheet: SheetInfo,
  stats?: SheetStats,
): AsyncGenerator<SheetRow> {
  const entry = wb.entries.get(sheet.path);
  if (!entry) throw new XlsxError('damaged');
  const parser = safeParser();
  const ready: SheetRow[] = [];
  let cellsRead = 0;
  let rowN = 0;
  let cells: string[] = [];
  let cell: { col: number; type: string; style: number; value: string; inline: string } | null = null;
  let nextCol = 1;
  let inV = false;
  let inInlineT = false;

  parser.on('opentag', (t) => {
    switch (local(t.name)) {
      case 'row':
        rowN = t.attributes.r ? Number(t.attributes.r) : rowN + 1;
        if (!Number.isFinite(rowN) || rowN > XLSX_LIMITS.maxRowNumber) throw new XlsxError('too_many_cells');
        cells = [];
        nextCol = 1;
        break;
      case 'c': {
        const ref = /^([A-Z]+)/.exec(t.attributes.r ?? '');
        const col = ref ? colNumber(ref[1]!) : nextCol;
        if (col > XLSX_LIMITS.maxColumns) throw new XlsxError('too_many_columns');
        if (++cellsRead > XLSX_LIMITS.maxCellsPerPass) throw new XlsxError('too_many_cells');
        cell = { col, type: t.attributes.t ?? 'n', style: Number(t.attributes.s ?? 0), value: '', inline: '' };
        nextCol = col + 1;
        break;
      }
      case 'v':
        inV = true;
        break;
      case 't':
        if (cell?.type === 'inlineStr') inInlineT = true;
        break;
    }
  });
  const onText = (text: string) => {
    if (!cell) return;
    if (inV) cell.value += text;
    else if (inInlineT) cell.inline += text;
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  parser.on('closetag', (t) => {
    switch (local(t.name)) {
      case 'v':
        inV = false;
        break;
      case 't':
        inInlineT = false;
        break;
      case 'c': {
        if (!cell) break;
        const c = cell;
        cell = null;
        if (stats) {
          if ((c.type === 'n' || c.type === '') && c.value !== '') stats.numericCells++;
          break;
        }
        let out = '';
        switch (c.type) {
          case 's':
            out = wb.sharedStrings[Number(c.value)] ?? '';
            break;
          case 'str':
            out = c.value;
            break;
          case 'inlineStr':
            out = c.inline;
            break;
          case 'b':
            out = c.value === '1' ? 'true' : c.value === '0' ? 'false' : '';
            break;
          case 'e':
            out = '';
            break;
          case 'd':
            out = c.value.replace(/Z$/, '').replace(/T00:00:00(\.0+)?$/, '');
            break;
          default: {
            if (c.value === '') break;
            const num = Number(c.value);
            if (!Number.isFinite(num)) break;
            out = wb.dateStyles.has(c.style) ? serialToString(num, wb.date1904) : numberToString(num);
          }
        }
        while (cells.length < c.col - 1) cells.push('');
        cells[c.col - 1] = out;
        break;
      }
      case 'row':
        if (!stats) ready.push({ n: rowN, cells });
        break;
    }
  });

  try {
    for await (const text of streamEntryText(buf, entry, XLSX_LIMITS.maxSheetXml)) {
      parser.write(text);
      if (ready.length > 0) yield* ready.splice(0);
    }
    parser.close();
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    if (err instanceof Error && err.message === 'entry too large') throw new XlsxError('too_large');
    throw new XlsxError('damaged');
  }
  if (ready.length > 0) yield* ready.splice(0);
}

/** Merged ranges whose first row is within `rowLimit`, from the sheet's <mergeCells>. */
export async function readMerges(buf: Buffer, wb: Workbook, sheet: SheetInfo, rowLimit: number) {
  const entry = wb.entries.get(sheet.path);
  if (!entry) return [];
  const merges: Array<{ r1: number; c1: number; r2: number; c2: number }> = [];
  const re = /<(?:\w+:)?mergeCell\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g;
  let carry = '';
  try {
    for await (const text of streamEntryText(buf, entry, XLSX_LIMITS.maxSheetXml)) {
      const chunk = carry + text;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let lastEnd = 0;
      while ((m = re.exec(chunk))) {
        lastEnd = re.lastIndex;
        const r1 = Number(m[2]);
        if (r1 <= rowLimit) merges.push({ r1, c1: colNumber(m[1]!), r2: Number(m[4]), c2: colNumber(m[3]!) });
      }
      carry = chunk.slice(Math.max(lastEnd, chunk.length - 200));
    }
  } catch {
    throw new XlsxError('too_large');
  }
  return merges;
}
