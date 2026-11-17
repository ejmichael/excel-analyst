import { describe, expect, it } from 'vitest';
import { documentVars } from './document';

describe('documentVars', () => {
  it('gives the report document its brand, mark colour and table tint', () => {
    expect(documentVars({ color: '#7A1E3C' })).toMatchObject({ '--brand': '#7A1E3C', '--brand-mark': '#7A1E3C', '--brand-tint': '#F3EBED', '--doc-series-1': '#7A1E3C' });
  });

  it('guards a very light brand for marks but keeps it for the top rule', () => {
    const vars = documentVars({ color: '#ffe066' }) as Record<string, string>;
    expect(vars['--brand']).toBe('#FFE066');
    expect(vars['--brand-mark']).not.toBe('#FFE066');
  });

  it('falls back to the app accent if the colour is not #RRGGBB', () => {
    expect((documentVars({ color: 'red' }) as Record<string, string>)['--brand']).toBe('#1E7A5F');
  });
});
