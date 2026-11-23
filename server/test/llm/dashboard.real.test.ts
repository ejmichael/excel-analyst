import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { afterAll, describe, expect, it } from 'vitest';
import { llm, type LlmUsage } from '../../src/llm/client.js';
import { runDashboardData } from '../../src/services/dashboard/data.js';
import { planDashboard, type PlanOutcome } from '../../src/services/dashboard/planner.js';
import type { DashboardColumn } from '../../src/services/dashboard/widgets.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { withSandbox } from '../../src/services/sandbox/sandbox.js';
import type { CellValue, DashboardData } from '../../src/types/api.js';

/**
 * Opt-in, real planner model (RUN_LLM_TESTS=1 npm run test:llm; a few cents): a dashboard for fixtures 01 to 03 and two
 * files made here (IT tickets, a text-only leads list). Nothing is written to the database. Every kept widget is run
 * by the server; kpi and breakdown figures are compared with plain JavaScript loops over the file's rows.
 */

// ---------- two generated files (synthetic, not in fixtures/) ----------

const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const CATEGORIES = ['Network', 'Hardware', 'Software', 'Access', 'Email'];
const ASSIGNEES = ['Thandi Nkosi', 'Pieter van Wyk', 'Lerato Mokoena', 'Sipho Dlamini', 'Anna Botha', 'Kagiso Molefe'];
const STATUSES = ['Open', 'In progress', 'Resolved', 'Closed'];
const day = (d: number) => new Date(Date.UTC(2026, 6, 1 + d)).toISOString().slice(0, 10);
const TICKETS = Array.from({ length: 300 }, (_, i) => {
  const status = STATUSES[(i * 7) % 4]!;
  const opened = (i * 13) % 120;
  return [
    `INC${String(10000 + i)}`,
    day(opened),
    status === 'Resolved' || status === 'Closed' ? day(opened + 1 + (i % 9)) : '',
    PRIORITIES[(i * 5) % 4]!,
    CATEGORIES[(i * 3) % 5]!,
    ASSIGNEES[i % 6]!,
    status,
  ];
});
const TICKETS_CSV = `Ticket ID,Opened,Closed,Priority,Category,Assignee,Status\n${TICKETS.map((r) => r.join(',')).join('\n')}\n`;

const JOBS = ['Owner', 'Operations Manager', 'Logistics Coordinator', 'Fleet Manager', 'Director'];
const LEADS = Array.from({ length: 25 }, (_, i) => [
  `${['Swift', 'Karoo', 'Cape', 'Highveld', 'Coastal'][i % 5]} ${['Freight', 'Logistics', 'Haulage', 'Couriers', 'Transport'][(i * 3) % 5]} ${i + 1}`,
  `${['Thabo', 'Naledi', 'Johan', 'Ayesha', 'Ruan'][i % 5]} ${['Mahlangu', 'Pillay', 'Steyn', 'Khumalo', 'Naidoo'][(i * 2) % 5]}`,
  JOBS[(i * 2) % 5]!,
  `${i % 6 === 0 ? 'http' : 'https'}://lead${i + 1}.co.za`,
  `contact${i + 1}@lead${i + 1}.co.za`,
]);
const LEADS_CSV = `Business,Contact name,Job title,Website,Email\n${LEADS.map((r) => r.join(',')).join('\n')}\n`;

const FILES: Array<{ name: string; buffer: () => Buffer }> = [
  ...['01_card_sales_semicolon_win1252.csv', '02_webstore_orders_utf8bom.csv', '03_bank_statement_comma_quoted.csv'].map((name) => ({
    name,
    buffer: () => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url)),
  })),
  { name: 'generated_it_tickets.csv', buffer: () => Buffer.from(TICKETS_CSV) },
  { name: 'generated_leads_text_only.csv', buffer: () => Buffer.from(LEADS_CSV) },
];

// ---------- hand checks: a plain loop over the file's rows ----------

type Row = Record<string, string>;
const close = (a: number, b: number) => Math.abs(a - b) < 0.006 || (Math.abs(b) > 1 && Math.abs(a - b) / Math.abs(b) < 1e-9);

/** Candidate single figures computed by hand: row count, distinct counts, sums and averages of numeric columns, shares. */
function handFigures(rows: Row[], columns: DashboardColumn[]): Array<{ what: string; value: number }> {
  const out: Array<{ what: string; value: number }> = [{ what: 'rows', value: rows.length }];
  for (const c of columns) {
    const vals = rows.map((r) => r[c.sql_name] ?? '').filter((v) => v !== '');
    out.push({ what: `distinct ${c.sql_name}`, value: new Set(vals).size });
    out.push({ what: `non-empty ${c.sql_name}`, value: vals.length });
    if (c.data_type === 'integer' || c.data_type === 'decimal') {
      let sum = 0;
      for (const v of vals) sum += Number(v);
      out.push({ what: `sum ${c.sql_name}`, value: Math.round(sum * 100) / 100 }, { what: `avg ${c.sql_name}`, value: vals.length ? sum / vals.length : 0 });
    }
    if (c.data_type === 'text' && new Set(vals).size <= 50) {
      for (const v of new Set(vals)) {
        let n = 0;
        for (const r of rows) if (r[c.sql_name] === v) n++;
        out.push({ what: `share ${c.sql_name}=${v}`, value: n / rows.length }, { what: `count ${c.sql_name}=${v}`, value: n });
      }
    }
  }
  return out;
}

