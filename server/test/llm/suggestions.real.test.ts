import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { llm } from '../../src/llm/client.js';
import {
  SUGGEST_QUESTIONS_TOOL,
  SUGGESTIONS_MAX_TOKENS,
  SUGGESTIONS_SYSTEM,
  suggestQuestionsSchema,
} from '../../src/llm/prompts/suggestions.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { buildSuggestionsPrompt } from '../../src/services/suggestions.js';

/**
 * Opt-in check against the real model (costs real money, a fraction of a cent per file):
 *   RUN_LLM_TESTS=1 npm run test:llm
 * Profiles the three non-ambiguous fixtures locally and prints each file's five questions with tokens and cost.
 * Writes nothing to the database.
 */
const FILES = ['01_card_sales_semicolon_win1252.csv', '02_webstore_orders_utf8bom.csv', '03_bank_statement_comma_quoted.csv'];

describe.skipIf(!process.env.RUN_LLM_TESTS)('suggestions with the real model', () => {
  it.each(FILES)('%s', async (name) => {
    const buffer = readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url));
    const profile = await profileFile({ buffer, fileType: 'csv', options: {}, maxRows: 200_000 });
    const { user } = buildSuggestionsPrompt({
      datasetName: name.replace(/\.csv$/, ''),
      rowCount: profile.rowCount,
      columns: profile.columns.map((c) => ({ ...c, display_name: null })),
      sampleRows: profile.sampleRows,
    });
    const started = Date.now();
    const result = await llm().callTool({
      role: 'fast',
      system: SUGGESTIONS_SYSTEM,
      user,
      tool: SUGGEST_QUESTIONS_TOOL,
      schema: suggestQuestionsSchema,
      maxTokens: SUGGESTIONS_MAX_TOKENS,
    });
    const { usage } = result;
    console.log(
      [
        `\n=== ${name} (${llm().provider}, ${usage.model}, ${Date.now() - started} ms)`,
        ...result.output.questions.map((q, i) => `${i + 1}. ${q.question}\n   why: ${q.why}`),
        `tokens in/out: ${usage.inputTokens}/${usage.outputTokens}, cost: $${usage.costUsd?.toFixed(6) ?? 'unknown'}`,
      ].join('\n'),
    );
    expect(result.output.questions).toHaveLength(5);
  }, 120_000);
});
