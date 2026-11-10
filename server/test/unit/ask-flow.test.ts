import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLearnedCaps } from '../../src/config/models.js';
import { createLlmClient, type LlmClient, LlmError, openRouterProvider, type ToolCallRequest } from '../../src/llm/client.js';
import { ask, AskLlmFailure, type AskDeps, type AskInput, CANNOT_BUILD_QUERY } from '../../src/services/analysis/ask.js';
import { UNRESOLVED } from '../../src/services/analysis/tokens.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';

/**
 * The ask flow end to end with a mocked model and the real sandbox over fixture 01 (local DuckDB, no network).
 * The mocked planner writes SQL; the numbers in every answer come from DuckDB running it.
 */

const FIXTURES = new URL('../../../fixtures/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')).files['01_card_sales_semicolon_win1252.csv'];

let input: AskInput;
beforeAll(async () => {
  const p = await profileFile({ buffer: readFileSync(new URL('01_card_sales_semicolon_win1252.csv', FIXTURES)), fileType: 'csv', options: {}, maxRows: 1e6 });
  input = {
    ownerId: 'owner',
    datasetId: 'ds',
    datasetName: 'Card sales',
    rowCount: p.rowCount,
    columns: p.columns.map((c) => ({ ...c, display_name: null, vat_included: null })),
    csv: p.normalisedCsv,
    question: 'What were net sales by store?',
    source: 'user',
  };
});

const BY_STORE_SQL = 'SELECT "store", ROUND(SUM("net_amount"), 2) AS net FROM data GROUP BY "store" ORDER BY net DESC';
const goodPlan = (over: Record<string, unknown> = {}) => ({
  can_answer: true,
  title: 'Net sales by store',
  sql: BY_STORE_SQL,
  source_filter_sql: null,
  chart: { type: 'bar', x: 'store', y: ['net'], series: null, orientation: 'vertical', stacked: false, value_format: { store: 'text', net: 'zar' } },
  reconcile: { column: 'net', aggregation: 'sum', total_sql: 'SELECT SUM("net_amount") FROM data' },
  narrative_instructions: 'Mention the top store.',
  ...over,
});
const goodNarrative = { narrative_template: '{{r0.store}} had the highest net sales at {{r0.net}} across {{rows}} stores.', follow_ups: ['Which card type earns most?'] };

type Reply = unknown | Error;

/** A fake client: replies are consumed per tool name, in order. Records every request. */
function fakeLlm(replies: Record<string, Reply[]>) {
  const requests: Array<ToolCallRequest<unknown>> = [];
  const client: LlmClient = {
    provider: 'openrouter',
    modelFor: (role) => (role === 'planner' ? 'test/planner' : 'test/fast'),
    async callTool<T>(req: ToolCallRequest<T>) {
      requests.push(req as ToolCallRequest<unknown>);
      const next = replies[req.tool.name]?.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`no reply queued for ${req.tool.name}`);
      const parsed = req.schema.safeParse(next);
      if (!parsed.success) throw new LlmError('invalid_output', 'bad', { model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0 });
      return { output: parsed.data, usage: { model: req.role === 'planner' ? 'test/planner' : 'test/fast', inputTokens: 100, outputTokens: 20, costUsd: 0.001 } };
    },
  };
  return { client, requests };
}

let recordLlm: ReturnType<typeof vi.fn<AskDeps['recordLlm']>>;
beforeEach(() => {
  recordLlm = vi.fn(async () => undefined);
});
const purposes = () => recordLlm.mock.calls.map((c) => c[0]);

