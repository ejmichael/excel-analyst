import { describe, expect, it } from 'vitest';
import { monthStartSast, monthStartSastInstant } from '../../src/services/dates.js';

describe('monthStartSast', () => {
  it('returns the first day of the month mid-month', () => {
    expect(monthStartSast(new Date('2026-11-15T10:00:00Z'))).toBe('2026-11-01');
  });

  it('treats 22:30 UTC on the last day as the 1st of the next month (SAST is UTC+2)', () => {
    expect(monthStartSast(new Date('2026-10-31T22:30:00Z'))).toBe('2026-11-01');
  });

  it('is still the previous month one minute before SAST midnight', () => {
    expect(monthStartSast(new Date('2026-10-31T21:59:00Z'))).toBe('2026-10-01');
  });

  it('switches exactly at SAST midnight', () => {
    expect(monthStartSast(new Date('2026-10-31T22:00:00Z'))).toBe('2026-11-01');
  });

  it('handles the year boundary', () => {
    expect(monthStartSast(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01');
    expect(monthStartSast(new Date('2026-12-31T21:59:59Z'))).toBe('2026-12-01');
  });

  it('handles a leap-year February', () => {
    expect(monthStartSast(new Date('2028-02-29T21:59:59Z'))).toBe('2028-02-01');
    expect(monthStartSast(new Date('2028-02-29T22:00:00Z'))).toBe('2028-03-01');
  });

  it('gives the instant with a +02:00 offset', () => {
    const instant = monthStartSastInstant(new Date('2026-10-31T22:30:00Z'));
    expect(instant).toBe('2026-11-01T00:00:00+02:00');
    expect(new Date(instant).toISOString()).toBe('2026-10-31T22:00:00.000Z');
  });
});
