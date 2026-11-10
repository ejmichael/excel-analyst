import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { checkFileContent } from '../../src/services/parsing/content.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { isDateFormat, serialToString } from '../../src/services/parsing/xlsx.js';

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Two sheets: notes, and the data sheet with a title, a merged header, formulas and real dates. */
const salesWorkbook = () =>
  workbook((wb) => {
    const notes = wb.addWorksheet('Notes');
    notes.addRow(['This workbook is synthetic test data']);
    notes.addRow(['Prepared for tests', 42]);
    const s = wb.addWorksheet('Sales');
    s.addRow(['October sales (synthetic)']);
    s.addRow([]);
    s.addRow(['Date', 'Amount', null, 'Store']);
    s.mergeCells('B3:C3'); // a merged header over two columns
    for (let i = 0; i < 8; i++) {
      const r = s.addRow([new Date(Date.UTC(2026, 9, i + 1)), 100 + i, { formula: `B${i + 4}*0.15`, result: (100 + i) * 0.15 }, `Shop ${i % 2}`]);
      r.getCell(1).numFmt = 'dd/mm/yyyy';
    }
    s.addRow(['Total', { formula: 'SUM(B4:B11)', result: 828 }, null, null]);
  });

async function failsWith(buf: Buffer, status: number) {
  try {
    checkFileContent(buf);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(status);
    return (err as AppError).message;
  }
  throw new Error('expected an error');
}

describe('XLSX profiling', () => {
  it('picks the sheet with the most numbers, repeats merged headers, uses cached formula values and real dates', async () => {
    const r = await profileFile({ buffer: await salesWorkbook(), fileType: 'xlsx', options: {}, maxRows: 1000 });
    expect(r.sheetNames).toEqual(['Notes', 'Sales']);
    expect(r.parseOptions.sheet_name).toBe('Sales');
    expect(r.parseOptions.header_row).toBe(3);
    expect(r.preambleLines).toEqual(['October sales (synthetic)']);
    expect(r.columns.map((c) => c.name)).toEqual(['Date', 'Amount', 'Amount_2', 'Store']);
    expect(r.columns.map((c) => c.data_type)).toEqual(['date', 'integer', 'decimal', 'text']);
    expect(r.rowCount).toBe(8);
    expect(r.excludedRows).toBe(1); // the Total row
    expect(r.columns[0]).toMatchObject({ min_value: '2026-10-01', max_value: '2026-10-08' });
    expect(r.columns[2]!.max_value).toBe('16.05');
    expect(r.warnings.some((w) => w.includes('"Sales"'))).toBe(true);
  });

  it('honours a sheet_name override', async () => {
    const r = await profileFile({ buffer: await salesWorkbook(), fileType: 'xlsx', options: { sheet_name: 'Notes' }, maxRows: 1000 });
    expect(r.parseOptions.sheet_name).toBe('Notes');
    expect(r.rowCount).toBe(1);
    expect(r.warnings.some((w) => w.includes('sheets'))).toBe(false); // no "we picked a sheet" note when the user chose
  });

  it('fails safely for a sheet that does not exist', async () => {
    await expect(
      profileFile({ buffer: await salesWorkbook(), fileType: 'xlsx', options: { sheet_name: 'Nope' }, maxRows: 1000 }),
    ).rejects.toThrow('There is no sheet called "Nope" in this workbook.');
  });
});

describe('XLSX values', () => {
  it('recognises date number formats', () => {
    for (const code of ['dd/mm/yyyy', 'yyyy-mm-dd hh:mm', '[$-1C09]d mmmm yyyy', 'm/d/yy']) expect(isDateFormat(code), code).toBe(true);
    for (const code of ['General', '0.00', '#,##0.00 "items"', '[Red]0.00', '"R" #,##0.00']) expect(isDateFormat(code), code).toBe(false);
  });

  it('converts serials in both date systems', () => {
    expect(serialToString(46300, false)).toBe('2026-10-05');
    expect(serialToString(46300.5, false)).toBe('2026-10-05T12:00:00');
    expect(serialToString(0.3076388889, false)).toBe('07:23:00');
    expect(serialToString(46300 - 1462, true)).toBe('2026-10-05');
  });

  it('reads workbooks whose sheets come before workbook.xml in the zip (no temp files)', async () => {
    // exceljs writes worksheets before xl/workbook.xml; Excel writes sharedStrings after the sheets.
    const buf = await salesWorkbook();
    const order = (name: string) => buf.indexOf(Buffer.from(name));
    expect(order('xl/worksheets/sheet2.xml')).toBeLessThan(order('xl/workbook.xml'));
    const r = await profileFile({ buffer: buf, fileType: 'xlsx', options: {}, maxRows: 1000 });
    expect(r.rowCount).toBe(8);
  });
});

describe('checkFileContent (by bytes, never by name)', () => {
  it('accepts CSV text and real XLSX', async () => {
    expect(checkFileContent(Buffer.from('a,b\n1,2\n3,4\n'))).toEqual({ fileType: 'csv', ext: 'csv' });
    expect(checkFileContent(Buffer.from('a;b\n1,5;2\n'))).toEqual({ fileType: 'csv', ext: 'csv' });
    expect(checkFileContent(await salesWorkbook())).toEqual({ fileType: 'xlsx', ext: 'xlsx' });
  });

  it('rejects a PNG', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from('IHDR')]);
    await failsWith(png, 415);
  });

  it('rejects a legacy .xls', async () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    expect(await failsWith(xls, 415)).toMatch(/\.xls/);
  });

  it('rejects a zip that is not a workbook', async () => {
    const wb = await salesWorkbook();
    // Rename the workbook entry so the zip no longer contains xl/workbook.xml.
    const renamed = Buffer.from(wb.toString('latin1').split('xl/workbook.xml').join('xl/notebook.xml'), 'latin1');
    await failsWith(renamed, 415);
  });

  it('rejects UTF-16, empty files and text without columns', async () => {
    await failsWith(Buffer.from('﻿a,b\n1,2', 'utf16le'), 415);
    await failsWith(Buffer.alloc(0), 415);
    await failsWith(Buffer.from('just a sentence\nand another one\n'), 415);
  });
});
