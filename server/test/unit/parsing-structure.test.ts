import { describe, expect, it } from 'vitest';
import { detectDelimiter } from '../../src/services/parsing/delimiter.js';
import { decodeChunks, decodeHead, detectEncoding } from '../../src/services/parsing/encoding.js';
import { cleanHeaders, toSqlName, toSqlNames } from '../../src/services/parsing/headers.js';
import { findHeaderRow, isTotalRow } from '../../src/services/parsing/layout.js';
import { RESERVED_WORDS } from '../../src/services/parsing/reservedWords.js';
import type { Row } from '../../src/services/parsing/sources.js';

describe('encoding', () => {
  it('detects UTF-8 with and without BOM, else Windows-1252', () => {
    expect(detectEncoding(Buffer.from('Café', 'utf8'))).toBe('utf-8');
    expect(detectEncoding(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b', 'utf8')]))).toBe('utf-8');
    expect(detectEncoding(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('windows-1252'); // "Caf\xe9"
  });

  it('strips the BOM and decodes Windows-1252 accents', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Order ID,x', 'utf8')]);
    expect([...decodeChunks(bom, 'utf-8')].join('')).toBe('Order ID,x');
    expect(decodeHead(Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]), 'windows-1252')).toBe('Müller');
  });

  it('decodes multi-byte characters split across chunks', () => {
    const text = 'é'.repeat(700_000); // 1.4 MB: crosses the 1 MB chunk boundary mid-character
    expect([...decodeChunks(Buffer.from(text, 'utf8'), 'utf-8')].join('')).toBe(text);
  });
});

describe('detectDelimiter', () => {
  it('prefers semicolons when amounts contain commas', () => {
    const sample = ['Title line', '', 'Date;Store;Amount;Fee', ...Array.from({ length: 10 }, (_, i) => `0${i % 9 + 1}/10/2026;Shop;1 234,5${i};3,40`)].join('\n');
    expect(detectDelimiter(sample)).toBe(';');
  });

  it('handles quoted commas, tabs and pipes', () => {
    expect(detectDelimiter('a,b,c\n"1,5",2,3\n"4,5",5,6')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n4\t5\t6')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3\n4|5|6')).toBe('|');
  });

  it('returns null for text without columns', () => {
    expect(detectDelimiter('just some words\nand more words\n')).toBeNull();
  });
});

describe('headers and sql names', () => {
  it('makes lower snake_case ASCII names', () => {
    expect(toSqlName('Transaction Date', 1)).toBe('transaction_date');
    expect(toSqlName('Müller Bakkery', 1)).toBe('muller_bakkery');
    expect(toSqlName('  Net  Amount (ZAR) ', 1)).toBe('net_amount_zar');
    expect(toSqlName('Order #', 1)).toBe('order_no');
    expect(toSqlName('VAT %', 1)).toBe('vat_pct');
  });

  it('never starts with a digit and never is empty', () => {
    expect(toSqlName('2026 Sales', 1)).toBe('col_2026_sales');
    expect(toSqlName('!!!', 7)).toBe('column_7');
  });

  it('appends _col to every reserved word', () => {
    for (const word of RESERVED_WORDS) expect(toSqlName(word, 1)).toBe(`${word}_col`);
    expect(toSqlName('Date', 1)).toBe('date_col');
    expect(toSqlName('Order', 1)).toBe('order_col');
  });

  it('keeps a conservative keyword list including the sandbox table name', () => {
    for (const word of ['select', 'from', 'where', 'group', 'order', 'by', 'date', 'time', 'table', 'data', 'limit', 'join', 'union', 'drop']) {
      expect(RESERVED_WORDS.has(word), word).toBe(true);
    }
    for (const word of RESERVED_WORDS) expect(word).toMatch(/^[a-z_]+$/);
  });

  it('makes names unique', () => {
    expect(toSqlNames(['Amount', 'amount', 'AMOUNT', 'Amount 2'])).toEqual(['amount', 'amount_2', 'amount_3', 'amount_2_2']);
  });

  it('renames empty and duplicate headers', () => {
    expect(cleanHeaders(['Amount', '', 'Amount', ' Fee '])).toEqual({ names: ['Amount', 'Column_2', 'Amount_2', 'Fee'], renamed: 2 });
  });
});

const rows = (lines: string[][]): Row[] => lines.map((cells, i) => ({ n: i + 1, cells }));

describe('findHeaderRow', () => {
  const data = Array.from({ length: 6 }, (_, i) => [`0${i + 1}/10/2026`, 'Shop', `${100 + i}.50`]);

  it('skips preamble lines', () => {
    const head = rows([['Sales report'], ['Period: Oct'], [''], ['Date', 'Store', 'Amount'], ...data]);
    expect(findHeaderRow(head)?.n).toBe(4);
  });

  it('does not take a two-cell title row above wider data', () => {
    const head = rows([['Account', 'Business cheque'], ['Date', 'Store', 'Amount'], ...data]);
    expect(findHeaderRow(head)?.n).toBe(2);
  });

  it('accepts a small file with fewer than five data rows', () => {
    expect(findHeaderRow(rows([['Date', 'Amount'], ['01/10/2026', '5']]))?.n).toBe(1);
  });

  it('returns null when no row looks like a header', () => {
    expect(findHeaderRow(rows(Array.from({ length: 8 }, () => ['1', '2', '3'])))).toBeNull();
  });
});

describe('isTotalRow', () => {
  it('matches total, totals, grand total and sub total in the first non-empty cell', () => {
    for (const cells of [['Total', '', '5'], ['', 'Totals', '5'], ['Grand total:', '5'], ['SUB-TOTAL', '1'], ['Subtotal', '1']]) {
      expect(isTotalRow(cells), cells.join('|')).toBe(true);
    }
    expect(isTotalRow(['Total sales for October', '5'])).toBe(false);
    expect(isTotalRow(['01/10/2026', 'Total'])).toBe(false);
  });
});
