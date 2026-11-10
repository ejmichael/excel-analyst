import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { capsFor, resetLearnedCaps } from '../../src/config/models.js';
import {
  anthropicProvider,
  callToolInstruction,
  createLlmClient,
  LlmError,
  openRouterProvider,
  type ToolCallRequest,
} from '../../src/llm/client.js';

/**
 * Approved 2026-11-10: forced tool choice where the model supports it (Haiku 5.5); for models that reject it
 * (Sonnet 5.5) send the tool with tool_choice "auto" plus "Always answer by calling the <tool> tool"; a reply
 * without the tool call gets one retry, then fails. Output is always zod-validated. Never send temperature to
 * Sonnet 5.5 or Haiku 5.5. All mocked: no network.
 */

const schema = z.object({ colours: z.array(z.string()).length(2) });
const req = (role: 'planner' | 'fast'): ToolCallRequest<z.infer<typeof schema>> => ({
  role,
  system: 'sys',
  user: 'Give two colours.',
  tool: { name: 'give_colours', description: 'd', parameters: { type: 'object' } },
  schema,
  maxTokens: 100,
  temperature: 0.2,
});

const OR = { planner: 'anthropic/claude-sonnet-5.5', fast: 'anthropic/claude-haiku-5.5' };
const ANT = { planner: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' };
const usage = { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 };

const toolReply = (args: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'give_colours', arguments: JSON.stringify(args) } }] } }],
      usage,
    }),
  );
const textReply = () =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Red and blue.' } }], usage }));
const forcedRejected = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: { raw: '{"error":{"message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}' },
      },
    }),
    { status: 400 },
  );

afterEach(() => resetLearnedCaps());