/** For a breakdown row (label, number): the hand count or sum for that label in some column. */
function handBreakdown(rows: Row[], columns: DashboardColumn[], label: string, value: number): string | null {
  for (const c of columns) {
    const match = rows.filter((r) => r[c.sql_name] === label);
    if (match.length === 0) continue;
    if (close(value, match.length)) return `count of ${c.sql_name}=${label}: ${match.length}`;
    for (const n of columns.filter((x) => x.data_type === 'integer' || x.data_type === 'decimal')) {
      let sum = 0;
      for (const r of match) sum += Number(r[n.sql_name] || 0);
      if (close(value, Math.round(sum * 100) / 100)) return `sum of ${n.sql_name} where ${c.sql_name}=${label}: ${Math.round(sum * 100) / 100}`;
    }
  }
  return null;
}

// ---------- the run ----------

const report: string[] = [];
let handChecked = 0;
let totalCost = 0;
let rejectedFunctions = 0;

describe.skipIf(!process.env.RUN_LLM_TESTS)('dashboard planner with the real model', () => {
  afterAll(() => {
    report.push(`\n=== SUMMARY: ${handChecked} figures hand-checked and equal; total cost $${totalCost.toFixed(6)} for ${FILES.length} dashboards ($${(totalCost / FILES.length).toFixed(6)} each); widgets the validator refused for trim() or another function: ${rejectedFunctions}`);
    console.log(report.join('\n'));
    if (process.env.LLM_REPORT) writeFileSync(`${process.env.LLM_REPORT}.dashboard.txt`, report.join('\n'));
  });

  it.each(FILES)('$name', async ({ name, buffer }) => {
    const profile = await profileFile({ buffer: buffer(), fileType: 'csv', options: {}, maxRows: 1_000_000 });
    const columns: DashboardColumn[] = profile.columns.map((c) => ({ ...c, display_name: null }));
    const calls: Array<{ purpose: string; usage: LlmUsage; ms: number }> = [];
    const started = Date.now();
    const outcome: PlanOutcome = await planDashboard(
      { datasetName: name.replace(/\.csv$/, ''), rowCount: profile.rowCount, columns, csv: profile.normalisedCsv },
      { llm: llm(), recordLlm: async (purpose, usage, meta) => void calls.push({ purpose, usage, ms: Number(meta.ms ?? 0) }) },
    );
    const ms = Date.now() - started;
    const cost = calls.reduce((s, c) => s + (c.usage.costUsd ?? 0), 0);
    totalCost += cost;

    report.push(`\n=== ${name}: ${profile.rowCount} rows, ${columns.length} columns; status ${outcome.status}, fallback ${outcome.fallback}, ${ms} ms`);
    report.push(`reading: ${outcome.plan.reading.text} (date column: ${outcome.plan.reading.date_column})`);
    report.push(`filters: ${outcome.plan.filters.map((f) => (f.kind === 'date_range' ? `${f.id} ${f.min}..${f.max}` : `${f.id} (${f.options.length} options)`)).join('; ') || 'none'}`);
    for (const t of outcome.report.trace) {
      report.push(`  - [${t.outcome}] ${t.title} (${t.type}, ${t.width})${t.error ? ` error: ${t.error}` : ''}`);
      report.push(`      sql: ${t.sql}`);
      if (/\btrim\s*\(|Qualified function names|Table functions|not allowed/i.test(`${t.sql} ${t.error ?? ''}`)) rejectedFunctions += t.error ? 1 : 0;
    }
    report.push(`dropped: ${JSON.stringify(outcome.report.dropped)}; repaired: ${outcome.report.repaired}; model failed: ${outcome.report.modelFailed}`);
    report.push(`model calls: ${calls.map((c) => `${c.purpose} ${c.usage.model} in ${c.usage.inputTokens} / out ${c.usage.outputTokens} $${c.usage.costUsd?.toFixed(6) ?? '?'} ${c.ms} ms`).join('; ')}`);
    if (outcome.fallback) report.push('fallback widgets: ' + outcome.plan.widgets.map((w) => w.title).join(', '));

    // Run every kept widget as the data endpoint does, then hand-check figures.
    const data: DashboardData = await withSandbox({ csv: profile.normalisedCsv, columns }, (s) => runDashboardData(s, outcome.plan.widgets, []));
    const rows = parse(profile.normalisedCsv, { columns: true }) as Row[];
    const figures = handFigures(rows, columns);
    for (const w of outcome.plan.widgets) {
      const r = data.widgets.find((x) => x.widget_id === w.id)!;
      if (r.error) {
        report.push(`  ! ${w.title}: ${r.error}`);
        continue;
      }
      if (w.chart.type === 'kpi') {
        const v = Object.values(r.rows[0] ?? {})[0] as CellValue;
        const hit = typeof v === 'number' ? figures.find((f) => close(v, f.value)) : undefined;
        report.push(`  = ${w.title}: server ${v}${hit ? ` | by hand (${hit.what}) ${Math.round(hit.value * 1e6) / 1e6}` : ' | no hand figure matched'}`);
        if (hit) handChecked++;
      } else if (r.rows.length > 0 && w.chart.x && w.chart.y[0]) {
        const first = r.rows[0]!;
        const label = first[w.chart.x];
        const value = first[w.chart.y[0]];
        if (typeof label === 'string' && typeof value === 'number') {
          const hit = handBreakdown(rows, columns, label, value);
          report.push(`  = ${w.title} [${label}]: server ${value}${hit ? ` | by hand ${hit}` : ' | no hand figure matched'}`);
          if (hit) handChecked++;
        }
      }
    }
    expect(outcome.status).toBe('ready');
  }, 240_000);

  it('hand-checked at least 6 figures across the files', () => {
    expect(handChecked).toBeGreaterThanOrEqual(6);
  });
});
