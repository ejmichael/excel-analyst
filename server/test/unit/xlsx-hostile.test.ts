import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { checkFileContent } from '../../src/services/parsing/content.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { ParseFailure, XLSX_MESSAGES } from '../../src/services/parsing/sources.js';
import { XLSX_LIMITS } from '../../src/services/parsing/xlsx.js';
import { buildZip, deflateRepeated, RELS_XML, sheetXml, WORKBOOK_XML, workbookZip } from './zipBuilder.js';

/**
 * Hostile workbooks. Each must end in a clear, user-safe failure, quickly and within bounded memory;
 * none may crash the process or expand entities.
 */

const MB = 1024 * 1024;
const DEFAULT_LIMITS = { ...XLSX_LIMITS };
afterEach(() => Object.assign(XLSX_LIMITS, DEFAULT_LIMITS));

const profileXlsx = (buffer: Buffer, maxRows = 200_000) => profileFile({ buffer, fileType: 'xlsx', options: {}, maxRows });

async function failure(p: Promise<unknown>): Promise<ParseFailure> {
  const err = await p.then(
    () => new Error('expected a failure'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ParseFailure);
  return err as ParseFailure;
}

function contentError(buf: Buffer): AppError {
  try {
    checkFileContent(buf);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected checkFileContent to reject');
}

describe('the test zip builder', () => {
  it('builds a workbook the reader accepts (so the hostile cases below fail for the right reason)', async () => {
    expect(checkFileContent(workbookZip())).toEqual({ fileType: 'xlsx', ext: 'xlsx' });
    const r = await profileXlsx(workbookZip());
    expect(r.rowCount).toBe(6);
    expect(r.columns.map((c) => [c.name, c.data_type])).toEqual([
      ['Item', 'text'],
      ['Amount', 'integer'],
    ]);
  });
});

describe('(a) zip bombs: total uncompressed size, entry count, real inflated bytes', () => {
  let bomb: Buffer; // ~600 MB of XML-ish bytes deflated to well under 1 MB

  beforeAll(async () => {
    // Whitespace is legal before the root element, so the XML parser keeps reading until the byte cap stops it.
    bomb = await deflateRepeated(' ', 600 * MB);
  }, 60_000);

  it('the bomb has a huge compression ratio', () => {
    expect(bomb.length).toBeLessThan(5 * MB);
    expect((600 * MB) / bomb.length).toBeGreaterThan(100);
  });

  it('an honest 600 MB sheet is rejected at upload from the zip directory alone (415), without inflating', () => {
    const zip = workbookZip({ sheet: { name: '', deflated: bomb, declaredSize: 600 * MB } });
    const started = Date.now();
    const err = contentError(zip);
    expect(err.status).toBe(415);
    expect(err.message).toBe(XLSX_MESSAGES.too_large);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a sheet that lies about its size is stopped by counting real inflated bytes', async () => {
    // Declares 1 KB, so the directory checks pass; inflating it would give 600 MB.
    const zip = workbookZip({ sheet: { name: '', deflated: bomb, declaredSize: 1024 } });
    expect(checkFileContent(zip).fileType).toBe('xlsx');
    XLSX_LIMITS.maxSheetXml = 20 * MB; // same code path as the 500 MB default, without inflating 500 MB in a unit test
    const before = process.memoryUsage().rss;
    const err = await failure(profileXlsx(zip));
    expect(err.message).toBe(XLSX_MESSAGES.too_large);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * MB);
  });

  it('a small part (styles.xml) that lies about its size is stopped at its own 10 MB cap', async () => {
    const styles = await deflateRepeated('<numFmt numFmtId="1"/>', 40 * MB);
    const err = await failure(profileXlsx(workbookZip({ styles: { name: '', deflated: styles, declaredSize: 100 } })));
    expect(err.message).toBe(XLSX_MESSAGES.too_large);
  });

  it('more than 10 000 zip entries is rejected at upload (415)', () => {
    const parts = [
      { name: 'xl/workbook.xml', data: WORKBOOK_XML },
      { name: 'xl/_rels/workbook.xml.rels', data: RELS_XML },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(2) },
      ...Array.from({ length: XLSX_LIMITS.maxEntries }, (_, i) => ({ name: `xl/media/x${i}.bin`, data: 'x' })),
    ];
    const err = contentError(buildZip(parts));
    expect(err.status).toBe(415);
    expect(err.message).toBe(XLSX_MESSAGES.too_many_parts);
  });
});

