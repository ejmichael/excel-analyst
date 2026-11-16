import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, setPlan, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { autoReportsIdle, FILE_DELETED, NOT_ENOUGH_SUGGESTIONS, sweepInterruptedAutoReports } from '../../src/services/autoReport.js';
import { INTERRUPTED_MESSAGE, profilingIdle } from '../../src/services/profiling.js';
import type { AutoReportRun, Dataset, DatasetDetail, ReportDetail, Workspace } from '../../src/types/api.js';

/**
 * "Build my report" (S3b) against real Supabase with a mocked model. A question's first word sets what the mock does:
 * OK answers (title = the question), CANNOT is cannot_answer, FAIL is a failed model call, FLAG answers with a narrative
 * holding a free-standing number (so the block is flagged), SLOW answers after a delay.
 */
vi.mock('../../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/client.js')>();
  const usage = (model: string) => ({ model, inputTokens: 200, outputTokens: 40, costUsd: 0.0012 });
  const fake = {
    provider: 'openrouter' as const,
    modelFor: (role: string) => (role === 'planner' ? 'test/planner' : 'test/fast'),
    callTool: vi.fn(async (req: { tool: { name: string }; user: string }) => {
      const question = /^Question: (.*)$/m.exec(req.user)?.[1] ?? '';
      const words = question.split(' ');
      if (req.tool.name === 'plan_analysis') {
        if (words.includes('SLOW')) await new Promise((r) => setTimeout(r, 1500));
        if (words.includes('FAIL')) throw new actual.LlmError('server', 'The model call failed (HTTP 500).', undefined, 500);
        if (words.includes('CANNOT')) return { output: { can_answer: false, reason_if_not: 'This file has no such column.' }, usage: usage('test/planner') };
        return {
          output: {
            can_answer: true,
            title: question,
            sql: 'SELECT "item", ROUND(SUM("amount"), 2) AS amount FROM data GROUP BY 1 ORDER BY 2 DESC',
            source_filter_sql: null,
            chart: { type: 'bar', x: 'item', y: ['amount'], series: null, orientation: 'vertical', stacked: false, value_format: { item: 'text', amount: 'zar' } },
            reconcile: null,
            narrative_instructions: 'Name the top item.',
          },
          usage: usage('test/planner'),
        };
      }
      if (req.tool.name === 'write_narrative') {
        const template = words.includes('FLAG') ? 'We sold 1234 cakes.' : '{{r0.item}} sold the most, at {{r0.amount}}.';
        return { output: { narrative_template: template, follow_ups: [] }, usage: usage('test/fast') };
      }
      throw new actual.LlmError('invalid_output', 'not used in this test');
    }),
  };
  return { ...actual, llm: () => fake };
});

const app = createApp();
const api = (p: string) => `/api/v1${p}`;
const TINY = Buffer.from('Item,Amount\nTea,5.00\nCoffee,6.50\nCake,7.25\n');

let a: TestUser; // practice
let b: TestUser; // free: quota pre-check, cross-user
let dsA: string; // reused run after run (suggestions are set before each)
let dsGone: string; // deleted mid-run
let dsB: string;

async function consent(u: TestUser): Promise<string> {
  await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
  return ((await request(app).get(api('/workspaces')).set(bearer(u)).expect(200)).body.data as Workspace[])[0]!.id;
}

