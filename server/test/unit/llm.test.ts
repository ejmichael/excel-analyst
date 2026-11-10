import Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { costFromTable } from '../../src/config/prices.js';
import {
  anthropicProvider,
  createLlmClient,
  LlmError,
  openRouterProvider,
  type ToolCallRequest,
} from '../../src/llm/client.js';

// No test here touches the network: OpenRouter gets a fake fetch, Anthropic a fake SDK client.
vi.mock('../../src/services/usageEvents.js', () => ({ recordLlmUsage: vi.fn(async () => undefined) }));

const schema = z.object({ colours: z.array(z.string()).length(2) });
const request: ToolCallRequest<z.infer<typeof schema>> = {
  role: 'fast',
  system: 'sys',
  user: 'Give two colours.',
  tool: { name: 'give_colours', description: 'd', parameters: { type: 'object' } },
  schema,
  maxTokens: 100,
  temperature: 0.3,
};

const models = { planner: 'anthropic/claude-sonnet-5.5', fast: 'anthropic/claude-haiku-5.5' };

function orResponse(args: unknown, init: { status?: number; usage?: object; finish?: string; headers?: Record<string, string> } = {}) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: init.finish ?? 'tool_calls',
          message: { tool_calls: [{ function: { name: 'give_colours', arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] },
        },
      ],
      usage: init.usage ?? { prompt_tokens: 500, completion_tokens: 40, cost: 0.00007 },
    }),
    { status: init.status ?? 200, headers: init.headers },
  );
}

const errorResponse = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code: status, message: 'x' } }), { status, headers });

describe('OpenRouter provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const sleep = vi.fn(async () => undefined);
  const client = () =>
    createLlmClient({ provider: openRouterProvider({ apiKey: 'k', title: 'Analyst', fetch: fetchMock as unknown as typeof fetch }), models, sleep });

  beforeEach(() => {
    fetchMock = vi.fn();
    sleep.mockClear();
  });

  it('forces the tool call, denies data collection, and returns validated output with usage and cost', async () => {
    fetchMock.mockResolvedValueOnce(orResponse({ colours: ['red', 'blue'] }));
    const result = await client().callTool(request);
    expect(result.output).toEqual({ colours: ['red', 'blue'] });
    expect(result.usage).toEqual({ model: models.fast, inputTokens: 500, outputTokens: 40, costUsd: 0.00007 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: models.fast,
      max_tokens: 100,
      temperature: 0.3,
      tool_choice: { type: 'function', function: { name: 'give_colours' } },
      provider: { data_collection: 'deny' },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Give two colours.' },
    ]);
    expect(init.headers.Authorization).toBe('Bearer k');
  });

  it('falls back to the price table when the response has no cost', async () => {
    fetchMock.mockResolvedValueOnce(orResponse({ colours: ['a', 'b'] }, { usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
    const result = await client().callTool(request);
    expect(result.usage.costUsd).toBeCloseTo(costFromTable(models.fast, 1000, 100)!, 10);
  });

  it('rejects output that does not match the schema (tokens still reported)', async () => {
    fetchMock.mockResolvedValueOnce(orResponse({ colours: ['only one'] }));
    const err = await client().callTool(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('invalid_output');
    expect((err as LlmError).usage?.inputTokens).toBe(500);
  });

  it('rejects unparseable arguments and truncated answers', async () => {
    fetchMock.mockResolvedValueOnce(orResponse('{"colours": ["a"'));
    expect(((await client().callTool(request).catch((e) => e)) as LlmError).kind).toBe('invalid_output');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: {} }], usage: {} }), { status: 200 }),
    );
    expect(((await client().callTool(request).catch((e) => e)) as LlmError).message).toMatch(/cut off/);
  });

  it('retries once on 429, honouring Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(429, { 'retry-after': '2' })).mockResolvedValueOnce(orResponse({ colours: ['a', 'b'] }));
    const result = await client().callTool(request);
    expect(result.output.colours).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('gives up after one retry', async () => {
    fetchMock.mockResolvedValue(errorResponse(503));
    const err = (await client().callTool(request).catch((e) => e)) as LlmError;
    expect(err.kind).toBe('server');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400', async () => {
    fetchMock.mockResolvedValue(errorResponse(400));
    const err = (await client().callTool(request).catch((e) => e)) as LlmError;
    expect(err.kind).toBe('request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats an error body on HTTP 200 as an error', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 502, message: 'upstream' } }), { status: 200 }));
    const err = (await client().callTool(request).catch((e) => e)) as LlmError;
    expect(err.kind).toBe('server');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const err = (await client().callTool({ ...request, timeoutMs: 20 }).catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Anthropic provider', () => {
  function fakeSdk(create: (...args: unknown[]) => Promise<unknown>) {
    return { messages: { create: vi.fn(create) } } as unknown as Anthropic & { messages: { create: ReturnType<typeof vi.fn> } };
  }
  const anthropicModels = { planner: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' };

  it('forces the tool, sends no temperature, and prices from the table', async () => {
    const sdk = fakeSdk(async () => ({
      content: [{ type: 'tool_use', id: 't', name: 'give_colours', input: { colours: ['red', 'blue'] } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1000, output_tokens: 100 },
    }));
    const client = createLlmClient({ provider: anthropicProvider({ apiKey: 'k', client: sdk }), models: anthropicModels });
    const result = await client.callTool(request);
    expect(result.output.colours).toEqual(['red', 'blue']);
    expect(result.usage.costUsd).toBeCloseTo(costFromTable('claude-haiku-5-5', 1000, 100)!, 10);
    const params = sdk.messages.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({ model: 'claude-haiku-5-5', tool_choice: { type: 'tool', name: 'give_colours' } });
    expect(params).not.toHaveProperty('temperature');
  });

  it('reports a missing tool call as invalid output', async () => {
    const sdk = fakeSdk(async () => ({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
    const client = createLlmClient({ provider: anthropicProvider({ apiKey: 'k', client: sdk }), models: anthropicModels });
    expect(((await client.callTool(request).catch((e) => e)) as LlmError).kind).toBe('invalid_output');
  });
});

describe('price table', () => {
  it('uses the higher Haiku tier above 100k input tokens and returns null for unknown models', () => {
    expect(costFromTable('anthropic/claude-haiku-5.5', 50_000, 0)).toBeCloseTo(0.005, 10); // 50k x $0.10/M
    expect(costFromTable('anthropic/claude-haiku-5.5', 200_000, 0)).toBeCloseTo(0.1, 10); // 200k x $0.50/M
    expect(costFromTable('some/unknown-model', 10, 10)).toBeNull();
  });
});
