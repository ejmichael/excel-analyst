import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type LlmClient, type ToolCallRequest } from '../../src/llm/client.js';
import { overlappingPieAsBar } from '../../src/services/analysis/chartSafety.js';
import { ask, type AskInput } from '../../src/services/analysis/ask.js';
import { planDashboard } from '../../src/services/dashboard/planner.js';
import type { DashboardColumn } from '../../src/services/dashboard/widgets.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import type { ChartSpec } from '../../src/types/api.js';

// 10 leads: 8 have a phone, 3 an email, 6 a website (the counts overlap: 17 > 10); status splits them 6 / 4.
const LEADS = Array.from({ length: 10 }, (_, i) => [
  `Biz ${i}`,
  i < 8 ? `08212345${i}0` : '',
  i < 3 ? `b${i}@example.com` : '',
  i < 6 ? `https://b${i}.co.za` : '',
  i < 6 ? 'new' : 'contacted',
  (100 + i * 10).toFixed(2),
  ['Salon', 'Gym'][i % 2]!,
]);
const CSV = Buffer.from(`Business,Phone,Email,Website,Status,Value,Niche\n${LEADS.map((r) => r.join(',')).join('\n')}\n`);

const pie = (x: string, y: string, vf: Record<string, 'text' | 'integer' | 'zar'>): ChartSpec => ({ type: 'pie', x, y: [y], series: null, orientation: 'vertical', stacked: false, value_format: vf });
const OVERLAP_SQL = `SELECT 'Phone' AS detail, count("phone") AS leads FROM data UNION ALL SELECT 'Email', count("email") FROM data UNION ALL SELECT 'Website', count("website") FROM data`;
const SPLIT_SQL = 'SELECT "status", count(*) AS leads FROM data GROUP BY 1 ORDER BY 1';
const VALUE_SQL = 'SELECT "niche", round(sum("value"), 2) AS total FROM data GROUP BY 1 ORDER BY 1';

let input: AskInput;
let dashColumns: DashboardColumn[];
beforeAll(async () => {
  const p = await profileFile({ buffer: CSV, fileType: 'csv', options: {}, maxRows: 1000 });
  dashColumns = p.columns.map((c) => ({ ...c, display_name: null }));
  input = {
    ownerId: 'o',
    datasetId: 'd',
    datasetName: 'Leads',
    rowCount: p.rowCount,
    columns: p.columns.map((c) => ({ ...c, display_name: null, vat_included: null })),
    csv: p.normalisedCsv,
    question: 'Which contact details do we have?',
    source: 'user',
  };
});

function llmFor(plans: Record<string, unknown>) {
  const client: LlmClient = {
    provider: 'openrouter',
    modelFor: () => 'test',
    callTool: vi.fn(async (req: ToolCallRequest<unknown>) => {
      const output = plans[req.tool.name];
      return { output: req.schema.parse(output), usage: { model: 'test', inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    }) as LlmClient['callTool'],
  };
  return client;
}

async function askWith(sql: string, chart: ChartSpec) {
  const plan = { can_answer: true, title: 'Contact details', sql, source_filter_sql: null, chart, reconcile: null, narrative_instructions: 'x' };
  const r = await ask(input, { llm: llmFor({ plan_analysis: plan, write_narrative: { narrative_template: 'See the chart.', follow_ups: [] } }), recordLlm: async () => undefined });
  if (r.kind !== 'answered') throw new Error(r.kind);
  return r.block.chart;
}

describe('pie rule: Ask', () => {
  it('a pie of overlapping counts becomes a horizontal bar (same x and y, not stacked)', async () => {
    const chart = await askWith(OVERLAP_SQL, pie('detail', 'leads', { detail: 'text', leads: 'integer' }));
    expect(chart).toEqual({ type: 'bar', x: 'detail', y: ['leads'], series: null, orientation: 'horizontal', stacked: false, value_format: { detail: 'text', leads: 'integer' } });
  });

  it('a real pie whose slices add up to the rows is untouched', async () => {
    expect((await askWith(SPLIT_SQL, pie('status', 'leads', { status: 'text', leads: 'integer' }))).type).toBe('pie');
  });

  it('a pie of a non-count column is untouched', async () => {
    expect((await askWith(VALUE_SQL, pie('niche', 'total', { niche: 'text', total: 'zar' }))).type).toBe('pie');
  });
});

describe('pie rule: dashboard', () => {
  it('only the overlapping pie becomes a bar', async () => {
    const kpi = (t: string) => ({ title: t, sql: 'SELECT count(*) AS n FROM data', width: 'quarter', chart: { type: 'kpi', x: null, y: ['n'], series: null, orientation: 'vertical', stacked: false, value_format: { n: 'integer' } } });
    const widget = (title: string, sql: string, chart: ChartSpec) => ({ title, sql, width: 'half', chart });
    const plan = {
      reading: 'One row per lead.',
      date_column: null,
      filter_columns: [],
      widgets: [
        kpi('A'),
        kpi('B'),
        kpi('C'),
        widget('Contact details', OVERLAP_SQL, pie('detail', 'leads', { detail: 'text', leads: 'integer' })),
        widget('Status', SPLIT_SQL, pie('status', 'leads', { status: 'text', leads: 'integer' })),
        widget('Value by niche', VALUE_SQL, pie('niche', 'total', { niche: 'text', total: 'zar' })),
      ],
    };
    const r = await planDashboard({ datasetName: 'Leads', rowCount: input.rowCount, columns: dashColumns, csv: input.csv }, { llm: llmFor({ plan_dashboard: plan }), recordLlm: async () => undefined });
    expect(r.plan.widgets.slice(3).map((w) => [w.title, w.chart.type, w.chart.orientation])).toEqual([
      ['Contact details', 'bar', 'horizontal'],
      ['Status', 'pie', 'vertical'],
      ['Value by niche', 'pie', 'vertical'],
    ]);
  });

  it('the check on its own', () => {
    const c = pie('k', 'n', { k: 'text', n: 'integer' });
    expect(overlappingPieAsBar(c, [{ k: 'a', n: 6 }, { k: 'b', n: 4 }], 10).type).toBe('pie');
    expect(overlappingPieAsBar(c, [{ k: 'a', n: 6 }, { k: 'b', n: 5 }], 10).type).toBe('bar');
    expect(overlappingPieAsBar({ ...c, type: 'bar' }, [{ k: 'a', n: 99 }], 10).orientation).toBe('vertical');
  });
});
