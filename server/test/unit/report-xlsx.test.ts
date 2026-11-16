import { describe, expect, it } from 'vitest';
import { slugify } from '../../src/services/downloadNames.js';
import { openWorkbook, readSheetRows } from '../../src/services/parsing/xlsx.js';
import { listEntries, readEntry } from '../../src/services/parsing/zip.js';
import {
  buildReportXlsx,
  CAUTION,
  ExportTooLarge,
  MAX_EXPORT_CELLS,
  NUMBER_FORMATS,
  readableTextColor,
  sheetNames,
  valueCell,
} from '../../src/services/reportXlsx.js';
import type { Block, BlockCheck, ReportDetail } from '../../src/types/api.js';

// ---------- helpers ----------

const passed = (type: BlockCheck['type'], label: string): BlockCheck => ({ type, ok: true, label });

function block(over: Partial<Block>): Block {
  return {
    id: 'b',
    dataset_id: null,
    question: 'What sold?',
    title: 'Sales',
    sql: 'SELECT 1',
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    chart: { type: 'table', x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: {} },
    narrative: 'Fine.',
    follow_ups: [],
    checks: [passed('sql_read_only', 'Read-only query')],
    status: 'ok',
    source: 'user',
    has_source_rows: false,
    created_at: '2026-11-16T10:00:00+02:00',
    ...over,
  };
}

function report(blocks: Block[], over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    id: 'r',
    workspace_id: 'w',
    title: 'October report',
    subtitle: 'For the owners',
    period_label: 'October 2026',
    notes: 'Card sales only.',
    template_id: null,
    block_count: blocks.length,
    created_at: '2026-11-16T10:00:00+02:00',
    updated_at: '2026-11-16T10:00:00+02:00',
    brand: { business_name: 'Padstal (Pty) Ltd', logo_url: null, color: '#1E7A5F' },
    watermark: false,
    blocks: blocks.map((b, position) => ({ position, heading_override: null, block: b })),
    comparison: null,
    ...over,
  };
}

const SALES = block({
  title: 'Net sales by day',
  columns: [
    { name: 'day', format: 'date' },
    { name: 'store', format: 'text' },
    { name: 'net', format: 'zar' },
    { name: 'share', format: 'percent' },
    { name: 'transactions', format: 'integer' },
  ],
  rows: [
    { day: '2026-10-01', store: 'Café Rosé', net: 11401.64, share: 0.3436, transactions: 9 },
    { day: '2026-10-02', store: 'Padstal', net: -1578.28, share: 0.1, transactions: 7 },
    { day: null, store: null, net: 0, share: null, transactions: 0 },
  ],
  narrative: 'Café Rosé sold the most, at R 11 401,64.',
});

const FLAGGED = block({
  title: 'Total by store',
  status: 'flagged',
  checks: [passed('sql_read_only', 'Read-only query'), { type: 'total_reconciles', ok: false, label: 'Total of net matches your file', expected: 100, actual: 99.5 }],
  columns: [{ name: 'store', format: 'text' }, { name: 'net', format: 'zar' }],
  rows: [{ store: 'Padstal', net: 99.5 }],
});

const OPTS = { appName: 'Analyst', branding: true, generatedAt: new Date('2026-11-16T08:30:00Z') };

async function readAll(buf: Buffer): Promise<Map<string, string[][]>> {
  const wb = openWorkbook(buf);
  const out = new Map<string, string[][]>();
  for (const sheet of wb.sheets) {
    const rows: string[][] = [];
    for await (const r of readSheetRows(buf, wb, sheet)) rows[r.n - 1] = r.cells;
    out.set(sheet.name, Array.from(rows, (r) => r ?? []));
  }
  return out;
}

function entryText(buf: Buffer, name: string): string {
  const e = listEntries(buf)!.find((x) => x.name === name);
  if (!e) throw new Error(`no ${name}`);
  return readEntry(buf, e, 50 * 1024 * 1024).toString('utf8');
}

// ---------- names ----------