describe('ask: success', () => {
  it('answers with numbers from DuckDB, tokens rendered, all checks ok', async () => {
    const { client, requests } = fakeLlm({ plan_analysis: [goodPlan()], write_narrative: [goodNarrative] });
    const r = await ask(input, { llm: client, recordLlm });
    expect(r.kind).toBe('answered');
    if (r.kind !== 'answered') return;
    const b = r.block;
    const top = Object.entries(expected.net_by_store as Record<string, number>).sort((x, y) => y[1] - x[1])[0]!;
    expect(b.rows[0]).toEqual({ store: top[0], net: top[1] });
    expect(b.row_count).toBe(3);
    expect(b.narrative.replace(/[  ]/g, ' ')).toBe(`${top[0]} had the highest net sales at R 99 284,58 across 3 stores.`);
    expect(b.checks.map((c) => [c.type, c.ok])).toEqual([
      ['sql_read_only', true],
      ['numbers_from_data', true],
      ['result_not_truncated', true],
      ['total_reconciles', true],
    ]);
    const rec = b.checks.find((c) => c.type === 'total_reconciles')!;
    expect(rec.expected).toBeCloseTo(expected.sums.net_amount, 2);
    expect(rec.actual).toBeCloseTo(expected.sums.net_amount, 2);
    expect(b.status).toBe('ok');
    expect(b.columns).toEqual([
      { name: 'store', format: 'text' },
      { name: 'net', format: 'zar' },
    ]);
    expect(b.model).toBe('test/planner');
    expect(purposes()).toEqual(['plan', 'narrate']);
    // The narrator was told about truncation and given row-indexed data.
    expect(requests[1]!.system).toContain('If the result was truncated (false)');
    expect(requests[1]!.user).toContain('\nr0 | ');
  });
});

describe('ask: cannot answer and repair', () => {
  it('can_answer false is cannot_answer with the planner reason', async () => {
    const { client } = fakeLlm({ plan_analysis: [{ can_answer: false, reason_if_not: 'The file has no profit column.' }] });
    expect(await ask(input, { llm: client, recordLlm })).toEqual({ kind: 'cannot_answer', message: 'The file has no profit column.' });
    expect(purposes()).toEqual(['plan']);
  });

  it('repairs invalid SQL once, sending only the DuckDB error', async () => {
    const bad = goodPlan({ sql: 'SELECT "shop", SUM("net_amount") AS net FROM data GROUP BY 1' });
    const { client, requests } = fakeLlm({ plan_analysis: [bad, goodPlan()], write_narrative: [goodNarrative] });
    const r = await ask(input, { llm: client, recordLlm });
    expect(r.kind).toBe('answered');
    expect(purposes()).toEqual(['plan', 'repair', 'narrate']);
    const repair = requests[1]!;
    expect(repair.followUps).toHaveLength(2);
    expect(repair.followUps![0]).toEqual({ role: 'assistant', content: JSON.stringify(bad) });
    expect(repair.followUps![1]!.content).toMatch(/^The query failed with this error: .*shop.*\. Return a corrected plan_analysis\. Do not change what the question asks\.$/s);
    expect(repair.followUps![1]!.content).not.toContain('Padstal'); // no row data
  });

  it('repairs a plan whose chart names a column the SQL does not return', async () => {
    const bad = goodPlan({ chart: { ...goodPlan().chart, y: ['total'] } });
    const { client, requests } = fakeLlm({ plan_analysis: [bad, goodPlan()], write_narrative: [goodNarrative] });
    expect((await ask(input, { llm: client, recordLlm })).kind).toBe('answered');
    expect(requests[1]!.followUps![1]!.content).toContain('chart.y[0] "total" is not a result column');
  });

  it('repairs a plan that fails the schema, and a bad source_filter_sql', async () => {
    const { client } = fakeLlm({ plan_analysis: [{ can_answer: true, title: 'x'.repeat(90), sql: BY_STORE_SQL }, goodPlan()], write_narrative: [goodNarrative] });
    expect((await ask(input, { llm: client, recordLlm })).kind).toBe('answered');
    const second = fakeLlm({ plan_analysis: [goodPlan({ source_filter_sql: '"nope" > 1' }), goodPlan()], write_narrative: [goodNarrative] });
    expect((await ask(input, { llm: second.client, recordLlm })).kind).toBe('answered');
    expect(second.requests[1]!.followUps![1]!.content).toContain('source_filter_sql failed');
  });

  it('a failed repair is cannot_answer, and only one repair is tried', async () => {
    const bad = goodPlan({ sql: 'SELECT "shop" FROM data' });
    const { client } = fakeLlm({ plan_analysis: [bad, bad, bad] });
    expect(await ask(input, { llm: client, recordLlm })).toEqual({ kind: 'cannot_answer', message: CANNOT_BUILD_QUERY });
    expect(purposes()).toEqual(['plan', 'repair']);
  });

  it('a forbidden query is repaired too (and never runs)', async () => {
    const evil = goodPlan({ sql: `SELECT * FROM read_csv('/etc/passwd')` });
    const { client, requests } = fakeLlm({ plan_analysis: [evil, goodPlan()], write_narrative: [goodNarrative] });
    expect((await ask(input, { llm: client, recordLlm })).kind).toBe('answered');
    expect(requests[1]!.followUps![1]!.content).toMatch(/Table functions are not allowed|READ_CSV/);
  });
});

