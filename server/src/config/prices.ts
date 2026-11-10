/**
 * USD per million tokens, used when a provider does not report the cost itself.
 * OpenRouter reports `usage.cost` (USD) on every response, so this table is its fallback;
 * the Anthropic API does not, so Anthropic calls always use it.
 *
 * Sources, read 2026-11-09 (copy new values from these; never guess):
 * - OpenRouter ids: https://openrouter.ai/api/v1/models (`pricing.prompt` / `pricing.completion`, USD per token).
 * - Anthropic ids: Anthropic's pricing table (claude-api skill, cached 2026-10-06); they match OpenRouter's.
 * A model missing from this table logs cost_usd = null and a warning, rather than an invented price.
 */
export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  /** Prompts above this many input tokens bill at the `above` prices instead. */
  tier?: { above_input_tokens: number; input_per_mtok: number; output_per_mtok: number };
}

const SONNET_5_5: ModelPrice = { input_per_mtok: 2, output_per_mtok: 10 };
const HAIKU_5_5: ModelPrice = {
  input_per_mtok: 0.1,
  output_per_mtok: 0.5,
  tier: { above_input_tokens: 100_000, input_per_mtok: 0.5, output_per_mtok: 2.5 },
};

export const PRICES: Record<string, ModelPrice> = {
  'anthropic/claude-sonnet-5.5': SONNET_5_5,
  'anthropic/claude-haiku-5.5': HAIKU_5_5,
  'claude-sonnet-5-5': SONNET_5_5,
  'claude-haiku-5-5': HAIKU_5_5,
};

/** Cost in USD from the table, or null when the model is not listed. */
export function costFromTable(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const p = price.tier && inputTokens > price.tier.above_input_tokens ? price.tier : price;
  return (inputTokens * p.input_per_mtok + outputTokens * p.output_per_mtok) / 1_000_000;
}
