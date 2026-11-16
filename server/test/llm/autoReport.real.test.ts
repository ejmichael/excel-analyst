import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { autoReportsIdle } from '../../src/services/autoReport.js';
import { profilingIdle } from '../../src/services/profiling.js';
import type { AutoReportRun, Block, CellValue, Dataset, DatasetDetail, ReportDetail, Workspace } from '../../src/types/api.js';
import { bearer, createTestUser, deleteTestUsers, setPlan, type TestUser } from '../integration/helpers.js';
import { bankStatement, cardSales, round2, sumBy, webOrders } from './fixtureRows.js';

/**
 * Opt-in, real models and real Supabase (RUN_LLM_TESTS=1 npm run test:llm; about $0.06 per file): one "Build my
 * report" per fixture 01 to 03 through the real endpoints. Prints status, time, block titles and chart types, flagged
 * blocks and cost, and hand-checks figures against plain JavaScript loops over the raw fixture files.
 * Uses a throwaway test user that is deleted afterwards.
 */

const app = createApp();
const api = (p: string) => `/api/v1${p}`;
const FIXTURES = ['01_card_sales_semicolon_win1252.csv', '02_webstore_orders_utf8bom.csv', '03_bank_statement_comma_quoted.csv'];

// ---------- hand-computed truth: (label -> value) maps a block's rows may contain ----------

const card = cardSales();
const web = webOrders();
const bank = bankStatement();
const paid = web.filter((r) => r.status === 'paid');
const TRUTH: Record<string, Record<string, Map<string, number>>> = {
  [FIXTURES[0]!]: {
    'net by store': sumBy(card, (r) => r.store, (r) => r.net),
    'gross by store': sumBy(card, (r) => r.store, (r) => r.gross),
    'net by card type': sumBy(card, (r) => r.card, (r) => r.net),
    'gross by card type': sumBy(card, (r) => r.card, (r) => r.gross),
    'transactions by card type': sumBy(card, (r) => r.card, () => 1),
    'transactions by store': sumBy(card, (r) => r.store, () => 1),
    'gross by day': sumBy(card, (r) => r.date, (r) => r.gross),
    'net by day': sumBy(card, (r) => r.date, (r) => r.net),
  },
  [FIXTURES[1]!]: {
    'total by product (all)': sumBy(web, (r) => r.product, (r) => r.total),
    'total by product (paid)': sumBy(paid, (r) => r.product, (r) => r.total),
    'units by product (all)': sumBy(web, (r) => r.product, (r) => r.quantity),
    'units by product (paid)': sumBy(paid, (r) => r.product, (r) => r.quantity),
    'total by province (all)': sumBy(web, (r) => r.province, (r) => r.total),
    'total by province (paid)': sumBy(paid, (r) => r.province, (r) => r.total),
    'orders by status': sumBy(web, (r) => r.status, () => 1),
    'total by status': sumBy(web, (r) => r.status, (r) => r.total),
    'orders by province': sumBy(web, (r) => r.province, () => 1),
  },
  [FIXTURES[2]!]: {
    'amount by description': sumBy(bank, (r) => r.description, (r) => r.amount),
    'money out by description': sumBy(bank.filter((r) => r.amount < 0), (r) => r.description, (r) => -r.amount),
    'amount by day': sumBy(bank, (r) => r.date, (r) => r.amount),
  },
};
/** Single totals a KPI-style block may hold. */
const TOTALS: Record<string, Record<string, number>> = {
  [FIXTURES[0]!]: { 'net total': round2(card.reduce((s, r) => s + r.net, 0)), 'gross total': round2(card.reduce((s, r) => s + r.gross, 0)), transactions: card.length },
  [FIXTURES[1]!]: { 'paid total': round2(paid.reduce((s, r) => s + r.total, 0)), 'all orders total': round2(web.reduce((s, r) => s + r.total, 0)), orders: web.length },
  [FIXTURES[2]!]: {
    'money in': round2(bank.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
    'money out': round2(bank.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0)),
    'net movement': round2(bank.reduce((s, r) => s + r.amount, 0)),
    transactions: bank.length,
  },
};

const numbersIn = (row: Record<string, CellValue>) => Object.values(row).filter((v): v is number => typeof v === 'number');
const textsIn = (row: Record<string, CellValue>) => Object.values(row).filter((v): v is string => typeof v === 'string');
const close = (a: number, b: number) => Math.abs(a - b) < 0.01 || Math.abs(Math.abs(a) - Math.abs(b)) < 0.01;

