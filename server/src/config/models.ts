/**
 * What each model accepts, by model id (Anthropic ids and OpenRouter ids). Unknown models are assumed to accept
 * both; if a model turns out to reject forced tool choice, the client detects that specific 400 once and caches it.
 *
 * Sources (2026-11-09/10): tested through OpenRouter (Sonnet 5.5 rejects forced tool_choice from every provider;
 * Haiku 5.5 accepts it), OpenRouter's model list (`supported_parameters` has no `temperature` for either), and
 * Anthropic's model notes (forced tool_choice returns a 400 on Sonnet 5.5, Opus 5.5 and Fable 5.1; non-default
 * sampling values return a 400 on the 5.5 models).
 */
export interface ModelCaps {
  forcedToolChoice: boolean;
  temperature: boolean;
}

const NO_FORCED_NO_TEMPERATURE: ModelCaps = { forcedToolChoice: false, temperature: false };
const FORCED_NO_TEMPERATURE: ModelCaps = { forcedToolChoice: true, temperature: false };

const CAPS: Record<string, ModelCaps> = {
  'anthropic/claude-sonnet-5.5': NO_FORCED_NO_TEMPERATURE,
  'claude-sonnet-5-5': NO_FORCED_NO_TEMPERATURE,
  'anthropic/claude-opus-5.5': NO_FORCED_NO_TEMPERATURE,
  'claude-opus-5-5': NO_FORCED_NO_TEMPERATURE,
  'anthropic/claude-fable-5.1': NO_FORCED_NO_TEMPERATURE,
  'claude-fable-5-1': NO_FORCED_NO_TEMPERATURE,
  'anthropic/claude-haiku-5.5': FORCED_NO_TEMPERATURE,
  'claude-haiku-5-5': FORCED_NO_TEMPERATURE,
};

const DEFAULT_CAPS: ModelCaps = { forcedToolChoice: true, temperature: true };

/** Models found at runtime to reject forced tool choice (the specific 400), for the life of the process. */
const learnedNoForced = new Set<string>();

export function capsFor(model: string): ModelCaps {
  const caps = CAPS[model] ?? DEFAULT_CAPS;
  return learnedNoForced.has(model) ? { ...caps, forcedToolChoice: false } : caps;
}

export function markNoForcedToolChoice(model: string): void {
  learnedNoForced.add(model);
}

/** For tests. */
export function resetLearnedCaps(): void {
  learnedNoForced.clear();
}
