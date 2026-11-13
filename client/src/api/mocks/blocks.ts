import { z } from 'zod';
import type { Block, PlanLimitDetails, SourceRows } from '../types';
import { MOCK_PLAN_LIMITS, cheapestPlanAllowing, sastMonthStart, sastTimestamp, type MockUser } from './data';
import { BLOCK_TEMPLATES, blockFrom, templateForQuestion } from './blockFixtures';
import { isInAnyReport } from './reports';

/**
 * Mock ask and block routes. Special questions exercise every state (documented in client/README.md):
 * "slow" waits about 8 s; "weather" is 422 cannot_answer; "busy" is 429 with Retry-After; "fail" is 502
 * llm_failed. Other words pick an example answer (see blockFixtures.ts). The mock answers in about 1.5 s.
 */

export interface MockBlock {
  block: Block;
  /** Pinned in a report: delete is 409 (reports arrive in a later part, so only seeded blocks are pinned). */
  pinned: boolean;
}

export type BlockResult = { status: number; body?: unknown; headers?: Record<string, string>; raw?: Response };

const ok = (data: unknown, status = 200): BlockResult => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>): BlockResult => ({
  status,
  headers,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

export const MOCK_ASK_MS = 1500;
export const MOCK_SLOW_ASK_MS = 8000;

const askSchema = z.strictObject({
  question: z.string().trim().min(3).max(500),
  chart_hint: z.enum(['table', 'bar', 'line', 'area', 'pie', 'kpi']).optional(),
  source: z.enum(['user', 'suggested']).optional(),
});
const feedbackSchema = z.strictObject({ kind: z.literal('looks_wrong'), note: z.string().max(500).optional() });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function validationFailed(error: z.ZodError, location: 'body' | 'query' = 'body'): BlockResult {
  const fields = error.issues.map((i) => ({ location, path: i.path.join('.'), message: i.message }));
  return fail(422, 'validation_failed', 'Some fields are not valid.', { fields });
}

function blocksOf(user: MockUser): MockBlock[] {
  user.blocks ??= [];
  return user.blocks;
}

export function questionsThisMonth(user: MockUser): number {
  const monthStart = sastMonthStart();
  return (user.question_events ?? []).filter((t) => t.slice(0, 10) >= monthStart).length;
}

/** Example history for the demo account: one answer of each kind, the oldest pinned in a report. */
export function seedDemoBlocks(user: MockUser, datasetId: string, expiredDatasetId: string | null): void {
  const keys = ['by-store', 'daily', 'card-share', 'fees', 'refunds', 'store-card', 'flagged', 'gross-net', 'truncated'];
  const start = new Date('2026-11-02T08:00:00+02:00').getTime();
  user.blocks = keys.map((key, i) => ({
    block: blockFrom(BLOCK_TEMPLATES.find((t) => t.key === key)!, {
      question: questionFor(key),
      datasetId,
      source: i % 3 === 0 ? 'suggested' : 'user',
      createdAt: sastTimestamp(new Date(start + i * 3_600_000)),
    }),
    pinned: key === 'by-store',
  }));
  if (expiredDatasetId) {
    user.blocks.push({
      block: blockFrom(BLOCK_TEMPLATES.find((t) => t.key === 'refunds')!, {
        question: 'Which transactions were refunds in August?',
        datasetId: expiredDatasetId,
        source: 'user',
        createdAt: '2026-08-21T10:00:00+02:00',
      }),
      pinned: false,
    });
  }
}

function questionFor(key: string): string {
  return (
    {
      'by-store': 'Which store had the highest net sales in October?',
      daily: 'What were net sales for each day of the month?',
      'card-share': 'What share of sales came from each card type?',
      fees: 'How much did card fees cost in total?',
      refunds: 'How many refunds were there, and what did they add up to?',
      'store-card': 'Show net sales by store and card type, stacked',
      flagged: 'What is the average sale per store?',
      'gross-net': 'Compare gross and net sales per day',
      truncated: 'List every transaction in October',
    }[key] ?? key
  );
}

/** Async because ask takes a while; the transport awaits it. */
export async function routeBlocks(
  method: string,
  url: URL,
  user: MockUser,
  body: unknown,
  datasetStatus: (id: string) => { status: string; columns: Array<{ sql_name: string; name: string; display_name: string | null; sample_values: string[]; data_type: string }>; row_count: number | null } | null,
  latencyMs: number,
): Promise<BlockResult | null> {
  const path = url.pathname.replace(/^\/api\/v1/, '');

  const ask = /^\/datasets\/([^/]+)\/ask$/.exec(path);
  if (ask && method === 'POST') {
    const datasetId = decodeURIComponent(ask[1] ?? '');
    const dataset = datasetStatus(datasetId);
    // Same order as the server: 404, 410, 409, 402, then validation and the answer.
    if (!dataset) return fail(404, 'not_found', 'Dataset not found.');
    if (dataset.status === 'expired') return fail(410, 'dataset_expired', 'The source file was removed.');
    if (dataset.status !== 'ready') return fail(409, 'dataset_not_ready', 'The dataset is not ready.');
    const limit = MOCK_PLAN_LIMITS[user.plan].max_questions_per_month;
    const used = questionsThisMonth(user);
    if (used >= limit) {
      const details: PlanLimitDetails = {
        limit_key: 'max_questions_per_month',
        limit,
        used,
        upgrade_to: cheapestPlanAllowing((l) => l.max_questions_per_month > used),
      };
      return fail(402, 'plan_limit', 'Monthly question limit reached.', details);
    }
    const parsed = askSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const { question, chart_hint, source = 'user' } = parsed.data;

    await new Promise((r) => setTimeout(r, latencyMs === 0 ? 0 : /slow/i.test(question) ? MOCK_SLOW_ASK_MS : MOCK_ASK_MS));

    if (/busy/i.test(question)) return fail(429, 'rate_limited', 'Too many questions.', undefined, { 'Retry-After': '12' });
    if (/fail/i.test(question)) return fail(502, 'llm_failed', 'The model call failed.');
    if (/weather|rain|stock price/i.test(question)) {
      return fail(422, 'cannot_answer', 'This file has no weather data. It holds card transactions: dates, stores, card types and amounts.');
    }
    const block = blockFrom(templateForQuestion(question, chart_hint), {
      question,
      datasetId,
      source,
      createdAt: sastTimestamp(),
    });
    blocksOf(user).push({ block, pinned: false });
    // Like usage_events: counted once the answer is saved.
    (user.question_events ??= []).push(sastTimestamp());
    return ok(block, 201);
  }

  const list = /^\/datasets\/([^/]+)\/blocks$/.exec(path);
  if (list && method === 'GET') {
    const datasetId = decodeURIComponent(list[1] ?? '');
    if (!datasetStatus(datasetId)) return fail(404, 'not_found', 'Dataset not found.');
    const parsed = pageQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return validationFailed(parsed.error, 'query');
    const { limit, offset } = parsed.data;
    const items = blocksOf(user)
      .filter((b) => b.block.dataset_id === datasetId)
      .map((b) => b.block)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return ok({ items: items.slice(offset, offset + limit), total: items.length, limit, offset });
  }

  const match = /^\/blocks\/([^/]+)(\/source-rows|\/export\.csv|\/feedback)?$/.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1] ?? '');
  const entry = blocksOf(user).find((b) => b.block.id === id);
  if (!entry) return fail(404, 'not_found', 'Answer not found.');
  const { block } = entry;
  const sub = match[2];

  if (!sub && method === 'GET') return ok(block);

  if (!sub && method === 'DELETE') {
    if (entry.pinned || isInAnyReport(user, entry.block.id)) return fail(409, 'conflict', 'This block is pinned in a report.');
    user.blocks = blocksOf(user).filter((b) => b !== entry);
    return ok({ deleted: true });
  }

  if (sub === '/feedback' && method === 'POST') {
    const parsed = feedbackSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    return ok({ received: true });
  }

  if (sub === '/export.csv' && method === 'GET') {
    const escape = (v: unknown) => {
      const text = v === null || v === undefined ? '' : String(v);
      const safe = /^[=+\-@\t\r]/.test(text) && typeof v !== 'number' ? `'${text}` : text;
      return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [block.columns.map((c) => escape(c.name)).join(',')].concat(
      block.rows.map((row) => block.columns.map((c) => escape(row[c.name])).join(',')),
    );
    const csv = `﻿${lines.join('\r\n')}\r\n`;
    return {
      status: 200,
      raw: new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${block.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${sastTimestamp().slice(0, 10)}.csv"`,
        },
      }),
    };
  }

  if (sub === '/source-rows' && method === 'GET') {
    if (!block.has_source_rows || !block.dataset_id) return fail(404, 'not_found', 'This answer has no source rows.');
    const dataset = datasetStatus(block.dataset_id);
    if (!dataset) return fail(404, 'not_found', 'Dataset not found.');
    if (dataset.status === 'expired') return fail(410, 'dataset_expired', 'The source file was removed.');
    if (dataset.status !== 'ready') return fail(409, 'dataset_not_ready', 'The dataset is not ready.');
    const parsed = pageQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return validationFailed(parsed.error, 'query');
    const { limit, offset } = parsed.data;
    // Example rows built from the dataset's sample values; the total is example data too.
    const sourceTotal = 87;
    const count = Math.max(0, Math.min(limit, sourceTotal - offset));
    const rows: SourceRows['rows'] = Array.from({ length: count }, (_, i) =>
      Object.fromEntries(
        dataset.columns.map((c) => {
          const samples = c.sample_values.length ? c.sample_values : [''];
          const raw = samples[(offset + i) % samples.length] ?? '';
          return [c.sql_name, c.data_type === 'integer' || c.data_type === 'decimal' ? Number(raw) : raw || null];
        }),
      ),
    );
    const result: SourceRows = {
      columns: dataset.columns.map((c) => ({ sql_name: c.sql_name, label: c.display_name ?? c.name })),
      rows,
      total: sourceTotal,
      limit,
      offset,
    };
    return ok(result);
  }

  return fail(404, 'not_found', 'Not found.');
}
