import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { llm } from '../../src/llm/client.js';
import { SUGGEST_QUESTIONS_TOOL, SUGGESTIONS_MAX_TOKENS, SUGGESTIONS_SYSTEM, suggestQuestionsSchema } from '../../src/llm/prompts/suggestions.js';
import { planDashboard } from '../../src/services/dashboard/planner.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { buildSuggestionsPrompt } from '../../src/services/suggestions.js';

/**
 * Opt-in, real models (RUN_LLM_TESTS=1 npm run test:llm; a few cents): a file shaped like the user's "Booking app" leads
 * export (Part W2b), generated here: 115 rows; business, niche, area; a phone column where 70% of cells are the text
 * #ERROR!; an email column mostly empty; a website column half empty with http and https; two empty columns.
 * Profiles it, then plans the suggestions and the dashboard. Nothing is written to the database.
 */

const NICHES = ['Hair salon', 'Nail bar', 'Barber', 'Spa', 'Beauty clinic'];
const AREAS = ['Sandton', 'Rosebank', 'Randburg', 'Fourways', 'Midrand', 'Soweto'];
const ROWS = Array.from({ length: 115 }, (_, i) => [
  `${['Glow', 'Crown', 'Velvet', 'Luxe', 'Bloom', 'Studio'][i % 6]} ${NICHES[i % 5]} ${i + 1}`,
  NICHES[i % 5]!,
  AREAS[(i * 7) % 6]!,
  i % 10 < 7 ? '#ERROR!' : `27${String(820000000 + i * 1373).slice(0, 9)}`,
  i % 6 === 0 ? `info@biz${i + 1}.co.za` : '',
  i % 2 === 0 ? `${i % 8 === 0 ? 'http' : 'https'}://biz${i + 1}.co.za` : '',
  '',
  '',
]);
const CSV = `Business,Niche,Area,Phone,Email,Website,Date email sent,Outreach sent\n${ROWS.map((r) => r.join(',')).join('\n')}\n`;

describe.skipIf(!process.env.RUN_LLM_TESTS)('Booking app shaped file with the real models', () => {
  it('warnings, suggestions and dashboard', async () => {
    const report: string[] = [];
    const profile = await profileFile({ buffer: Buffer.from(CSV), fileType: 'csv', options: {}, maxRows: 100_000 });
    const columns = profile.columns.map((c) => ({ ...c, display_name: null, vat_included: null }));
    report.push(`=== Booking app shape: ${profile.rowCount} rows, ${columns.length} columns`);
    report.push(`columns: ${columns.map((c) => `${c.sql_name} (${c.data_type}, ${c.semantic}${c.is_pii ? ', pii' : ''}, ${c.distinct_count} distinct, ${c.null_count} empty)`).join('; ')}`);
    report.push(`warnings:\n${profile.warnings.map((w) => `  - ${w}`).join('\n')}`);

    // Suggestions: the same call profiling makes.
    const { user } = buildSuggestionsPrompt({ datasetName: 'Booking app', rowCount: profile.rowCount, columns, sampleRows: profile.sampleRows });
    const suggestions = await llm().callTool({ role: 'fast', system: SUGGESTIONS_SYSTEM, user, tool: SUGGEST_QUESTIONS_TOOL, schema: suggestQuestionsSchema, maxTokens: SUGGESTIONS_MAX_TOKENS });
    report.push(`suggested questions (${suggestions.usage.model}, $${suggestions.usage.costUsd?.toFixed(6)}):`);
    for (const q of suggestions.output.questions) report.push(`  - ${q.question}`);

    // Dashboard.
    const calls: Array<{ purpose: string; cost: number | null; tokens: string }> = [];
    const outcome = await planDashboard(
      { datasetName: 'Booking app', rowCount: profile.rowCount, columns, csv: profile.normalisedCsv },
      { llm: llm(), recordLlm: async (purpose, usage) => void calls.push({ purpose, cost: usage.costUsd, tokens: `in ${usage.inputTokens} / out ${usage.outputTokens}` }) },
    );
    report.push(`dashboard: status ${outcome.status}, fallback ${outcome.fallback}; reading: ${outcome.plan.reading.text}`);
    report.push(`filters: ${outcome.plan.filters.map((f) => f.id).join(', ') || 'none'}`);
    for (const t of outcome.report.trace) report.push(`  - [${t.outcome}] ${t.title} (planned ${t.type})${t.error ? ` error: ${t.error}` : ''}`);
    report.push(`kept widgets and their final chart: ${outcome.plan.widgets.map((w) => `${w.title} = ${w.chart.type}`).join('; ')}`);
    const pies = outcome.plan.widgets.filter((w) => w.chart.type === 'pie');
    report.push(`pies that survived: ${pies.length ? pies.map((w) => w.title).join(', ') : 'none'}`);
    report.push(`model calls: ${calls.map((c) => `${c.purpose} ${c.tokens} $${c.cost?.toFixed(6)}`).join('; ')}`);
    const cost = (suggestions.usage.costUsd ?? 0) + calls.reduce((s, c) => s + (c.cost ?? 0), 0);
    report.push(`total cost: $${cost.toFixed(6)}`);
    const sent = [user, ...outcome.report.trace.map((t) => t.sql)].join('\n');
    report.push(`empty columns mentioned to the model or in widget SQL: ${/date_email_sent|outreach_sent/.test(sent) ? 'YES' : 'no'}`);

    console.log(report.join('\n'));
    if (process.env.LLM_REPORT) writeFileSync(`${process.env.LLM_REPORT}.bookingapp.txt`, report.join('\n'));
    const errors = ROWS.filter((r) => r[3] === '#ERROR!').length; // 82 of 115 (about 70%)
    expect(profile.warnings).toContain(`Phone: ${errors} cells held a spreadsheet error such as #ERROR! and were read as empty.`);
    expect(outcome.status).toBe('ready');
  }, 240_000);
});
