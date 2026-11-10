import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { env } from '../config/env.js';
import { costFromTable } from '../config/prices.js';

/**
 * Provider-neutral forced tool call: one system prompt, one user message, one tool the model must call.
 * LLM_PROVIDER=openrouter uses OpenRouter's OpenAI-compatible chat completions API;
 * LLM_PROVIDER=anthropic uses @anthropic-ai/sdk. Model ids always come from
 * ANTHROPIC_MODEL_PLANNER / ANTHROPIC_MODEL_FAST (OpenRouter ids when the provider is openrouter).
 * The tool's arguments are validated with zod before anyone uses them.
 */

export type ModelRole = 'planner' | 'fast';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (an object schema). */
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest<T> {
  role: ModelRole;
  system: string;
  user: string;
  tool: ToolSpec;
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Sent only where the provider accepts it (see ProviderRequest.temperature). */
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** USD; from the provider when it reports cost, else from config/prices.ts, else null. */
  costUsd: number | null;
}

export interface ToolCallResult<T> {
  output: T;
  usage: LlmUsage;
}

export type LlmErrorKind = 'timeout' | 'rate_limited' | 'server' | 'request' | 'invalid_output';

/** Messages are fixed and safe to log; they never contain prompt or output text. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    /** Known when the model answered but the answer was unusable (tokens were still spent). */
    readonly usage?: LlmUsage,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ProviderRequest {
  model: string;
  system: string;
  user: string;
  tool: ToolSpec;
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
}

export interface ProviderResponse {
  /** Parsed tool arguments, or undefined when the model did not call the tool. */
  args: unknown;
  truncated: boolean;
  usage: LlmUsage;
}

export interface Provider {
  readonly name: 'openrouter' | 'anthropic';
  call(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Thrown by providers for HTTP-level failures so the client can decide whether to retry. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`provider returned HTTP ${status}`);
    this.name = 'ProviderHttpError';
  }
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterBody {
  error?: { code?: number; message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export function openRouterProvider(opts: { apiKey: string; title: string; fetch?: typeof fetch }): Provider {
  const doFetch = opts.fetch ?? fetch;
  return {
    name: 'openrouter',
    async call(req) {
      const res = await doFetch(OPENROUTER_URL, {
        method: 'POST',
        signal: req.signal,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'X-OpenRouter-Title': opts.title,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          // OpenRouter drops parameters a model does not support (Claude 5.5 models ignore temperature).
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          tools: [{ type: 'function', function: req.tool }],
          tool_choice: { type: 'function', function: { name: req.tool.name } },
          parallel_tool_calls: false,
          // Only route to providers that do not store or train on prompts.
          provider: { data_collection: 'deny' },
        }),
      });
      let body: OpenRouterBody;
      try {
        body = (await res.json()) as OpenRouterBody;
      } catch {
        throw new ProviderHttpError(res.ok ? 502 : res.status, null);
      }
      // OpenRouter can answer 200 with only an error object in the body.
      if (!res.ok || body.error) {
        const status = !res.ok ? res.status : (body.error?.code ?? 502);
        throw new ProviderHttpError(status, retryAfterMs(res.headers.get('retry-after')));
      }
      const choice = body.choices?.[0];
      const call = choice?.message?.tool_calls?.find((c) => c.function?.name === req.tool.name);
      let args: unknown;
      if (call?.function?.arguments !== undefined) {
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = undefined;
        }
      }
      const inputTokens = body.usage?.prompt_tokens ?? null;
      const outputTokens = body.usage?.completion_tokens ?? null;
      const reported = body.usage?.cost;
      return {
        args,
        truncated: choice?.finish_reason === 'length',
        usage: {
          model: req.model,
          inputTokens,
          outputTokens,
          costUsd:
            typeof reported === 'number'
              ? reported
              : inputTokens !== null && outputTokens !== null
                ? costFromTable(req.model, inputTokens, outputTokens)
                : null,
        },
      };
    },
  };
}