describe('(b) per-part size caps', () => {
  it('a shared-strings part above its cap is rejected', async () => {
    XLSX_LIMITS.maxSharedStringsXml = 1 * MB;
    const big = `<sst>${'<si><t>abcdefghij</t></si>'.repeat(60_000)}</sst>`; // ~1.5 MB
    const err = await failure(profileXlsx(workbookZip({ sharedStrings: big })));
    expect(err.message).toBe(XLSX_MESSAGES.too_large);
  });

  it('too many shared strings is rejected', async () => {
    XLSX_LIMITS.maxSharedStrings = 3;
    const sst = `<sst>${'<si><t>x</t></si>'.repeat(4)}</sst>`;
    expect((await failure(profileXlsx(workbookZip({ sharedStrings: sst })))).message).toBe(XLSX_MESSAGES.too_large);
  });
});

describe('(c) no DTD and no entity expansion', () => {
  const laughs = [
    '<!DOCTYPE lolz [',
    '<!ENTITY lol "lol">',
    ...Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i || ''};`.repeat(10)}">`),
    ']>',
  ].join('\n');

  it('an entity bomb in workbook.xml is refused before any expansion', async () => {
    const workbook = WORKBOOK_XML.replace('<workbook', `${laughs}\n<workbook`).replace('name="Data"', 'name="&lol9;"');
    const started = Date.now();
    const err = await failure(profileXlsx(workbookZip({ workbook })));
    expect(err.message).toBe(XLSX_MESSAGES.unsafe);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('an entity bomb in a sheet is refused', async () => {
    const sheet = sheetXml(3, `${laughs}\n`).replace('<t>Thing 0</t>', '<t>&lol9;</t>');
    expect((await failure(profileXlsx(workbookZip({ sheet })))).message).toBe(XLSX_MESSAGES.unsafe);
  });

  it('an external entity is refused and never fetched', async () => {
    const xxe = '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n';
    const sheet = sheetXml(3, xxe).replace('<t>Thing 0</t>', '<t>&xxe;</t>');
    expect((await failure(profileXlsx(workbookZip({ sheet })))).message).toBe(XLSX_MESSAGES.unsafe);
    const sst = `${xxe}<sst><si><t>&xxe;</t></si></sst>`;
    expect((await failure(profileXlsx(workbookZip({ sharedStrings: sst })))).message).toBe(XLSX_MESSAGES.unsafe);
  });

  it('an undeclared entity (no DTD) is a damaged file, not a crash', async () => {
    const sheet = sheetXml(3).replace('<t>Thing 0</t>', '<t>&nope;</t>');
    expect((await failure(profileXlsx(workbookZip({ sheet })))).message).toBe(XLSX_MESSAGES.damaged);
  });
});

describe('(d) rows and cells', () => {
  it("a sheet with more data rows than the plan's max_rows fails with the plan message and details", async () => {
    const err = await failure(profileXlsx(workbookZip({ sheet: sheetXml(30) }), 10));
    expect(err.message).toBe('Your plan allows 10 rows; this file has 30.');
    expect(err.limit).toEqual({ limit_key: 'max_rows', limit: 10, used: 30 });
  });

  it('cells beyond the per-pass cap are refused', async () => {
    XLSX_LIMITS.maxCellsPerPass = 50;
    expect((await failure(profileXlsx(workbookZip({ sheet: sheetXml(40) })))).message).toBe(XLSX_MESSAGES.too_many_cells);
  });

  it('a row number beyond 2 000 000 is refused', async () => {
    const sheet = sheetXml(2).replace('</sheetData>', '<row r="2000001"><c r="A2000001"><v>1</v></c></row></sheetData>');
    expect((await failure(profileXlsx(workbookZip({ sheet })))).message).toBe(XLSX_MESSAGES.too_many_cells);
  });

  it('a cell beyond column 500 is refused', async () => {
    const sheet = sheetXml(2).replace('</sheetData>', '<row r="9"><c r="ZZ9"><v>1</v></c></row></sheetData>');
    expect((await failure(profileXlsx(workbookZip({ sheet })))).message).toBe(XLSX_MESSAGES.too_many_columns);
  });
});

describe('a .xlsx that is not a zip', () => {
  it('a PNG renamed .xlsx is 415', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0)]);
    expect(contentError(png).status).toBe(415);
  });

  it('bytes that start like a zip but have no directory are 415', () => {
    const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]);
    const err = contentError(fake);
    expect(err.status).toBe(415);
    expect(err.message).toMatch(/not an Excel workbook/);
  });

  it('a truncated workbook is 415', () => {
    const zip = workbookZip();
    expect(contentError(zip.subarray(0, zip.length - 30)).status).toBe(415);
  });

  it('a CSV renamed .xlsx is read as the CSV it is (the type comes from the bytes, not the name)', () => {
    expect(checkFileContent(Buffer.from('Item,Amount\nTea,5\nCoffee,6\n'))).toEqual({ fileType: 'csv', ext: 'csv' });
  });

  it('the XLSX reader itself also refuses a non-zip buffer cleanly', async () => {
    expect((await failure(profileXlsx(Buffer.from('Item,Amount\nTea,5\n')))).message).toBe(XLSX_MESSAGES.damaged);
  });
});