describe('OpenRouter: which tool choice per model', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = (models = OR) =>
    createLlmClient({ provider: openRouterProvider({ apiKey: 'k', title: 'T', fetch: fetchMock as unknown as typeof fetch }), models, sleep: async () => undefined });
  const body = (i = 0) => JSON.parse(fetchMock.mock.calls[i]![1].body as string);
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('forces the tool for Haiku 5.5 and sends no temperature', async () => {
    fetchMock.mockResolvedValueOnce(toolReply({ colours: ['a', 'b'] }));
    await client().callTool(req('fast'));
    expect(body()).toMatchObject({ model: OR.fast, tool_choice: { type: 'function', function: { name: 'give_colours' } } });
    expect(body()).not.toHaveProperty('temperature');
    expect(body().messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('uses auto plus the instruction for Sonnet 5.5, and sends no temperature', async () => {
    fetchMock.mockResolvedValueOnce(toolReply({ colours: ['a', 'b'] }));
    const result = await client().callTool(req('planner'));
    expect(result.output.colours).toEqual(['a', 'b']);
    expect(body().tool_choice).toBe('auto');
    expect(body().tools).toHaveLength(1);
    expect(body().messages[0].content).toBe(`sys\n\n${callToolInstruction('give_colours')}`);
    expect(callToolInstruction('give_colours')).toBe('Always answer by calling the give_colours tool.');
    expect(body()).not.toHaveProperty('temperature');
  });

  it('retries once when an auto-mode reply has no tool call, and sums the usage', async () => {
    fetchMock.mockResolvedValueOnce(textReply()).mockResolvedValueOnce(toolReply({ colours: ['a', 'b'] }));
    const result = await client().callTool(req('planner'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 0.002 });
  });

  it('fails after the second reply without a tool call (callers answer 502 llm_failed)', async () => {
    fetchMock.mockImplementation(async () => textReply());
    const err = (await client().callTool(req('planner')).catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe('invalid_output');
    expect(err.message).toBe('The model did not call the tool.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.usage).toMatchObject({ inputTokens: 200 });
  });

  it('still validates auto-mode output with zod (no retry for a wrong shape)', async () => {
    fetchMock.mockImplementation(async () => toolReply({ colours: ['only one'] }));
    const err = (await client().callTool(req('planner')).catch((e) => e)) as LlmError;
    expect(err.message).toMatch(/expected shape/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a forced reply without the tool (only auto mode retries)', async () => {
    fetchMock.mockImplementation(async () => textReply());
    expect(((await client().callTool(req('fast')).catch((e) => e)) as LlmError).kind).toBe('invalid_output');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('learns an unknown model that rejects forced choice, switches to auto at once, and remembers it', async () => {
    const models = { planner: 'vendor/new-model', fast: 'vendor/new-model' };
    expect(capsFor('vendor/new-model').forcedToolChoice).toBe(true);
    fetchMock.mockResolvedValueOnce(forcedRejected()).mockResolvedValueOnce(toolReply({ colours: ['a', 'b'] }));
    await client(models).callTool(req('planner'));
    expect(body(0).tool_choice).toEqual({ type: 'function', function: { name: 'give_colours' } });
    expect(body(1).tool_choice).toBe('auto');
    expect(body(0).temperature).toBe(0.2); // unknown models do get the temperature
    expect(capsFor('vendor/new-model').forcedToolChoice).toBe(false);

    fetchMock.mockResolvedValueOnce(toolReply({ colours: ['c', 'd'] }));
    await client(models).callTool(req('planner'));
    expect(body(2).tool_choice).toBe('auto'); // no second rejected attempt
  });

  it('treats any other 400 as a request error, with no switch', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 400, message: 'bad' } }), { status: 400 }));
    expect(((await client().callTool(req('fast')).catch((e) => e)) as LlmError).kind).toBe('request');
    expect(capsFor(OR.fast).forcedToolChoice).toBe(true);
  });
});

describe('Anthropic SDK: which tool choice per model', () => {
  function fakeSdk(...replies: Array<() => unknown>) {
    const create = vi.fn();
    for (const r of replies) create.mockImplementationOnce(async () => r());
    return { client: { messages: { create } } as unknown as Anthropic, create };
  }
  const toolUse = () => ({
    content: [{ type: 'tool_use', id: 't', name: 'give_colours', input: { colours: ['a', 'b'] } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 10 },
  });
  const text = () => ({ content: [{ type: 'text', text: 'Red.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 5 } });

  it('Haiku 5.5: forced tool, thinking disabled, no temperature', async () => {
    const sdk = fakeSdk(toolUse);
    await createLlmClient({ provider: anthropicProvider({ apiKey: 'k', client: sdk.client }), models: ANT }).callTool(req('fast'));
    const params = sdk.create.mock.calls[0]![0];
    expect(params).toMatchObject({ tool_choice: { type: 'tool', name: 'give_colours' }, thinking: { type: 'disabled' }, system: 'sys' });
    expect(params).not.toHaveProperty('temperature');
  });

  it('Sonnet 5.5: auto, instruction appended, no thinking override, no temperature', async () => {
    const sdk = fakeSdk(toolUse);
    await createLlmClient({ provider: anthropicProvider({ apiKey: 'k', client: sdk.client }), models: ANT }).callTool(req('planner'));
    const params = sdk.create.mock.calls[0]![0];
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.system).toBe(`sys\n\n${callToolInstruction('give_colours')}`);
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('temperature');
  });

  it('Sonnet 5.5: one retry when no tool call, then failure', async () => {
    const sdk = fakeSdk(text, text);
    const err = (await createLlmClient({ provider: anthropicProvider({ apiKey: 'k', client: sdk.client }), models: ANT })
      .callTool(req('planner'))
      .catch((e) => e)) as LlmError;
    expect(err.kind).toBe('invalid_output');
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });

  it('learns from the SDK error message too', async () => {
    const rejected = () => {
      throw new Anthropic.BadRequestError(
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } },
        'tool_choice: type "tool" and "any" are not supported for this model.',
        new Headers(),
      );
    };
    const sdk = fakeSdk(rejected, toolUse);
    const models = { planner: 'claude-new-model', fast: 'claude-new-model' };
    await createLlmClient({ provider: anthropicProvider({ apiKey: 'k', client: sdk.client }), models }).callTool(req('planner'));
    expect(sdk.create.mock.calls[1]![0].tool_choice).toEqual({ type: 'auto' });
  });
});
