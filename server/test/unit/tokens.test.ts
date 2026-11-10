import { describe, expect, it } from 'vitest';
import { EMPTY_VALUE, formatValue, freeStandingNumbers, MAX_TOKENS, renderNarrative, UNRESOLVED } from '../../src/services/analysis/tokens.js';

// Intl en-ZA output uses no-break spaces as group separators; compare with them normalised.
const norm = (s: string) => s.replace(/[  ]/g, ' ');

const rows = [
  { store: 'Café Rosé', net: 90501.94, share: 0.3239, n: 1234, d: '2026-11-02', ts: '2026-10-01T07:00:00', none: null },
  { store: 'Padstal', net: 99284.58, share: 0.3554, n: 7, d: '2026-10-01', ts: null, none: null },
];
const valueFormat = { store: 'text', net: 'zar', share: 'percent', n: 'integer', d: 'date', ts: 'date', none: 'number' } as const;
const render = (template: string, rowCount = 2) => renderNarrative({ template, rows, rowCount, valueFormat: { ...valueFormat } });

describe('formatValue (en-ZA, Intl)', () => {
  it('formats each ValueFormat', () => {
    expect(norm(formatValue(1234.56, 'zar')!)).toBe('R 1 234,56');
    expect(norm(formatValue(1234567, 'integer')!)).toBe('1 234 567');
    expect(norm(formatValue(1234.5678, 'number')!)).toBe('1 234,57');
    expect(formatValue(0.123, 'percent')).toBe('12,3%');
    expect(formatValue('2026-11-02', 'date')).toBe('2 November 2026');
    expect(formatValue('2026-10-01T07:00:00', 'date')).toBe('1 October 2026');
    expect(formatValue('Café', 'text')).toBe('Café');
    expect(formatValue(null, 'zar')).toBe(EMPTY_VALUE);
  });

  it('refuses values that cannot be shown in the format', () => {
    expect(formatValue('abc', 'zar')).toBeNull();
    expect(formatValue('not a date', 'date')).toBeNull();
  });
});

describe('renderNarrative and numbers_from_data', () => {
  it('fills tokens from the rows and the true row count', () => {
    const r = render('{{r1.store}} led with {{r1.net}} ({{r1.share}} of sales) across {{rows}} stores on {{r0.d}}.', 1234);
    expect(r.ok).toBe(true);
    expect(norm(r.text)).toBe('Padstal led with R 99 284,58 (35,5% of sales) across 1 234 stores on 2 November 2026.');
    expect(r.tokenCount).toBe(5);
  });

  it('accepts whitespace inside tokens and a NULL cell', () => {
    const r = render('{{ r0.store }} had {{r0.none}}.');
    expect(r.ok).toBe(true);
    expect(r.text).toBe(`Café Rosé had ${EMPTY_VALUE}.`);
  });

  it('fails on an unknown token, a missing row, and a missing column, replacing them with [?]', () => {
    const r = render('{{total}} and {{r5.net}} and {{r0.profit}} and {{r50.net}}.');
    expect(r.ok).toBe(false);
    expect(r.text).toBe(`${UNRESOLVED} and ${UNRESOLVED} and ${UNRESOLVED} and ${UNRESOLVED}.`);
    expect(r.problems).toHaveLength(4);
  });

  it('fails on more than 40 tokens', () => {
    const r = render(Array.from({ length: MAX_TOKENS + 1 }, () => '{{r0.store}}').join(' '));
    expect(r.ok).toBe(false);
    expect(r.problems).toContain(`more than ${MAX_TOKENS} tokens`);
    expect(render(Array.from({ length: MAX_TOKENS }, () => '{{r0.store}}').join(' ')).ok).toBe(true);
  });

  it('fails on free-standing numbers of two or more digits, but allows years 1990-2099 and single digits', () => {
    expect(freeStandingNumbers('Sales rose 12% to R 1 500 in 2026, from 3 stores in 1989 and 2100.')).toEqual(['12', '1', '500', '1989', '2100'].filter((n) => n.length > 1));
    const r = render('Sales were 1,234.56 in 2026 across 3 stores, {{r0.store}} first.');
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('"1,234.56"');
    expect(r.text).toContain('1,234.56'); // left in place
    expect(render('In 2026 {{r0.store}} led; 3 stores reported.').ok).toBe(true);
  });

  it('checks the template, so numbers produced by tokens never count as free-standing', () => {
    expect(render('{{r0.n}} sales.').ok).toBe(true);
  });
});
