import { describe, expect, it } from 'vitest';
import { autoReportBody, tooFewAnswered } from '../../src/services/autoReport.js';

describe('AutoReportRequest validation', () => {
  it('accepts an empty body (title defaults to the file name later)', () => {
    expect(autoReportBody.safeParse({})).toMatchObject({ success: true, data: {} });
  });

  it('trims, and stores an empty period_label as null', () => {
    expect(autoReportBody.parse({ title: '  October  ', period_label: '   ' })).toEqual({ title: 'October', period_label: null });
  });

  it.each([
    ['an empty title', { title: '  ' }],
    ['a title of 121 characters', { title: 'x'.repeat(121) }],
    ['a period_label of 61 characters', { period_label: 'x'.repeat(61) }],
    ['an unknown field', { subtitle: 'no' }],
    ['a null title', { title: null }],
  ])('refuses %s', (_name, body) => {
    expect(autoReportBody.safeParse(body).success).toBe(false);
  });

  it('accepts the limits exactly', () => {
    expect(autoReportBody.safeParse({ title: 'x'.repeat(120), period_label: 'x'.repeat(60) }).success).toBe(true);
  });
});

describe('the too-few-answers message', () => {
  it('names both counts and points to asking your own questions', () => {
    expect(tooFewAnswered(2, 5)).toBe('We could only answer 2 of the 5 questions for this file. Try asking your own questions.');
  });
});