describe('ask: narrator', () => {
  it('retries once when tokens fail, then succeeds', async () => {
    const broken = { narrative_template: 'Padstal sold 99,284.58 rand, {{r9.net}}.', follow_ups: [] };
    const { client, requests } = fakeLlm({ plan_analysis: [goodPlan()], write_narrative: [broken, goodNarrative] });
    const r = await ask(input, { llm: client, recordLlm });
    if (r.kind !== 'answered') throw new Error('expected an answer');
    expect(r.block.status).toBe('ok');
    expect(purposes()).toEqual(['plan', 'narrate', 'narrate']);
    expect(recordLlm.mock.calls[2]![2]).toMatchObject({ retry: true });
    const retryLine = requests[2]!.followUps![1]!.content;
    expect(retryLine).toMatch(/^Your previous text broke these rules: .*\. Rewrite it\.$/);
    expect(retryLine).toContain('"99,284.58"');
    expect(retryLine).toContain('{{r9.net}}');
  });

  it('a second failure stores a flagged block with [?] for unresolved tokens', async () => {
    const broken = { narrative_template: '{{r0.store}} led with {{r0.profit}}, about 99 thousand.', follow_ups: [] };
    const { client } = fakeLlm({ plan_analysis: [goodPlan()], write_narrative: [broken, broken] });
    const r = await ask(input, { llm: client, recordLlm });
    if (r.kind !== 'answered') throw new Error('expected an answer');
    expect(r.block.status).toBe('flagged');
    expect(r.block.narrative).toContain(UNRESOLVED);
    expect(r.block.narrative).toContain('99 thousand'); // free-standing numbers left in place
    const check = r.block.checks.find((c) => c.type === 'numbers_from_data')!;
    expect(check.ok).toBe(false);
    expect(check.label).toMatch(/could not be checked/);
  });
});

describe('ask: model failures', () => {
  it('a planner timeout fails the ask (502) and still records the call', async () => {
    const { client } = fakeLlm({ plan_analysis: [new LlmError('timeout', 'slow')] });
    await expect(ask(input, { llm: client, recordLlm })).rejects.toBeInstanceOf(AskLlmFailure);
    expect(recordLlm).toHaveBeenCalledTimes(1);
    expect(recordLlm.mock.calls[0]![0]).toBe('plan');
    expect(recordLlm.mock.calls[0]![2]).toMatchObject({ error: 'timeout' });
    expect(recordLlm.mock.calls[0]![1]).toEqual({ model: 'test/planner', inputTokens: null, outputTokens: null, costUsd: null });
  });

  it('a narrator failure fails the ask after the plan was recorded', async () => {
    const { client } = fakeLlm({ plan_analysis: [goodPlan()], write_narrative: [new LlmError('server', 'down')] });
    await expect(ask(input, { llm: client, recordLlm })).rejects.toBeInstanceOf(AskLlmFailure);
    expect(purposes()).toEqual(['plan', 'narrate']);
  });
});

