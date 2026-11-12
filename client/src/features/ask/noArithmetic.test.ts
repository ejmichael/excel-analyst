import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Product rule 1 on the client: every figure comes from the API. No answer component may compute a sum,
 * average, share, percentage change or any other figure. The only arithmetic on answer values is the
 * percent display scaling (`* 100`) inside lib/format.ts. Layout maths (chart heights, timers) is allowed.
 */
const ANSWER_FILES = [
  'chartData.ts',
  'BlockChart.tsx',
  'ResultTable.tsx',
  'AnswerCard.tsx',
  'AnswerHistory.tsx',
  'HowCalculated.tsx',
  'AskPage.tsx',
];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\.reduce\s*\(/, 'reduce (summing or aggregating values)'],
  [/\b(sum|total|average|avg|mean|median)\w*\s*[+\-*/]=/i, 'an accumulated figure (+=, -=, *=, /=)'],
  [/\b(sum|average|avg|mean|median)\s*\(/i, 'a sum or average helper'],
  [/\*\s*100\b|\/\s*100\b/, 'percent scaling outside lib/format.ts'],
  [/Math\.(round|floor|ceil|trunc)\s*\(/, 'rounding a value'],
  [/\.toFixed\s*\(/, 'toFixed (format through lib/format.ts)'],
  [/toLocaleString\s*\(|new Intl\./, 'formatting outside lib/format.ts'],
];

describe('no figures are computed on the client', () => {
  for (const file of ANSWER_FILES) {
    it(`${file} has no value arithmetic or local formatting`, () => {
      const source = readFileSync(resolve(__dirname, file), 'utf8')
        // Ignore comments, which explain the rule.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const [pattern, what] of FORBIDDEN) {
        expect(pattern.test(source), `${file}: ${what}`).toBe(false);
      }
    });
  }

  it('the percent scaling lives only in lib/format.ts', () => {
    const format = readFileSync(resolve(__dirname, '../../lib/format.ts'), 'utf8');
    expect(format).toMatch(/n \* 100/);
  });
});
