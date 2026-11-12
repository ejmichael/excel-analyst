import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { LlmUsage } from '../../src/llm/client.js';
import { llm } from '../../src/llm/client.js';
import { ask, type AskResult, type LlmPurpose } from '../../src/services/analysis/ask.js';
import { profileFile, type ProfileResult } from '../../src/services/parsing/pipeline.js';

/** Profiles a fixture locally (no database, no storage) and asks a question with the real model from .env. */

export interface LocalCall {
  purpose: LlmPurpose;
  usage: LlmUsage;
  ms: number;
  error?: string;
}

export interface LocalAnswer {
  result: AskResult | { kind: 'llm_failed'; purpose: string };
  calls: LocalCall[];
  ms: number;
}

const profiles = new Map<string, ProfileResult>();

export async function profileFixture(fixture: string): Promise<ProfileResult> {
  const cached = profiles.get(fixture);
  if (cached) return cached;
  const buffer = readFileSync(new URL(`../../../fixtures/${fixture}`, import.meta.url));
  const p = await profileFile({ buffer, fileType: 'csv', options: {}, maxRows: 1_000_000 });
  profiles.set(fixture, p);
  return p;
}

export async function localAsk(fixture: string, question: string): Promise<LocalAnswer> {
  const p = await profileFixture(fixture);
  const calls: LocalCall[] = [];
  const started = Date.now();
  try {
    const result = await ask(
      {
        ownerId: 'local',
        datasetId: 'local',
        datasetName: fixture.replace(/^\d+_|\.csv$/g, '').replace(/_/g, ' '),
        rowCount: p.rowCount,
        columns: p.columns.map((c) => ({ ...c, display_name: null, vat_included: null })),
        csv: p.normalisedCsv,
        question,
        source: 'user',
      },
      {
        llm: llm(),
        recordLlm: async (purpose, usage, meta) => {
          calls.push({ purpose, usage, ms: Number(meta.ms ?? 0), ...(meta.error ? { error: String(meta.error) } : {}) });
        },
      },
    );
    return { result, calls, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.name === 'AskLlmFailure') {
      return { result: { kind: 'llm_failed', purpose: (err as Error & { purpose: string }).purpose }, calls, ms: Date.now() - started };
    }
    throw err;
  }
}

/** A human-readable report of one answer. */
export function describeAnswer(question: string, a: LocalAnswer): string {
  const lines = [`\n### ${question}`, `latency: ${a.ms} ms`];
  for (const c of a.calls) {
    lines.push(
      `  ${c.purpose.padEnd(7)} ${c.usage.model}  in ${c.usage.inputTokens} / out ${c.usage.outputTokens}  $${c.usage.costUsd?.toFixed(6) ?? '?'}  ${c.ms} ms${c.error ? `  ERROR ${c.error}` : ''}`,
    );
  }
  if (a.result.kind === 'llm_failed') return [...lines, `RESULT: llm_failed (${a.result.purpose})`].join('\n');
  if (a.result.kind === 'cannot_answer') return [...lines, `RESULT: cannot_answer: ${a.result.message}`].join('\n');
  const b = a.result.block;
  lines.push(`title: ${b.title}   status: ${b.status}   rows: ${b.row_count}${b.truncated ? ' (truncated)' : ''}`);
  lines.push(`sql: ${b.sql}`);
  if (b.source_filter_sql) lines.push(`source filter: ${b.source_filter_sql}`);
  lines.push(`first rows: ${JSON.stringify(b.rows.slice(0, 5))}`);
  lines.push(`checks: ${b.checks.map((c) => `${c.type}=${c.ok ? 'ok' : 'FAILED'}${c.ok ? '' : ` (${c.label}${c.detail ? `: ${c.detail}` : ''})`}`).join(', ')}`);
  lines.push(`narrative: ${b.narrative.replace(/[  ]/g, ' ')}`);
  return lines.join('\n');
}
