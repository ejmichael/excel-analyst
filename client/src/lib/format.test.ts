import { describe, expect, it } from 'vitest';
import { formatBytes, formatCell, formatDate, formatNumber, formatPercent, formatZar } from './format';

describe('formatZar', () => {
  it('uses the en-ZA rand format', () => {
    // Compare with Intl itself: the space characters differ by runtime.
    const expected = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(1234.5);
    expect(formatZar(1234.5)).toBe(expected);
    expect(formatZar(1234.5)).toMatch(/^R/);
    expect(formatZar(1234.5)).toMatch(/,50$/);
  });
});

describe('formatPercent', () => {
  it('takes a fraction and shows one decimal', () => {
    expect(formatPercent(0.123)).toMatch(/^12,3\s?%$/);
    expect(formatPercent(0.5)).toMatch(/^50,0\s?%$/);
  });
});

describe('formatNumber', () => {
  it('uses en-ZA grouping and a decimal comma', () => {
    expect(formatNumber(1234567.891)).toBe(new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 2 }).format(1234567.891));
    expect(formatNumber(2.5)).toBe('2,5');
  });
});

describe('formatDate', () => {
  it('reads like 2 November 2026', () => {
    expect(formatDate('2026-11-02')).toBe('2 November 2026');
  });

  it('reads timestamps in SAST', () => {
    // 23:30 UTC on 1 November is already 2 November in Johannesburg.
    expect(formatDate('2026-11-01T23:30:00Z')).toBe('2 November 2026');
    expect(formatDate('2026-11-02T08:00:00+02:00')).toBe('2 November 2026');
  });
});

describe('formatBytes and formatCell', () => {
  it('formats sizes in en-ZA kB and MB', () => {
    expect(formatBytes(820)).toBe(new Intl.NumberFormat('en-ZA', { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 1 }).format(820 / 1024));
    expect(formatBytes(4.2 * 1024 * 1024)).toMatch(/^4,2\s?MB$/);
  });

  it('keeps every decimal the API sent, and reads dates in words', () => {
    expect(formatCell(1234.567, 'decimal')).toBe(new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 10 }).format(1234.567));
    expect(formatCell('2026-11-02', 'date')).toBe('2 November 2026');
    expect(formatCell(null)).toBe('');
    expect(formatCell(true)).toBe('Yes');
  });
});