/** Figures in the block that equal a hand-computed value for the same label (or a hand-computed total). */
function handChecks(fixture: string, b: Block): string[] {
  const found: string[] = [];
  for (const [what, truth] of Object.entries(TRUTH[fixture]!)) {
    for (const row of b.rows) {
      const label = textsIn(row).find((t) => truth.has(t) || truth.has(t.slice(0, 10)));
      if (label === undefined) continue;
      const expected = truth.get(label) ?? truth.get(label.slice(0, 10))!;
      const n = numbersIn(row).find((v) => close(v, expected));
      if (n !== undefined) found.push(`${what}: "${label}" = ${n} (by hand ${expected})`);
    }
  }
  if (b.rows.length === 1) {
    for (const [what, expected] of Object.entries(TOTALS[fixture]!)) {
      const n = numbersIn(b.rows[0]!).find((v) => close(v, expected));
      if (n !== undefined) found.push(`${what} = ${n} (by hand ${expected})`);
    }
  }
  return [...new Set(found)];
}

// ---------- the runs ----------

let u: TestUser;
let ws: string;
const report: string[] = [];
let checkedFigures = 0;
let flaggedTotal = 0;

async function uploadReady(filename: string): Promise<string> {
  const buffer = readFileSync(new URL(`../../../fixtures/${filename}`, import.meta.url));
  const res = await request(app).post(api('/datasets')).set(bearer(u)).field('workspace_id', ws).attach('file', buffer, filename).expect(201);
  const id = (res.body.data as Dataset).id;
  for (let i = 0; i < 240; i++) {
    const d = (await request(app).get(api(`/datasets/${id}`)).set(bearer(u)).expect(200)).body.data as DatasetDetail;
    if (d.status === 'ready') return id;
    if (d.status === 'failed') throw new Error(`profiling failed: ${d.error_message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('profiling did not finish');
}

describe.skipIf(!process.env.RUN_LLM_TESTS)('auto-report with the real models', () => {
  beforeAll(async () => {
    u = await createTestUser();
    await setPlan(u.id, 'practice');
    await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
    ws = ((await request(app).get(api('/workspaces')).set(bearer(u)).expect(200)).body.data as Workspace[])[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await autoReportsIdle();
    await profilingIdle();
    await deleteTestUsers();
    report.push(`\n=== SUMMARY: ${checkedFigures} figures hand-checked and equal; flagged blocks: ${flaggedTotal}`);
    console.log(report.join('\n'));
    if (process.env.LLM_REPORT) writeFileSync(`${process.env.LLM_REPORT}.auto-report.txt`, report.join('\n'));
  }, 120_000);

  it.each(FIXTURES)('%s', async (fixture) => {
    const datasetId = await uploadReady(fixture);
    const suggestions = ((await request(app).get(api(`/datasets/${datasetId}`)).set(bearer(u)).expect(200)).body.data as DatasetDetail).suggestions;
    const since = new Date().toISOString();
    const started = Date.now();
    const res = await request(app).post(api(`/datasets/${datasetId}/auto-report`)).set(bearer(u)).send({ period_label: 'October 2026' });
    expect(res.status).toBe(202);
    let run = res.body.data as AutoReportRun;
    while (run.status === 'running') {
      await new Promise((r) => setTimeout(r, 2000)); // the client's polling interval
      run = (await request(app).get(api(`/auto-reports/${run.id}`)).set(bearer(u)).expect(200)).body.data as AutoReportRun;
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const { data: llmRows } = await supabaseAdmin().from('usage_events').select('cost_usd, meta').eq('owner_id', u.id).eq('kind', 'llm').gte('created_at', since);
    const cost = (llmRows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    const calls = (llmRows ?? []).length;

    report.push(`\n=== ${fixture}: ${run.status} in ${seconds} s, ${run.blocks_done}/${run.blocks_total} questions, ${calls} model calls, $${cost.toFixed(6)}`);
    report.push(`suggestions: ${suggestions.map((s) => s.question).join(' | ')}`);
    if (run.status === 'failed') report.push(`error_message: ${run.error_message}`);
    if (run.report_id) {
      const detail = (await request(app).get(api(`/reports/${run.report_id}`)).set(bearer(u)).expect(200)).body.data as ReportDetail;
      report.push(`report: "${detail.title}" (${detail.period_label}), ${detail.blocks.length} blocks`);
      for (const rb of detail.blocks) {
        const b = rb.block;
        if (b.status === 'flagged') flaggedTotal++;
        const checks = handChecks(fixture, b);
        checkedFigures += checks.length;
        report.push(`  ${rb.position + 1}. ${b.title} [${b.chart.type}] ${b.status}${b.status === 'flagged' ? ` (${b.checks.filter((c) => !c.ok).map((c) => c.type).join(', ')})` : ''}, source ${b.source}`);
        report.push(`     first rows: ${JSON.stringify(b.rows.slice(0, 3))}`);
        for (const c of checks.slice(0, 3)) report.push(`     hand-check OK: ${c}`);
      }
    }
    expect(run.status).toBe('done');
  }, 300_000);

  it('hand-checked at least three figures across the runs', () => {
    expect(checkedFigures).toBeGreaterThanOrEqual(3);
  });
});
