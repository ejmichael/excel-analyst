import { logger } from '../lib/logger.js';
import { type LlmClient, LlmError, llm } from '../llm/client.js';
import {
  SUGGEST_QUESTIONS_TOOL,
  SUGGESTIONS_MAX_TOKENS,
  SUGGESTIONS_SYSTEM,
  suggestQuestionsSchema,
} from '../llm/prompts/suggestions.js';
import type { ColumnDataType, ColumnSemantic, SuggestedQuestion } from '../types/api.js';
import { maskValue } from './parsing/pii.js';
import { recordLlmUsage } from './usageEvents.js';

/** Cost control (LLM_PROMPTS 4): at most 200 columns, 5 sample rows, 80 characters per cell. */
export const MAX_PROMPT_COLUMNS = 200;
const MAX_SAMPLE_ROWS = 5;
const MAX_CELL = 80;

export interface PromptColumn {
  name: string;
  display_name: string | null;
  sql_name: string;
  data_type: ColumnDataType;
  semantic: ColumnSemantic;
  is_pii: boolean;
  distinct_count: number;
  min_value: string | null;
  max_value: string | null;
}

export interface SuggestionsInput {
  datasetName: string;
  rowCount: number;
  columns: PromptColumn[];
  /** Normalised sample rows keyed by sql_name, NOT masked; masking happens here. */
  sampleRows: Array<Record<string, string>>;
}

/** Keeps a cell on one line, within 80 characters, and unable to close the <data> block. */
function cell(value: string): string {
  const flat = value.replace(/<\/?data>/gi, '').replace(/[\r\n\t|]+/g, ' ').trim();
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

const label = (c: PromptColumn) => c.display_name ?? c.name;

/**
 * The user message for LLM_PROMPTS section 1. PII columns appear only as placeholders
 * ([email], [phone], [id], [name], [address]) and never with min/max values.
 */
export function buildSuggestionsPrompt(input: SuggestionsInput): { user: string; droppedColumns: number } {
  const columns = input.columns.slice(0, MAX_PROMPT_COLUMNS);
  const lines = columns.map((c) => {
    const parts: string[] = [c.data_type, c.semantic];
    if (!c.is_pii && c.min_value !== null && c.max_value !== null) parts.push(`${cell(c.min_value)}..${cell(c.max_value)}`);
    parts.push(`${c.distinct_count} distinct`);
    return `- "${cell(label(c))}" (${parts.join(', ')})`;
  });
  const table = [columns.map((c) => cell(label(c))).join(' | ')];
  for (const row of input.sampleRows.slice(0, MAX_SAMPLE_ROWS)) {
    table.push(columns.map((c) => cell(maskValue(row[c.sql_name] ?? '', c) ?? '')).join(' | '));
  }
  const user = [
    `Dataset name: ${cell(input.datasetName)}`,
    `Rows: ${input.rowCount}`,
    'Columns:',
    ...lines,
    '<data>',
    ...table,
    '</data>',
  ].join('\n');
  return { user, droppedColumns: Math.max(0, input.columns.length - columns.length) };
}

export const SUGGESTIONS_FAILED_WARNING = 'We could not generate suggested questions.';

/**
 * Five suggested questions, or null on any failure (the dataset still ends `ready`).
 * Writes one `llm` usage event per call, successful or not.
 */
export async function generateSuggestions(
  ownerId: string,
  datasetId: string,
  input: SuggestionsInput,
  client: LlmClient = llm(),
): Promise<SuggestedQuestion[] | null> {
  const { user } = buildSuggestionsPrompt(input);
  const started = Date.now();
  try {
    const result = await client.callTool({
      role: 'fast',
      system: SUGGESTIONS_SYSTEM,
      user,
      tool: SUGGEST_QUESTIONS_TOOL,
      schema: suggestQuestionsSchema,
      maxTokens: SUGGESTIONS_MAX_TOKENS,
    });
    await recordLlmUsage(ownerId, 'suggest', result.usage, { dataset_id: datasetId, ms: Date.now() - started });
    return result.output.questions;
  } catch (err) {
    const kind = err instanceof LlmError ? err.kind : 'unexpected';
    logger.warn({ dataset_id: datasetId, kind }, 'suggestions failed');
    const usage = (err instanceof LlmError ? err.usage : undefined) ?? {
      model: client.modelFor('fast'),
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };
    await recordLlmUsage(ownerId, 'suggest', usage, {
      dataset_id: datasetId,
      ms: Date.now() - started,
      error: kind,
    });
    return null;
  }
}
