import { beforeAll, describe, expect, it } from 'vitest';
import { DASHBOARD_SYSTEM } from '../../src/llm/prompts/dashboard.js';
import { PLANNER_SYSTEM } from '../../src/llm/prompts/planner.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { SandboxError, type SandboxInput, withSandbox } from '../../src/services/sandbox/sandbox.js';

/**
 * W2b item 5 (replaced): the validator is unchanged on purpose. The prompts tell the model to avoid trim() and
 * substring() and use these forms instead; they must pass the validator, and trim( and substring( stay refused.
 * The spaces are in a literal because parsing already trims cells.
 */

let input: SandboxInput;

beforeAll(async () => {
  const profile = await profileFile({ buffer: Buffer.from('name,code\nJoe Soap,ZA-001\nAnn,ZA-002\n'), fileType: 'csv', options: {}, maxRows: 1000 });
  input = { csv: profile.normalisedCsv, columns: profile.columns };
});

const run = (sql: string) => withSandbox(input, (s) => s.query(sql, { maxRows: 10 }));

describe('the text forms the prompts recommend', () => {
  it(String.raw`regexp_replace(x, '^\s+|\s+$', '', 'g') runs and removes leading and trailing spaces`, async () => {
    const result = await run(String.raw`SELECT regexp_replace(concat(' 	 ', "name", '  '), '^\s+|\s+$', '', 'g') AS clean FROM data ORDER BY "code"`);
    expect(result.rows.map((r) => r.clean)).toEqual(['Joe Soap', 'Ann']);
  });

  it('substr(x, start, length) runs', async () => {
    const result = await run(`SELECT substr("code", 1, 2) AS country FROM data ORDER BY "code"`);
    expect(result.rows.map((r) => r.country)).toEqual(['ZA', 'ZA']);
  });

  it.each([`SELECT trim("name") FROM data`, `SELECT substring("code", 1, 2) FROM data`])('still refuses %s', async (sql) => {
    await expect(run(sql)).rejects.toBeInstanceOf(SandboxError);
  });

  it('both prompts carry the sentence of LLM_PROMPTS sections 2 and 5', () => {
    const sentence = String.raw`Do not use trim() or substring(). To remove leading and trailing spaces use regexp_replace(x, '^\s+|\s+$', '', 'g'), and to take part of a text use substr(x, start, length).`;
    expect(PLANNER_SYSTEM).toContain(sentence);
    expect(DASHBOARD_SYSTEM).toContain(sentence);
  });
});