describe('ask: reconcile and truncation', () => {
  it('a breakdown that does not add up to the total is flagged with expected and actual', async () => {
    const plan = goodPlan({ reconcile: { column: 'net', aggregation: 'sum', total_sql: 'SELECT SUM("gross_amount") FROM data' } });
    const { client } = fakeLlm({ plan_analysis: [plan], write_narrative: [goodNarrative] });
    const r = await ask(input, { llm: client, recordLlm });
    if (r.kind !== 'answered') throw new Error('expected an answer');
    const check = r.block.checks.find((c) => c.type === 'total_reconciles')!;
    expect(check).toMatchObject({ ok: false, label: 'Total of net does not match your file' });
    expect(check.expected).toBeCloseTo(expected.sums.gross_amount, 2);
    expect(check.actual).toBeCloseTo(expected.sums.net_amount, 2);
    expect(r.block.status).toBe('flagged');
  });

  it('a reconcile query that fails is a visible failed check, not skipped', async () => {
    const plan = goodPlan({ reconcile: { column: 'net', aggregation: 'sum', total_sql: 'SELECT SUM("profit") FROM data' } });
    const { client } = fakeLlm({ plan_analysis: [plan], write_narrative: [goodNarrative] });
    const r = await ask(input, { llm: client, recordLlm });
    if (r.kind !== 'answered') throw new Error('expected an answer');
    expect(r.block.checks.find((c) => c.type === 'total_reconciles')).toMatchObject({ ok: false, label: 'We could not check the total of net' });
    expect(r.block.status).toBe('flagged');
  });

  it('a count breakdown reconciles', async () => {
    const plan = goodPlan({
      sql: 'SELECT "card_type", count(*) AS n FROM data GROUP BY 1 ORDER BY n DESC',
      chart: { type: 'bar', x: 'card_type', y: ['n'], series: null, orientation: 'vertical', stacked: false, value_format: { card_type: 'text', n: 'integer' } },
      reconcile: { column: 'n', aggregation: 'sum', total_sql: 'SELECT count(*) FROM data' },
    });
    const { client } = fakeLlm({ plan_analysis: [plan], write_narrative: [{ narrative_template: '{{r0.card_type}} was used most.', follow_ups: [] }] });
    const r = await ask(input, { llm: client, recordLlm });
    if (r.kind !== 'answered') throw new Error('expected an answer');
    expect(r.block.checks.find((c) => c.type === 'total_reconciles')).toMatchObject({ ok: true, expected: 240, actual: 240 });
  });

  it('more than 500 result rows: 500 stored, true count kept, flagged, narrator told', async () => {
    const plan = goodPlan({
      sql: 'SELECT a."reference" AS ref_a, b."reference" AS ref_b FROM data a, data b',
      chart: { type: 'table', x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: { ref_a: 'text', ref_b: 'text' } },
      reconcile: null,
    });
    const { client, requests } = fakeLlm({ plan_analysis: [plan], write_narrative: [{ narrative_template: 'The table pairs every reference.', follow_ups: [] }] });
    const r = await ask(input, { llm: client, recordLlm });
    if (r.kind !== 'answered') throw new Error('expected an answer');
    expect(r.block.rows).toHaveLength(500);
    expect(r.block.row_count).toBe(240 * 240);
    expect(r.block.truncated).toBe(true);
    expect(r.block.checks.find((c) => c.type === 'result_not_truncated')).toMatchObject({ ok: false });
    expect(r.block.status).toBe('flagged');
    expect(requests[1]!.system).toContain('If the result was truncated (true)');
    expect(requests[1]!.user).toContain('Truncated: true');
  });
});

describe('ask: tool-choice fallback with the real client (mocked HTTP)', () => {
  beforeEach(() => resetLearnedCaps());

  it('plans with Sonnet 5.5 in auto mode and narrates with Haiku 5.5 forced', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const reply = (name: string, args: unknown) =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
        }),
      );
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      const tool = ((body.tools as Array<{ function: { name: string } }>)[0]!).function.name;
      return tool === 'plan_analysis' ? reply(tool, goodPlan()) : reply(tool, goodNarrative);
    });
    const client = createLlmClient({
      provider: openRouterProvider({ apiKey: 'k', title: 'T', fetch: fetchMock as unknown as typeof fetch }),
      models: { planner: 'anthropic/claude-sonnet-5.5', fast: 'anthropic/claude-haiku-5.5' },
    });
    const r = await ask(input, { llm: client, recordLlm });
    expect(r.kind).toBe('answered');
    expect(bodies[0]!.tool_choice).toBe('auto');
    expect(String((bodies[0]!.messages as Array<{ content: string }>)[0]!.content)).toMatch(/Always answer by calling the plan_analysis tool\.$/);
    expect(bodies[1]!.tool_choice).toEqual({ type: 'function', function: { name: 'write_narrative' } });
    for (const b of bodies) expect(b).not.toHaveProperty('temperature');
  });
});
