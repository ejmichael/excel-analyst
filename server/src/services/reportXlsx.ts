import writeXlsxFile, { type Cell, type CellObject, type Row, type Sheet } from 'write-excel-file/node';
import type { Block, BlockCheck, CellValue, ReportDetail, ValueFormat } from '../types/api.js';
import { sastDateTime } from './dates.js';

/**
 * The Excel export of a report (API_CONTRACT "Exports"): sheet "Summary", one sheet per answer, then "Working".
 * Every cell is written with an explicit type (String, Number or Date), never as a formula: a text cell beginning with
 * =, +, - or @ is an ordinary shared-string cell, which Excel shows as text and never evaluates.
 * The workbook is built in memory (write-excel-file), so its size is capped (MAX_EXPORT_CELLS) and at most
 * MAX_CONCURRENT_EXPORTS are built at a time.
 */

export const CAUTION = 'Check important figures against your source file before you rely on them.';
// Measured 2026-11-16 on a laptop: 120 000 cells (30 x 500 x 8) build in 1.4 s; 450 000 in 4.3 s, which blocks the event loop.
export const MAX_EXPORT_CELLS = 300_000;
export const MAX_CONCURRENT_EXPORTS = 2;

export class ExportTooLarge extends Error {
  constructor(readonly cells: number) {
    super('export too large');
    this.name = 'ExportTooLarge';
  }
}

// ---------- names ----------

const SHEET_NAME_MAX = 31;
const FORBIDDEN_IN_SHEET_NAME = /[[\]:*?/\\]/g;
const RESERVED = new Set(['summary', 'working', 'history']);

/** A sheet name Excel accepts: none of [ ] : * ? / \, no control characters, no leading or trailing apostrophe. */
function cleanSheetName(raw: string): string {
  return raw
    .replace(FORBIDDEN_IN_SHEET_NAME, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, SHEET_NAME_MAX)
    .trim();
}

/**
 * One unique sheet name per answer (case-insensitive, as Excel compares them), from its heading. Falls back to
 * "Answer N" when nothing usable is left; "Summary", "Working" and "History" (reserved by Excel) get a suffix.
 */