describe('slug', () => {
  it.each([
    ['October report', 'october-report'],
    ['Café Rosé: Q4 / 2026!', 'cafe-rose-q4-2026'],
    ['  --  ', 'report'],
    ['日本語', 'report'],
    ['x'.repeat(59) + ' yz', 'x'.repeat(59)],
  ])('%j -> %j', (title, slug) => {
    expect(slugify(title, 'report')).toBe(slug);
  });

  it('never longer than 60 characters, only ASCII letters, digits and hyphens', () => {
    const s = slugify('Ä long title with many words that keeps going on and on and on, until it is far too long', 'report');
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe('sheet names', () => {
  it('drops forbidden characters and cuts to 31', () => {
    const [name] = sheetNames(['Sales [by] store: a/b\\c *?']);
    expect(name).toBe('Sales by store a b c');
    expect(sheetNames(['y'.repeat(40)])[0]).toHaveLength(31);
  });

  it('makes duplicates unique (case-insensitive) within 31 characters', () => {
    const names = sheetNames(['Sales', 'sales', 'SALES', 'z'.repeat(31), 'z'.repeat(31)]);
    expect(names).toEqual(['Sales', 'sales (2)', 'SALES (3)', 'z'.repeat(31), `${'z'.repeat(27)} (2)`]);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('falls back to "Answer N" for an empty or unusable heading, and avoids Summary, Working and History', () => {
    expect(sheetNames(['', '***', "'''", 'Summary', 'working', 'History'])).toEqual(['Answer 1', 'Answer 2', 'Answer 3', 'Summary (2)', 'working (2)', 'History (2)']);
  });

  it('never starts or ends with an apostrophe and has no control characters', () => {
    const [name] = sheetNames(["'Quoted'\u0007"]);
    expect(name).toBe('Quoted');
  });
});

// ---------- formats and colours ----------

describe('number formats', () => {
  it('maps each value format', () => {
    expect(valueCell(1234.5, 'zar')).toEqual({ type: Number, value: 1234.5, format: '"R" #,##0.00' });
    expect(valueCell(12, 'integer')).toEqual({ type: Number, value: 12, format: '#,##0' });
    expect(valueCell(1.5, 'number')).toEqual({ type: Number, value: 1.5, format: '#,##0.00' });
    expect(valueCell(0.123, 'percent')).toEqual({ type: Number, value: 0.123, format: '0.0%' });
    expect(valueCell('2026-10-01', 'date')).toEqual({ type: Date, value: new Date(Date.UTC(2026, 9, 1)), format: NUMBER_FORMATS.date });
    expect(valueCell(2015, 'text')).toEqual({ type: String, value: '2015' });
    expect(valueCell(null, 'zar')).toBeNull();
    expect(valueCell('not a date', 'date')).toEqual({ type: String, value: 'not a date' });
  });

  it('a timestamp keeps its time', () => {
    expect(valueCell('2026-10-01T13:45:00', 'date')).toMatchObject({ type: Date, format: 'yyyy-mm-dd hh:mm' });
  });
});

describe('readable header text colour', () => {
  it.each([
    ['#1E7A5F', '#FFFFFF'],
    ['#FFFFFF', '#000000'],
    ['#000000', '#FFFFFF'],
    ['#FFD700', '#000000'],
    ['#E5E7EB', '#000000'],
    ['#003366', '#FFFFFF'],
  ])('%s -> %s', (fill, colour) => {
    expect(readableTextColor(fill)).toBe(colour);
  });
});

// ---------- the workbook ----------

describe('formula injection', () => {
  const hostile = ['=1+1', '+27 82 000 0000', '-5', '@SUM(A1:A2)', '=HYPERLINK("http://example.com","x")'];

  it('text beginning with =, +, - or @ is a plain string cell, never a formula, anywhere in the workbook', async () => {
    const b = block({
      title: '=SUM(1,2)',
      question: '=cmd|"/c calc"!A1',
      narrative: '@risk',
      sql: '-- not real',
      columns: [{ name: '=name', format: 'text' }, { name: 'n', format: 'text' }],
      rows: hostile.map((v) => ({ '=name': v, n: v })),
    });
    const buf = await buildReportXlsx(report([b], { title: '+title', notes: '=notes' }), OPTS);
    const parts = listEntries(buf)!.filter((e) => e.name.endsWith('.xml'));
    for (const p of parts) expect(entryText(buf, p.name)).not.toMatch(/<f[\s>]/);
    // Every hostile value comes back exactly as written, as text.
    const sheets = await readAll(buf);
    const answer = [...sheets.entries()].find(([n]) => n !== 'Summary' && n !== 'Working')![1];
    expect(answer.flat()).toEqual(expect.arrayContaining([...hostile, '=name', '=cmd|"/c calc"!A1', '@risk']));
    const sheetXml = entryText(buf, 'xl/worksheets/sheet2.xml');
    // Text cells are shared strings (t="s"); nothing hostile is ever written inline as a value or formula.
    expect(sheetXml).not.toContain('=1+1');
    // The heading went into the sheet name without the forbidden characters of a sheet name.
    expect(sheets.has('=SUM(1,2)')).toBe(true);
  });
});

describe('round trip through our own XLSX reader', () => {
  it('sheet list, Summary, values, the flagged warning and the Working sheet', async () => {
    const buf = await buildReportXlsx(report([SALES, FLAGGED, block({ title: 'Net sales by day' })]), OPTS);
    const sheets = await readAll(buf);
    expect([...sheets.keys()]).toEqual(['Summary', 'Net sales by day', 'Total by store', 'Net sales by day (2)', 'Working']);

    const summary = sheets.get('Summary')!;
    expect(summary[0]).toEqual(['October report']);
    expect(summary).toContainEqual(['Business', 'Padstal (Pty) Ltd']);
    expect(summary).toContainEqual(['Period', 'October 2026']);
    expect(summary).toContainEqual(['Generated', '2026-11-16 10:30 (SAST)']);
    expect(summary).toContainEqual(['Notes', 'Card sales only.']);
    expect(summary).toContainEqual([CAUTION]);
    expect(summary.flat()).not.toContain('Made with Analyst');

    const sales = sheets.get('Net sales by day')!;
    expect(sales[0]).toEqual(['Net sales by day']);
    expect(sales[1]).toEqual(['Question', 'What sold?']);
    expect(sales[2]).toEqual(['Answer', 'Café Rosé sold the most, at R 11 401,64.']);
    const head = sales.findIndex((r) => r[0] === 'day');
    expect(sales[head]).toEqual(['day', 'store', 'net', 'share', 'transactions']);
    // A real date, a ZAR amount, a percent stored as a fraction, an integer; a blank cell stays blank.
    expect(sales[head + 1]).toEqual(['2026-10-01', 'Café Rosé', '11401.64', '0.3436', '9']);
    expect(sales[head + 2]).toEqual(['2026-10-02', 'Padstal', '-1578.28', '0.1', '7']);
    expect(sales[head + 3]).toEqual(['', '', '0', '', '0']);
    expect(sales.flat()).not.toContain('Warning');

    const flagged = sheets.get('Total by store')!;
    expect(flagged).toContainEqual(['Warning', 'Needs a closer look: Total of net matches your file.']);

    const working = sheets.get('Working')!;
    expect(working[0]).toEqual(['Answer', 'SQL', 'Check', 'Result', 'Expected', 'Actual']);
    expect(working).toContainEqual(['', '', 'Total of net matches your file', 'Failed', '100', '99.5']);
    expect(working).toContainEqual(['Net sales by day', 'SELECT 1', 'Read-only query', 'Passed']);
  });

  it('number formats in styles.xml, and the date is stored as a serial number with a date format', async () => {
    const buf = await buildReportXlsx(report([SALES]), OPTS);
    const styles = entryText(buf, 'xl/styles.xml');
    for (const f of ['&quot;R&quot; #,##0.00', '0.0%', '#,##0', 'yyyy-mm-dd']) expect(styles).toContain(f);
    expect(openWorkbook(buf).dateStyles.size).toBeGreaterThan(0);
  });

  it('the watermark line on free', async () => {
    const sheets = await readAll(await buildReportXlsx(report([SALES], { watermark: true }), OPTS));
    expect(sheets.get('Summary')!).toContainEqual(['Made with Analyst']);
  });

  it('the header fill uses the brand colour only when branding is allowed, with readable text', async () => {
    const branded = entryText(await buildReportXlsx(report([SALES]), OPTS), 'xl/styles.xml');
    expect(branded).toMatch(/1E7A5F/i);
    expect(branded).toMatch(/FFFFFFFF|FFFFFF/i);
    const plain = entryText(await buildReportXlsx(report([SALES]), { ...OPTS, branding: false }), 'xl/styles.xml');
    expect(plain).not.toMatch(/1E7A5F/i);
    expect(plain).toMatch(/E5E7EB/i);
  });

  it('refuses a workbook above the cell cap with a clear error before building it', async () => {
    const columns = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, format: 'number' as const }));
    const rows = Array.from({ length: 500 }, () => Object.fromEntries(columns.map((c) => [c.name, 1])));
    const big = report(Array.from({ length: 30 }, (_, i) => block({ id: `b${i}`, title: `B${i}`, columns, rows })));
    await expect(buildReportXlsx(big, OPTS)).rejects.toBeInstanceOf(ExportTooLarge);
    expect(30 * 501 * 20).toBeGreaterThan(MAX_EXPORT_CELLS);
  });
});
