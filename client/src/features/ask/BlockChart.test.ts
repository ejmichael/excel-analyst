import { describe, expect, it } from 'vitest';
import { LABEL_EVERY_BAR_UP_TO, categoryInterval, categoryLabelMax } from './BlockChart';
import { shortLabel } from './chartData';

describe('category labels on a vertical bar chart', () => {
  it('labels every bar on a short bar chart, and lets dense axes skip labels', () => {
    // Fees by card type on a phone: three bars, and the middle one (MASTERCARD) lost its label before.
    expect(categoryInterval('bar', 3)).toBe(0);
    expect(categoryInterval('bar', LABEL_EVERY_BAR_UP_TO)).toBe(0);
    expect(categoryInterval('bar', LABEL_EVERY_BAR_UP_TO + 1)).toBe('preserveStartEnd');
    expect(categoryInterval('line', 3)).toBe('preserveStartEnd');
    expect(categoryInterval('area', 31)).toBe('preserveStartEnd');
  });

  it('shortens a label to fit its bar, keeping at least 4 and at most 14 characters', () => {
    // A 390px phone leaves about 190px of axis in a report card for three bars.
    expect(shortLabel('MASTERCARD', categoryLabelMax(190, 3))).toBe('MASTERC…');
    expect(shortLabel('DEBIT', categoryLabelMax(190, 3))).toBe('DEBIT');
    expect(categoryLabelMax(2000, 2)).toBe(14);
    expect(categoryLabelMax(100, 8)).toBe(4);
    expect(categoryLabelMax(undefined, 3)).toBe(14);
  });
});
