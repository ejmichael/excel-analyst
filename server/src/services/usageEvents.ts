import { throwIfDbError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabase.js';
import type { LlmUsage } from '../llm/client.js';

export type UsageKind = 'upload' | 'question' | 'report' | 'report_run' | 'export' | 'share' | 'llm' | 'feedback';

/** meta holds ids, purposes, sizes and timings only. NEVER file content, prompts or model output. */
export type UsageMeta = Record<string, string | number | boolean | null>;

export async function recordUsage(ownerId: string, kind: UsageKind, meta: UsageMeta = {}): Promise<void> {
  const { error } = await supabaseAdmin().from('usage_events').insert({ owner_id: ownerId, kind, meta });
  throwIfDbError(`usage: record ${kind}`, error);
}

/**
 * One `llm` row per model call, including failed ones (tokens are null when unknown).
 * Never throws: losing a usage row must not fail the user's request; it is logged instead.
 */
export async function recordLlmUsage(
  ownerId: string,
  purpose: 'suggest' | 'plan' | 'repair' | 'narrate',
  usage: LlmUsage | null,
  meta: UsageMeta = {},
): Promise<void> {
  const row = {
    owner_id: ownerId,
    kind: 'llm' as const,
    model: usage?.model ?? null,
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    cost_usd: usage?.costUsd === null || usage?.costUsd === undefined ? null : Number(usage.costUsd.toFixed(6)),
    meta: { purpose, ...meta },
  };
  logger.info(
    { purpose, model: row.model, input_tokens: row.input_tokens, output_tokens: row.output_tokens, cost_usd: row.cost_usd },
    'llm call',
  );
  if (usage && usage.inputTokens !== null && usage.costUsd === null) logger.warn({ model: usage.model }, 'no price for model; cost_usd is null');
  const { error } = await supabaseAdmin().from('usage_events').insert(row);
  if (error) logger.error({ db_code: error.code }, 'could not record llm usage');
}
