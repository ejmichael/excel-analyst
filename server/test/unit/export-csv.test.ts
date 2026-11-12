import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell } from '../../src/routes/blocks.js';

describe('CSV export body', () => {
  it('keeps a row whose group key is null, as an empty cell under the header (bug 2026-11-12)', () => {
    const rows = [
      { title: null, contacts: 3 },
      { title: 'Manager', contacts: 2 },
      { title: '', contacts: 1 },
    ];
    expect(buildCsv(['title', 'contacts'], rows)).toBe('title,contacts\r\n,3\r\nManager,2\r\n,1\r\n');
  });

  it('a null numeric key is an empty cell too, and a missing property counts as null', () => {
    expect(buildCsv(['branch', 'n'], [{ branch: null, n: 3 }, { n: 2 } as never, { branch: 1, n: 2 }])).toBe('branch,n\r\n,3\r\n,2\r\n1,2\r\n');
  });

  it('cells: formulas are neutralised, numbers stay numbers, quotes are escaped', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
  });
});
