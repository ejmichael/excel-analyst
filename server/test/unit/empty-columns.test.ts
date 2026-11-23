import { describe, expect, it, vi } from 'vitest';
import { type LlmClient, LlmError, type ToolCallRequest } from '../../src/llm/client.js';
import { buildPlannerUser } from '../../src/services/analysis/prompts.js';
import { planDashboard } from '../../src/services/dashboard/planner.js';
import type { DashboardColumn } from '../../src/services/dashboard/widgets.js';
import { buildSuggestionsPrompt } from '../../src/services/suggestions.js';

// A leads file with two columns that are empty in every row.
const col = (sql_name: string, data_type: DashboardColumn['data_type'], semantic: DashboardColumn['semantic'], distinct: number, nulls = 0): DashboardColumn => ({
  name: sql_name,
  display_name: null,
  sql_name,
  data_type,
  semantic,
  is_pii: false,
  null_count: nulls,
  distinct_count: distinct,
  min_value: null,
  max_value: null,
});
const COLUMNS = [
  col('business', 'text', 'none', 6),
  col('niche', 'text', 'category', 3),
  col('date_email_sent', 'date', 'none', 0, 6),
  col('outreach_sent', 'text', 'category', 0, 6),
];
const CSV = Buffer.from(`business,niche,date_email_sent,outreach_sent\n${Array.from({ length: 6 }, (_, i) => `Biz ${i},${['Salon', 'Gym', 'Spa'][i % 3]},,`).join('\n')}\n`);
const SAMPLES = Array.from({ length: 5 }, (_, i) => ({ business: `Biz ${i}`, niche: 'Salon', date_email_sent: '', outreach_sent: '' }));
const prompt = { ...COLUMNS[0]!, vat_included: null };

describe('columns empty in every row', () => {
  it('are left out of the suggestions input (schema and samples)', () => {
    const { user } = buildSuggestionsPrompt({ datasetName: 'Leads', rowCount: 6, columns: COLUMNS.map((c) => ({ ...c, vat_included: null })), sampleRows: SAMPLES });
    expect(user).toContain('"business"');
    expect(user).toContain('"niche"');
    expect(user).not.toContain('date_email_sent');
    expect(user).not.toContain('outreach_sent');
    const header = user.split('\n')[user.split('\n').indexOf('<data>') + 1];
    expect(header).toBe('business | niche');
  });

  it('are left out of the dashboard planner input, and the Ask planner still sees them', async () => {
    let sent = '';
    const llm: LlmClient = {
      provider: 'openrouter',
      modelFor: () => 'test/planner',
      callTool: vi.fn(async (req: ToolCallRequest<unknown>) => {
        sent = req.user;
        throw new LlmError('server', 'stop here');
      }) as LlmClient['callTool'],
    };
    await planDashboard({ datasetName: 'Leads', rowCount: 6, columns: COLUMNS, csv: CSV }, { llm, recordLlm: async () => undefined });
    expect(sent).toContain('business | business | text');
    expect(sent).not.toContain('date_email_sent');
    expect(sent).not.toContain('outreach_sent');

    const ask = buildPlannerUser({ question: 'When was outreach sent?', datasetName: 'Leads', rowCount: 6, columns: COLUMNS.map((c) => ({ ...prompt, ...c })), sampleRows: SAMPLES });
    expect(ask).toContain('date_email_sent');
    expect(ask).toContain('outreach_sent');
  });

  it('are not used by the fallback dashboard or as filters', async () => {
    const llm: LlmClient = { provider: 'openrouter', modelFor: () => 'x', callTool: vi.fn(async () => Promise.reject(new LlmError('server', 'x'))) as LlmClient['callTool'] };
    const r = await planDashboard({ datasetName: 'Leads', rowCount: 6, columns: COLUMNS, csv: CSV }, { llm, recordLlm: async () => undefined });
    expect(r.fallback).toBe(true);
    const sql = r.plan.widgets.map((w) => w.sql).join('\n');
    expect(sql).not.toContain('date_email_sent');
    expect(sql).not.toContain('outreach_sent');
    expect(r.plan.widgets.map((w) => w.title)).toEqual(['Number of records', 'Records by business', 'Records by niche']);
    expect(r.plan.filters.map((f) => f.id)).toEqual(['cat:business', 'cat:niche']);
    expect(r.plan.reading.date_column).toBeNull();
  });
});