export function anthropicProvider(opts: { apiKey: string; client?: Anthropic }): Provider {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  return {
    name: 'anthropic',
    async call(req) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            // No temperature: current Claude models reject non-default sampling values with a 400.
            // A forced tool call cannot run with thinking on.
            thinking: { type: 'disabled' },
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
            tools: [
              {
                name: req.tool.name,
                description: req.tool.description,
                input_schema: req.tool.parameters as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: 'tool', name: req.tool.name },
          },
          { signal: req.signal },
        );
      } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError) throw err;
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderHttpError(408, null);
        if (err instanceof Anthropic.APIConnectionError) throw new ProviderHttpError(503, null);
        if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
          throw new ProviderHttpError(err.status, retryAfterMs(err.headers?.get('retry-after') ?? null));
        }
        throw err;
      }
      const block = message.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === req.tool.name,
      );
      const { input_tokens: inputTokens, output_tokens: outputTokens } = message.usage;
      return {
        args: block?.input,
        truncated: message.stop_reason === 'max_tokens',
        usage: {
          model: req.model,
          inputTokens,
          outputTokens,
          costUsd: costFromTable(req.model, inputTokens, outputTokens),
        },
      };
    },
  };
}

export interface LlmClient {
  readonly provider: Provider['name'];
  modelFor(role: ModelRole): string;
  callTool<T>(req: ToolCallRequest<T>): Promise<ToolCallResult<T>>;
}

const DEFAULT_TIMEOUT_MS = 40_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const MAX_RETRY_DELAY_MS = 10_000;

const isRetryable = (status: number) => status === 429 || status >= 500;

export function createLlmClient(deps: {
  provider: Provider;
  models: Record<ModelRole, string>;
  sleep?: (ms: number) => Promise<void>;
}): LlmClient {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function attempt<T>(req: ToolCallRequest<T>): Promise<ToolCallResult<T>> {
    const model = deps.models[req.role];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: ProviderResponse;
    try {
      res = await deps.provider.call({
        model,
        system: req.system,
        user: req.user,
        tool: req.tool,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new LlmError('timeout', 'The model did not answer in time.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.args === undefined) {
      throw new LlmError('invalid_output', res.truncated ? 'The answer was cut off.' : 'The model did not call the tool.', res.usage);
    }
    const parsed = req.schema.safeParse(res.args);
    if (!parsed.success) throw new LlmError('invalid_output', 'The answer did not match the expected shape.', res.usage);
    return { output: parsed.data, usage: res.usage };
  }

  return {
    provider: deps.provider.name,
    modelFor: (role) => deps.models[role],
    async callTool(req) {
      // One retry on 429 or 5xx, with backoff (Retry-After when given, capped).
      for (let tries = 0; ; tries++) {
        try {
          return await attempt(req);
        } catch (err) {
          if (err instanceof ProviderHttpError) {
            if (tries === 0 && isRetryable(err.status)) {
              await sleep(Math.min(err.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS));
              continue;
            }
            const kind: LlmErrorKind =
              err.status === 429 ? 'rate_limited' : err.status === 408 ? 'timeout' : err.status >= 500 ? 'server' : 'request';
            throw new LlmError(kind, `The model call failed (HTTP ${err.status}).`, undefined, err.status);
          }
          throw err;
        }
      }
    },
  };
}

let cached: LlmClient | undefined;

/** The client configured from env. */
export function llm(): LlmClient {
  if (!cached) {
    const e = env();
    const provider =
      e.LLM_PROVIDER === 'openrouter'
        ? openRouterProvider({ apiKey: e.OPENROUTER_API_KEY!, title: e.APP_NAME })
        : anthropicProvider({ apiKey: e.ANTHROPIC_API_KEY! });
    cached = createLlmClient({ provider, models: { planner: e.ANTHROPIC_MODEL_PLANNER, fast: e.ANTHROPIC_MODEL_FAST } });
  }
  return cached;
}
