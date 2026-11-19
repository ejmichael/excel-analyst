import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { firstRows, pageRowPositions, type PreviewColumn, type PreviewParams, rowsAt, sortColumn } from '../../src/services/preview.js';
import { withSandbox } from '../../src/services/sandbox/sandbox.js';

// A normalised CSV (header = sql_names) with a null amount, a null name and text that looks like SQL and wildcards.
const COLUMNS: PreviewColumn[] = [
  { sql_name: 'name', data_type: 'text' },
  { sql_name: 'amount', data_type: 'decimal' },
  { sql_name: 'day', data_type: 'date' },
];
const ROWS = [
  ['Tea', '5.5', '2026-10-03'],
  ['coffee', '', '2026-10-01'],
  ['CAKE', '7.25', '2026-10-02'],
  ['', '1', '2026-10-05'],
  ["50% off_today 'x'; DROP TABLE data; --", '3', ''],
  ['Teapot', '9', '2026-10-04'],
];
const csvOf = (rows: string[][]) =>
  Buffer.from(`name,amount,day\n${rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')}\n`);
const CSV = csvOf(ROWS);

async function page(p: Partial<PreviewParams>, columns = COLUMNS, csv = CSV) {
  const params: PreviewParams = { offset: 0, limit: 50, dir: 'asc', ...p };
  const { positions, matched } = await withSandbox({ csv, columns }, (s) => pageRowPositions(s, columns, params, 6));
  const rows = await rowsAt(csv, columns, positions);
  return { rows, matched, names: rows.map((r) => r.name) };
}

describe('preview: paging', () => {
  it('offset and limit page through the file in order, without overlap or gaps', async () => {
    const pages = [await page({ offset: 0, limit: 2 }), await page({ offset: 2, limit: 2 }), await page({ offset: 4, limit: 2 }), await page({ offset: 6, limit: 2 })];
    expect(pages.map((p) => p.names)).toEqual([['Tea', 'coffee'], ['CAKE', null], ["50% off_today 'x'; DROP TABLE data; --", 'Teapot'], []]);
    expect(pages.every((p) => p.matched === 6)).toBe(true);
  });

  it('values are typed exactly like the plain preview', async () => {
    const plain = await firstRows(CSV, COLUMNS, 6);
    expect((await page({ offset: 0, limit: 6, sort: 'name' })).rows).toEqual(expect.arrayContaining(plain));
    expect(plain[1]).toEqual({ name: 'coffee', amount: null, day: '2026-10-01' });
    expect(plain[0]).toEqual({ name: 'Tea', amount: 5.5, day: '2026-10-03' });
  });
});

describe('preview: sort', () => {
  it('ascending and descending, nulls last both ways, ties in file order', async () => {
    expect((await page({ sort: 'amount' })).rows.map((r) => r.amount)).toEqual([1, 3, 5.5, 7.25, 9, null]);
    expect((await page({ sort: 'amount', dir: 'desc' })).rows.map((r) => r.amount)).toEqual([9, 7.25, 5.5, 3, 1, null]);
    expect((await page({ sort: 'day', dir: 'desc' })).rows.map((r) => r.day)).toEqual(['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01', null]);
    expect((await page({ sort: 'name', dir: 'desc' })).names.at(-1)).toBeNull();
  });

  it('sorted pages are consistent', async () => {
    const all = (await page({ sort: 'amount' })).rows;
    const paged = [...(await page({ sort: 'amount', limit: 4 })).rows, ...(await page({ sort: 'amount', offset: 4, limit: 4 })).rows];
    expect(paged).toEqual(all);
  });

  it.each(['missing', 'Name', 'name"; DROP TABLE data; --', "name' OR 1=1", 'amount DESC'])('an unknown or hostile sort %j is 422 before anything runs', (sort) => {
    try {
      sortColumn(COLUMNS, sort);
      throw new Error('expected 422');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(422);
      expect((err as AppError).details).toMatchObject({ fields: [{ location: 'query', path: 'sort' }] });
    }
  });
});

describe('preview: search', () => {
  it('finds text case-insensitively in any text column and counts the matches', async () => {
    const r = await page({ q: 'TEA' });
    expect(r.names).toEqual(['Tea', 'Teapot']);
    expect(r.matched).toBe(2);
    expect((await page({ q: 'cake' })).names).toEqual(['CAKE']);
  });

  it('search and paging together: matched counts all matches, rows only the page', async () => {
    const r = await page({ q: 'e', limit: 1, offset: 1 });
    expect(r.matched).toBe(5);
    expect(r.rows).toHaveLength(1);
  });

  it.each([
    ['%', 1],
    ['_', 1],
    ["'", 1],
    ["'; DROP TABLE data; --", 1],
    ['50% off', 1],
    ['%%', 0],
    ['t_a', 0],
  ])('%j is plain text (%d match)', async (q, n) => {
    const r = await page({ q });
    expect(r.matched).toBe(n);
    // The table is still there afterwards.
    expect((await page({})).matched).toBe(6);
  });

  it('only text columns are searched; a file without text columns matches nothing', async () => {
    expect((await page({ q: '5.5' })).matched).toBe(0);
    const numbers: PreviewColumn[] = [{ sql_name: 'n', data_type: 'integer' }];
    const r = await page({ q: '1' }, numbers, Buffer.from('n\n1\n2\n'));
    expect(r).toMatchObject({ matched: 0, rows: [] });
  });
});