async function uploadReady(u: TestUser, workspace: string, filename: string): Promise<string> {
  const res = await request(app).post(api('/datasets')).set(bearer(u)).field('workspace_id', workspace).attach('file', TINY, filename).expect(201);
  const id = (res.body.data as Dataset).id;
  for (let i = 0; i < 240; i++) {
    const d = (await request(app).get(api(`/datasets/${id}`)).set(bearer(u)).expect(200)).body.data as DatasetDetail;
    if (d.status === 'ready') return id;
    if (d.status === 'failed') throw new Error(`profiling failed: ${d.error_message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('profiling did not finish');
}

async function setSuggestions(datasetId: string, questions: string[]): Promise<void> {
  const { error } = await supabaseAdmin().from('datasets').update({ suggestions: questions.map((question) => ({ question, why: 'test' })) }).eq('id', datasetId);
  if (error) throw new Error(error.code);
}

async function setStatus(datasetId: string, status: string): Promise<void> {
  const { error } = await supabaseAdmin().from('datasets').update({ status }).eq('id', datasetId);
  if (error) throw new Error(error.code);
}

const count = async (table: string, filter: Record<string, string>) => {
  let q = supabaseAdmin().from(table).select('id', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  return (await q).count ?? 0;
};
const events = (u: TestUser, kind: string) => count('usage_events', { owner_id: u.id, kind });
const datasetBlocks = (datasetId: string) => count('blocks', { dataset_id: datasetId });

const start = (u: TestUser, datasetId: string, body: Record<string, unknown> = {}) =>
  request(app).post(api(`/datasets/${datasetId}/auto-report`)).set(bearer(u)).send(body);
const getRun = async (u: TestUser, id: string) => (await request(app).get(api(`/auto-reports/${id}`)).set(bearer(u)).expect(200)).body.data as AutoReportRun;
const getReport = async (u: TestUser, id: string) => (await request(app).get(api(`/reports/${id}`)).set(bearer(u)).expect(200)).body.data as ReportDetail;

/** Starts a run (202), waits for the job, and returns the finished run with what it counted. */
async function runToEnd(datasetId: string, questions: string[], body: Record<string, unknown> = {}) {
  await setSuggestions(datasetId, questions);
  const before = { question: await events(a, 'question'), report: await events(a, 'report'), llm: await events(a, 'llm'), blocks: await datasetBlocks(datasetId) };
  const res = await start(a, datasetId, body);
  expect(res.status).toBe(202);
  const started = res.body.data as AutoReportRun;
  expect(started).toMatchObject({ dataset_id: datasetId, status: 'running', blocks_done: 0, blocks_total: questions.length, report_id: null, error_message: null });
  await autoReportsIdle();
  const run = await getRun(a, started.id);
  return {
    run,
    questions: (await events(a, 'question')) - before.question,
    reports: (await events(a, 'report')) - before.report,
    llm: (await events(a, 'llm')) - before.llm,
    newBlocks: (await datasetBlocks(datasetId)) - before.blocks,
  };
}

beforeAll(async () => {
  [a, b] = await Promise.all([createTestUser(), createTestUser()]);
  await setPlan(a.id, 'practice');
  const [wsA, wsB] = await Promise.all([consent(a), consent(b)]);
  [dsA, dsGone, dsB] = await Promise.all([uploadReady(a, wsA, 'shop.csv'), uploadReady(a, wsA, 'gone.csv'), uploadReady(b, wsB, 'b.csv')]);
}, 120_000);

afterAll(async () => {
  await autoReportsIdle();
  await profilingIdle();
  await deleteTestUsers();
});

describe('the auto-report job', () => {
  it('happy path: 5 answered, a report with 5 suggested blocks in suggestion order, 5 question events and 1 report event', async () => {
    const questions = ['OK first', 'OK second', 'OK third', 'OK fourth', 'OK fifth'];
    const r = await runToEnd(dsA, questions);
    expect(r.run).toMatchObject({ status: 'done', blocks_done: 5, blocks_total: 5, error_message: null });
    expect(r.questions).toBe(5);
    expect(r.reports).toBe(1);
    expect(r.llm).toBe(10); // plan + narrate per question, as a manual ask writes them
    const report = await getReport(a, r.run.report_id!);
    expect(report.blocks.map((rb) => rb.block.title)).toEqual(questions);
    expect(report.blocks.map((rb) => rb.position)).toEqual([0, 1, 2, 3, 4]);
    expect(report.blocks.every((rb) => rb.block.source === 'suggested' && rb.block.status === 'ok')).toBe(true);
    // Title defaults to the dataset's name; no period_label.
    expect(report.title).toBe('shop'); // the upload's name without its extension
    expect(report.period_label).toBeNull();
  });

  it('uses the given title and period_label', async () => {
    const r = await runToEnd(dsA, ['OK a', 'OK b', 'OK c'], { title: '  October for the owners ', period_label: 'October 2026' });
    expect(r.run.status).toBe('done');
    expect(await getReport(a, r.run.report_id!)).toMatchObject({ title: 'October for the owners', period_label: 'October 2026', block_count: 3 });
  });

  it('one cannot_answer: skipped, 4 blocks', async () => {
    const r = await runToEnd(dsA, ['OK one', 'CANNOT two', 'OK three', 'OK four', 'OK five']);
    expect(r.run).toMatchObject({ status: 'done', blocks_done: 5, blocks_total: 5 });
    expect(r.questions).toBe(4);
    expect((await getReport(a, r.run.report_id!)).blocks.map((rb) => rb.block.title)).toEqual(['OK one', 'OK three', 'OK four', 'OK five']);
  });

  it('two skipped (cannot_answer and a failed model call): 3 blocks, still done', async () => {
    const r = await runToEnd(dsA, ['OK one', 'FAIL two', 'OK three', 'CANNOT four', 'OK five']);
    expect(r.run.status).toBe('done');
    expect(r.questions).toBe(3);
    expect(r.reports).toBe(1);
    expect((await getReport(a, r.run.report_id!)).blocks.map((rb) => rb.block.title)).toEqual(['OK one', 'OK three', 'OK five']);
  });

  it('a failed model call counts as skipped, and its llm event is still written', async () => {
    const r = await runToEnd(dsA, ['OK one', 'FAIL two', 'OK three', 'OK four']);
    expect(r.run).toMatchObject({ status: 'done', blocks_done: 4 });
    expect(r.questions).toBe(3);
    expect(r.llm).toBe(7); // 3 x (plan + narrate) + the failed plan call
    const { data } = await supabaseAdmin().from('usage_events').select('meta').eq('owner_id', a.id).eq('kind', 'llm').eq('meta->>error', 'server');
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('three skipped: failed with a user-safe message, no report, the answered blocks stay', async () => {
    const r = await runToEnd(dsA, ['OK one', 'CANNOT two', 'FAIL three', 'CANNOT four', 'OK five']);
    expect(r.run).toMatchObject({
      status: 'failed',
      blocks_done: 5,
      report_id: null,
      error_message: 'We could only answer 2 of the 5 questions for this file. Try asking your own questions.',
    });
    expect(r.reports).toBe(0);
    expect(r.questions).toBe(2);
    expect(r.newBlocks).toBe(2);
  });

  it('a flagged block is kept and stays flagged in the report', async () => {
    const r = await runToEnd(dsA, ['OK one', 'FLAG two', 'OK three']);
    expect(r.run.status).toBe('done');
    const report = await getReport(a, r.run.report_id!);
    expect(report.blocks.map((rb) => [rb.block.title, rb.block.status])).toEqual([
      ['OK one', 'ok'],
      ['FLAG two', 'flagged'],
      ['OK three', 'ok'],
    ]);
    expect(report.blocks[1]!.block.checks.find((c) => c.type === 'numbers_from_data')?.ok).toBe(false);
    const { data } = await supabaseAdmin().from('usage_events').select('meta').eq('owner_id', a.id).eq('kind', 'question').eq('meta->>block_id', report.blocks[1]!.block.id).single();
    expect((data as { meta: { flagged: boolean } }).meta.flagged).toBe(true);
  });

  it('a second run while one is running is 409, and blocks_done rises while it runs', async () => {
    await setSuggestions(dsA, ['SLOW OK one', 'SLOW OK two', 'SLOW OK three', 'SLOW OK four']);
    const first = (await start(a, dsA).expect(202)).body.data as AutoReportRun;
    const second = await start(a, dsA);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
    let seen = 0;
    for (let i = 0; i < 40 && seen === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const run = await getRun(a, first.id);
      if (run.status === 'running') seen = run.blocks_done;
    }
    expect(seen).toBeGreaterThan(0);
    await autoReportsIdle();
    expect((await getRun(a, first.id)).status).toBe('done');
    // Free again once it has finished.
    await setSuggestions(dsA, ['OK a', 'OK b', 'OK c']);
    expect((await start(a, dsA)).status).toBe(202);
    await autoReportsIdle();
  });

  it('the dataset deleted mid-run: the run stops and fails with "The file was deleted."', async () => {
    await setSuggestions(dsGone, ['SLOW OK one', 'SLOW OK two', 'SLOW OK three', 'SLOW OK four', 'SLOW OK five', 'SLOW OK six']);
    const run = (await start(a, dsGone).expect(202)).body.data as AutoReportRun;
    await new Promise((r) => setTimeout(r, 300));
    await request(app).delete(api(`/datasets/${dsGone}`)).set(bearer(a)).expect(200);
    await autoReportsIdle();
    const after = await getRun(a, run.id);
    expect(after).toMatchObject({ status: 'failed', error_message: FILE_DELETED, report_id: null, dataset_id: null });
    expect(after.blocks_done).toBeLessThan(6);
  });

  it('restart handling: a run left running is failed by the boot sweep', async () => {
    const { data, error } = await supabaseAdmin()
      .from('auto_report_runs')
      .insert({ owner_id: a.id, dataset_id: dsA, blocks_total: 5, blocks_done: 2 })
      .select('id')
      .single<{ id: string }>();
    expect(error).toBeNull();
    expect(await sweepInterruptedAutoReports(a.id)).toBe(1);
    expect(await getRun(a, data!.id)).toMatchObject({ status: 'failed', error_message: INTERRUPTED_MESSAGE, blocks_done: 2, report_id: null });
  });
});

describe('POST /datasets/:id/auto-report refusals', () => {
  it('fewer than 3 suggestions is 422', async () => {
    await setSuggestions(dsA, ['OK one', 'OK two']);
    const res = await start(a, dsA);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'validation_failed', message: NOT_ENOUGH_SUGGESTIONS });
  });

  it('a dataset that is not ready is 409, an expired one 410', async () => {
    await setSuggestions(dsA, ['OK one', 'OK two', 'OK three']);
    try {
      await setStatus(dsA, 'profiling');
      expect((await start(a, dsA)).body.error.code).toBe('dataset_not_ready');
      await setStatus(dsA, 'expired');
      const res = await start(a, dsA);
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('dataset_expired');
    } finally {
      await setStatus(dsA, 'ready');
    }
  });

  it('a body with an unknown field or a long title is 422', async () => {
    expect((await start(a, dsA, { subtitle: 'x' })).status).toBe(422);
    expect((await start(a, dsA, { title: 'x'.repeat(121) })).status).toBe(422);
  });

  it('cross-user: 404 on both endpoints', async () => {
    await setSuggestions(dsA, ['OK one', 'OK two', 'OK three']);
    expect((await start(b, dsA)).status).toBe(404);
    const { data } = await supabaseAdmin().from('auto_report_runs').select('id').eq('owner_id', a.id).limit(1).single<{ id: string }>();
    const res = await request(app).get(api(`/auto-reports/${data!.id}`)).set(bearer(b));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  describe('quota pre-check (free plan: 20 questions, 1 report)', () => {
    const addEvents = async (kind: string, n: number) => {
      const { error } = await supabaseAdmin().from('usage_events').insert(Array.from({ length: n }, () => ({ owner_id: b.id, kind, meta: { test: true } })));
      if (error) throw new Error(error.code);
    };
    const nothingAsked = async (fn: () => Promise<void>) => {
      const before = { llm: await events(b, 'llm'), question: await events(b, 'question'), report: await events(b, 'report'), runs: await count('auto_report_runs', { owner_id: b.id }) };
      await fn();
      await autoReportsIdle();
      expect({ llm: await events(b, 'llm'), question: await events(b, 'question'), report: await events(b, 'report'), runs: await count('auto_report_runs', { owner_id: b.id }) }).toEqual(before);
    };

    it('402 for reports when this month has no report left', async () => {
      await setSuggestions(dsB, ['OK one', 'OK two', 'OK three', 'OK four', 'OK five']);
      await addEvents('report', 1);
      await nothingAsked(async () => {
        const res = await start(b, dsB);
        expect(res.status).toBe(402);
        expect(res.body.error).toMatchObject({ code: 'plan_limit', details: { limit_key: 'max_reports_per_month', limit: 1, used: 1, upgrade_to: 'solo' } });
      });
    });

    it('402 for questions when the remaining questions do not cover every suggestion (checked first)', async () => {
      await addEvents('question', 16); // 4 left, 5 needed
      await nothingAsked(async () => {
        const res = await start(b, dsB);
        expect(res.status).toBe(402);
        expect(res.body.error).toMatchObject({ code: 'plan_limit', details: { limit_key: 'max_questions_per_month', limit: 20, used: 16, upgrade_to: 'solo' } });
      });
    });
  });
});
