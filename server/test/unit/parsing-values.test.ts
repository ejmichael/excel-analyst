import { describe, expect, it } from 'vitest';
import { numericDateParts, parseDate } from '../../src/services/parsing/dates.js';
import { decimalVote, parseNumber } from '../../src/services/parsing/numbers.js';

describe('parseNumber', () => {
  it.each([
    ['1234.56', '.', '1234.56'],
    ['1 234,56', ',', '1234.56'],
    ['1 234,56', ',', '1234.56'],
    ['1.234,56', ',', '1234.56'],
    ['1,234.56', '.', '1234.56'],
    ["1'234.56", '.', '1234.56'],
    ['12 345 678,90', ',', '12345678.90'],
    ['0,5', ',', '0.5'],
    ['42', '.', '42'],
  ] as const)('%s with decimal %s is %s', (raw, dec, value) => {
    expect(parseNumber(raw, dec)?.value).toBe(value);
  });

  it.each([
    ['-12.50', '-12.50'],
    ['(12.50)', '-12.50'],
    ['12.50-', '-12.50'],
    ['12.50 DR', '-12.50'],
    ['12.50DR', '-12.50'],
    ['12.50 CR', '12.50'],
    ['−12.50', '-12.50'],
  ])('negative %s is %s', (raw, value) => {
    expect(parseNumber(raw, '.')?.value).toBe(value);
  });

  it('strips currency markers', () => {
    for (const raw of ['R1 234.50', 'R 1 234.50', 'ZAR 1234.50', 'ZAR1234.50', '-R 1 234.50']) {
      const n = parseNumber(raw, '.');
      expect(n?.currency, raw).toBe(true);
      expect(n?.value.replace('-', ''), raw).toBe('1234.50');
    }
    expect(parseNumber('-R 12.00', '.')?.value).toBe('-12.00');
  });

  it('turns percentages into fractions without floating point', () => {
    expect(parseNumber('12.5%', '.')).toMatchObject({ value: '0.125', percent: true, isInteger: false });
    expect(parseNumber('100%', '.')?.value).toBe('1');
    expect(parseNumber('7,25%', ',')?.value).toBe('0.0725');
  });

  it('marks integers, leading zeros and over-long numbers', () => {
    expect(parseNumber('42', '.')?.isInteger).toBe(true);
    expect(parseNumber('95.00', '.')?.isInteger).toBe(false);
    expect(parseNumber('0821234567', '.')?.leadingZero).toBe(true);
    expect(parseNumber('0', '.')?.leadingZero).toBe(false);
    expect(parseNumber('1234567890123456', '.')?.tooLong).toBe(true);
  });

  it('rejects things that are not numbers', () => {
    for (const raw of ['', 'abc', '12 34', '1,23,456', '082 555 8076', '07:19', '01/10/2026', 'T02', '#1001', '1.234.5', 'R', '12-34']) {
      expect(parseNumber(raw, '.'), raw).toBeNull();
    }
    expect(parseNumber('66,70', '.')).toBeNull();
    expect(parseNumber('1,234.56', ',')).toBeNull();
  });

  it('writes a negative zero as zero', () => {
    expect(parseNumber('-0.00', '.')?.value).toBe('0.00');
  });
});

describe('decimalVote', () => {
  it('votes only when a value reads one way', () => {
    expect(decimalVote('66,70')).toBe(',');
    expect(decimalVote('2 425,44')).toBe(',');
    expect(decimalVote('95.00')).toBe('.');
    expect(decimalVote('1,234.56')).toBe('.');
    expect(decimalVote('1,234')).toBeNull(); // thousands or decimal: ambiguous
    expect(decimalVote('42')).toBeNull();
    expect(decimalVote('hello')).toBeNull();
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-10-05', 'dmy', '2026-10-05'],
    ['2026/10/05', 'dmy', '2026-10-05'],
    ['05/10/2026', 'dmy', '2026-10-05'],
    ['05/10/2026', 'mdy', '2026-05-10'],
    ['5-10-2026', 'dmy', '2026-10-05'],
    ['05.10.2026', 'dmy', '2026-10-05'],
    ['5 Oct 2026', 'dmy', '2026-10-05'],
    ['05 October 2026', 'dmy', '2026-10-05'],
    ['5 Okt 2026', 'dmy', '2026-10-05'],
    ['12 Desember 2026', 'dmy', '2026-12-12'],
    ['2-Mrt-2026', 'dmy', '2026-03-02'],
  ] as const)('%s (%s) is %s', (raw, order, iso) => {
    expect(parseDate(raw, order)).toEqual({ kind: 'date', iso });
  });

  it('reads datetimes and converts offsets to SAST wall-clock time', () => {
    expect(parseDate('2026-10-01 07:29:13 +0200', 'dmy')).toEqual({ kind: 'datetime', iso: '2026-10-01T07:29:13' });
    expect(parseDate('2026-10-01T05:29:13Z', 'dmy')).toEqual({ kind: 'datetime', iso: '2026-10-01T07:29:13' });
    expect(parseDate('2026-10-31T23:30:00+00:00', 'dmy')).toEqual({ kind: 'datetime', iso: '2026-11-01T01:30:00' });
    expect(parseDate('01/10/2026 08:00', 'dmy')).toEqual({ kind: 'datetime', iso: '2026-10-01T08:00:00' });
  });

  it('rejects impossible dates and other shapes', () => {
    for (const raw of ['31/02/2026', '2026-13-01', '32/01/2026', '07:19', '20261005', '1/2/26', 'Total', '2026-10-05 25:00']) {
      expect(parseDate(raw, 'dmy'), raw).toBeNull();
    }
    expect(parseDate('13/01/2026', 'mdy')).toBeNull();
  });

  it("under 'ymd' only accepts year-first dates", () => {
    expect(parseDate('05/10/2026', 'ymd')).toBeNull();
    expect(parseDate('2026-10-05', 'ymd')).toEqual({ kind: 'date', iso: '2026-10-05' });
  });

  it('gives the two leading parts of numeric dates', () => {
    expect(numericDateParts('13/01/2026')).toEqual([13, 1]);
    expect(numericDateParts('2026-01-13')).toBeNull();
  });
});