export function sheetNames(headings: string[]): string[] {
  const used = new Set(['summary', 'working']);
  return headings.map((heading, i) => {
    const base = cleanSheetName(heading) || `Answer ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()) || RESERVED.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, SHEET_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

// ---------- formats and colours ----------

export const NUMBER_FORMATS: Record<Exclude<ValueFormat, 'text'>, string> = {
  zar: '"R" #,##0.00',
  integer: '#,##0',
  number: '#,##0.00',
  percent: '0.0%',
  date: 'yyyy-mm-dd',
};

const DEFAULT_HEADER_FILL = '#E5E7EB';

/** Relative luminance (WCAG 2) of #RRGGBB. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Black or white text, whichever contrasts more with the fill. */
export function readableTextColor(fill: string): '#000000' | '#FFFFFF' {
  const l = luminance(fill);
  const withBlack = (l + 0.05) / 0.05;
  const withWhite = 1.05 / (l + 0.05);
  return withBlack >= withWhite ? '#000000' : '#FFFFFF';
}

// ---------- cells ----------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** A result value as a typed cell: numbers as Number with the column's format, dates as real Excel dates, the rest as text. */
export function valueCell(value: CellValue, format: ValueFormat): Cell {
  if (value === null || value === undefined) return null;
  if (format === 'date' && typeof value === 'string') {
    const m = DATE_RE.exec(value);
    if (m) {
      const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)));
      const time = m[4] !== undefined && (m[4] !== '00' || m[5] !== '00');
      return { type: Date, value: date, format: time ? 'yyyy-mm-dd hh:mm' : NUMBER_FORMATS.date };
    }
  }
  if (typeof value === 'number' && format !== 'text' && format !== 'date' && Number.isFinite(value)) {
    return { type: Number, value, format: NUMBER_FORMATS[format] };
  }
  return text(String(value));
}

/** A text cell. Always String-typed: never a formula, whatever it starts with. */
export const text = (value: string, style: Omit<CellObject, 'value' | 'type'> = {}): CellObject => ({ ...style, type: String, value });

// ---------- the workbook ----------

export interface WorkbookOptions {
  appName: string;
  /** limits.branding of the owner's plan: the header fill uses brand.color. */
  branding: boolean;
  generatedAt: Date;
}

const heading = (rb: ReportDetail['blocks'][number]) => rb.heading_override ?? rb.block.title;

function failedChecksLine(block: Block): string | null {
  if (block.status !== 'flagged') return null;
  const failed = block.checks.filter((c) => !c.ok).map((c) => c.label);
  return `Needs a closer look: ${failed.length ? failed.join('; ') : 'a check did not pass'}.`;
}

function checkLine(c: BlockCheck): Row {
  return [
    text(c.label),
    text(c.ok ? 'Passed' : 'Failed'),
    c.expected === undefined ? null : { type: Number, value: c.expected },
    c.actual === undefined ? null : { type: Number, value: c.actual },
  ];
}

/** Rows times columns over every answer table, plus the fixed lines: what the size cap is checked against. */
export function exportCellCount(detail: ReportDetail): number {
  return detail.blocks.reduce((n, rb) => n + (rb.block.rows.length + 1) * Math.max(1, rb.block.columns.length) + 8, 20);
}

const widthFor = (values: string[]) => Math.min(60, Math.max(10, ...values.map((v) => v.length + 2)));

export function buildSheets(detail: ReportDetail, opts: WorkbookOptions): Sheet<Buffer>[] {
  const cells = exportCellCount(detail);
  if (cells > MAX_EXPORT_CELLS) throw new ExportTooLarge(cells);

  const fill = opts.branding && /^#[0-9a-fA-F]{6}$/.test(detail.brand.color) ? detail.brand.color : DEFAULT_HEADER_FILL;
  const header = (value: string) => text(value, { fontWeight: 'bold', backgroundColor: fill, textColor: readableTextColor(fill) });
  const label = (value: string) => text(value, { fontWeight: 'bold' });
  const wrapped = (value: string) => text(value, { wrap: true, alignVertical: 'top' });

  const summary: Row[] = [
    [text(detail.title, { fontWeight: 'bold', fontSize: 14 })],
    [],
    [label('Business'), detail.brand.business_name ? text(detail.brand.business_name) : null],
    [label('Report'), text(detail.title)],
    [label('Subtitle'), detail.subtitle ? text(detail.subtitle) : null],
    [label('Period'), detail.period_label ? text(detail.period_label) : null],
    [label('Generated'), text(`${sastDateTime(opts.generatedAt)} (SAST)`)],
    [label('Notes'), detail.notes ? wrapped(detail.notes) : null],
    [],
    [text(CAUTION, { fontStyle: 'italic' })],
  ];
  if (detail.watermark) summary.push([text(`Made with ${opts.appName}`)]);

  const names = sheetNames(detail.blocks.map(heading));
  const answerSheets: Sheet<Buffer>[] = detail.blocks.map((rb, i) => {
    const b = rb.block;
    const warning = failedChecksLine(b);
    const columns = b.columns;
    const rows: Row[] = [
      [text(heading(rb), { fontWeight: 'bold', fontSize: 14 })],
      [label('Question'), wrapped(b.question)],
      [label('Answer'), wrapped(b.narrative)],
    ];
    if (warning) rows.push([label('Warning'), text(warning, { wrap: true, textColor: '#9A3412', fontWeight: 'bold' })]);
    rows.push([]);
    rows.push(columns.map((c) => header(c.name)));
    for (const r of b.rows) rows.push(columns.map((c) => valueCell(r[c.name] ?? null, c.format)));
    const widths = columns.map((c) =>
      widthFor([c.name, ...b.rows.slice(0, 200).map((r) => (r[c.name] === null || r[c.name] === undefined ? '' : String(r[c.name])))]),
    );
    // Column B also holds the question and narrative: wide enough to read them wrapped.
    if (widths.length < 2) widths.push(60);
    widths[1] = Math.max(widths[1]!, 60);
    return { sheet: names[i]!, data: rows, columns: widths.map((width) => ({ width })), showGridLines: true };
  });

  const working: Row[] = [[header('Answer'), header('SQL'), header('Check'), header('Result'), header('Expected'), header('Actual')]];
  for (const rb of detail.blocks) {
    const checks = rb.block.checks.length > 0 ? rb.block.checks : [];
    working.push([text(heading(rb), { fontWeight: 'bold' }), wrapped(rb.block.sql), ...(checks[0] ? checkLine(checks[0]) : [])]);
    for (const c of checks.slice(1)) working.push([null, null, ...checkLine(c)]);
  }

  return [
    { sheet: 'Summary', data: summary, columns: [{ width: 16 }, { width: 80 }] },
    ...answerSheets,
    { sheet: 'Working', data: working, columns: [{ width: 30 }, { width: 80 }, { width: 40 }, { width: 10 }, { width: 14 }, { width: 14 }], stickyRowsCount: 1 },
  ];
}

export async function buildReportXlsx(detail: ReportDetail, opts: WorkbookOptions): Promise<Buffer> {
  return writeXlsxFile(buildSheets(detail, opts)).toBuffer();
}
