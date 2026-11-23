import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { errorWarnings, isSpreadsheetError } from '../../src/services/parsing/spreadsheetErrors.js';

const csvProfile = (text: string) => profileFile({ buffer: Buffer.from(text), fileType: 'csv', options: {}, maxRows: 100_000 });
const colOf = (p: Awaited<ReturnType<typeof csvProfile>>, name: string) => p.columns.find((c) => c.sql_name === name)!;
const rowsOf = (p: Awaited<ReturnType<typeof csvProfile>>) => parse(p.normalisedCsv, { columns: true }) as Array<Record<string, string>>;

describe('spreadsheet error values', () => {
  it.each(['#ERROR!', '#N/A', '#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NULL!', '#NUM!', '#SPILL!', '#CALC!', '#GETTING_DATA', '  #error! ', '#n/a'])('%j is an error', (v) => {
    expect(isSpreadsheetError(v)).toBe(true);
  });
  it.each(['#1 seller', 'ERROR', '#', 'N/A', '#hashtag', '0821234567'])('%j is a value', (v) => {
    expect(isSpreadsheetError(v)).toBe(false);
  });
});

describe('CSV: error text is read as empty and counted', () => {
  // 10 rows. Phone: 7 errors and 3 numbers. Broken: an error in every row. Amount: numbers and one #N/A.
  const rows = Array.from({ length: 10 }, (_, i) => [
    `Biz ${i + 1}`,
    i < 7 ? '#ERROR!' : `08212345${String(i).padStart(2, '0')}`,
    i % 2 ? '#REF!' : '#DIV/0!',
    i === 4 ? '#N/A' : (100 + i * 2.5).toFixed(2),
  ]);
  const CSV = `Business,Phone,Broken,Amount\n${rows.map((r) => r.join(',')).join('\n')}\n`;

  it('the cells are empty in the normalised file and in the stats', async () => {
    const p = await csvProfile(CSV);
    const data = rowsOf(p);
    expect(data.filter((r) => r.phone === '')).toHaveLength(7);
    expect(data.every((r) => !Object.values(r).some((v) => v.includes('#')))).toBe(true);
    expect(colOf(p, 'phone')).toMatchObject({ null_count: 7, distinct_count: 3 });
    expect(colOf(p, 'phone').samples.some((s) => s.includes('#'))).toBe(false);
  });

  it('a column that is all errors becomes an empty column', async () => {
    expect(colOf(await csvProfile(CSV), 'broken')).toMatchObject({ null_count: 10, distinct_count: 0, min_value: null, max_value: null });
  });

  it('type detection is unchanged for the rest of the column', async () => {
    const p = await csvProfile(CSV);
    expect(colOf(p, 'amount')).toMatchObject({ data_type: 'decimal', null_count: 1, min_value: '100.00', max_value: '122.50' });
    // Without the error the column has the same type.
    const clean = await csvProfile(CSV.replace('#N/A', '110.00'));
    expect(colOf(clean, 'amount').data_type).toBe('decimal');
  });

  it('one warning per affected column, with the count', async () => {
    const w = (await csvProfile(CSV)).warnings;
    expect(w).toContain('Phone: 7 cells held a spreadsheet error such as #ERROR! and were read as empty.');
    expect(w).toContain('Broken: 10 cells held a spreadsheet error such as #ERROR! and were read as empty.');
    expect(w).toContain('Amount: 1 cell held a spreadsheet error such as #ERROR! and was read as empty.');
    expect(w.filter((x) => x.includes('spreadsheet error'))).toHaveLength(3);
  });

  it('at most 5 column lines, then one line for the rest', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    expect(errorWarnings(names, [1, 2, 3, 4, 5, 6, 7])).toEqual([
      'A: 1 cell held a spreadsheet error such as #ERROR! and was read as empty.',
      'B: 2 cells held a spreadsheet error such as #ERROR! and were read as empty.',
      'C: 3 cells held a spreadsheet error such as #ERROR! and were read as empty.',
      'D: 4 cells held a spreadsheet error such as #ERROR! and were read as empty.',
      'E: 5 cells held a spreadsheet error such as #ERROR! and were read as empty.',
      'and 2 more columns also held spreadsheet errors.',
    ]);
    expect(errorWarnings(['A'], [0])).toEqual([]);
  });

  it('a file with no errors gets no such warning', async () => {
    expect((await csvProfile('A,B\n1,x\n2,y\n')).warnings.some((x) => x.includes('spreadsheet error'))).toBe(false);
  });
});

describe('XLSX: error-type cells and error text', () => {
  async function workbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leads');
    ws.addRow(['Business', 'Phone', 'Score']);
    for (let i = 0; i < 8; i++) {
      ws.addRow([
        `Biz ${i + 1}`,
        // 5 formula errors stored as error-type cells, one as text, two numbers.
        i < 5 ? { formula: 'A1/0', result: { error: i % 2 ? '#DIV/0!' : '#N/A' } } : i === 5 ? '#ERROR!' : 821234560 + i,
        i === 7 ? { formula: 'B1+1', result: { error: '#VALUE!' } } : 10 + i,
      ]);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('error cells are empty and counted, and the rest of the column keeps its type', async () => {
    const p = await profileFile({ buffer: await workbook(), fileType: 'xlsx', options: {}, maxRows: 100_000 });
    const data = rowsOf(p);
    expect(data.filter((r) => r.phone === '')).toHaveLength(6);
    expect(data.every((r) => !Object.values(r).some((v) => v.includes('#')))).toBe(true);
    expect(colOf(p, 'phone')).toMatchObject({ null_count: 6, distinct_count: 2 });
    expect(colOf(p, 'score')).toMatchObject({ data_type: 'integer', null_count: 1, min_value: '10', max_value: '16' });
    expect(p.warnings).toContain('Phone: 6 cells held a spreadsheet error such as #ERROR! and were read as empty.');
    expect(p.warnings).toContain('Score: 1 cell held a spreadsheet error such as #ERROR! and was read as empty.');
  });
});
