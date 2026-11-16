import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, setPlan, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { newToken } from '../../src/services/shareLinks.js';
import { openWorkbook, readSheetRows } from '../../src/services/parsing/xlsx.js';
import { profilingIdle } from '../../src/services/profiling.js';
import type { Block, Dataset, DatasetDetail, PublicReport, ReportDetail, ShareLink, Workspace } from '../../src/types/api.js';

/**
 * Excel export, share links and public reports (S4) against real Supabase with a mocked model. A question starting with
 * "PII" plans over the email column of a small file (so the report holds personal data); anything else plans over items.
 */
vi.mock('../../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/client.js')>();
  const usage = (model: string) => ({ model, inputTokens: 200, outputTokens: 40, costUsd: 0.0012 });
  const fake = {
    provider: 'openrouter' as const,
    modelFor: (role: string) => (role === 'planner' ? 'test/planner' : 'test/fast'),
    callTool: vi.fn(async (req: { tool: { name: string }; user: string }) => {
      const question = /^Question: (.*)$/m.exec(req.user)?.[1] ?? '';
      if (req.tool.name === 'plan_analysis') {
        const pii = question.startsWith('PII');
        return {
          output: {
            can_answer: true,
            title: pii ? 'Orders by customer email' : 'Amount by item',
            sql: pii
              ? 'SELECT "email", COUNT(*) AS orders FROM data GROUP BY 1 ORDER BY 1'
              : 'SELECT "item", ROUND(SUM("amount"), 2) AS amount FROM data GROUP BY 1 ORDER BY 2 DESC',
            source_filter_sql: null,
            chart: pii
              ? { type: 'table', x: null, y: ['orders'], series: null, orientation: 'vertical', stacked: false, value_format: { email: 'text', orders: 'integer' } }
              : { type: 'bar', x: 'item', y: ['amount'], series: null, orientation: 'vertical', stacked: false, value_format: { item: 'text', amount: 'zar' } },
            reconcile: null,
            narrative_instructions: 'Name the first row.',
          },
          usage: usage('test/planner'),
        };
      }
      if (req.tool.name === 'write_narrative') {
        const first = /Result columns \(name \| format\): ([^ |]+)/.exec(req.user)?.[1] ?? 'x';
        return { output: { narrative_template: `{{r0.${first}}} comes first.`, follow_ups: [] }, usage: usage('test/fast') };
      }
      throw new actual.LlmError('invalid_output', 'not used in this test');
    }),
  };
  return { ...actual, llm: () => fake };
});

const app = createApp();
const api = (p: string) => `/api/v1${p}`;
const ITEMS = Buffer.from('Item,Amount\n=SUM(A1:A9),5.00\nCoffee,6.50\nCake,7.25\n');
const PEOPLE = Buffer.from('Email,Amount\nthandi@example.com,5.00\nsipho@example.com,6.50\n');

let a: TestUser; // practice: export, share links
let b: TestUser; // free: export with watermark, no share links, cross-user
let wsA: string;
let wsB: string;
const datasetsA: string[] = [];
let itemsBlock: Block;
let reportA: ReportDetail;
let piiReport: ReportDetail;
let reportB: ReportDetail;

async function consent(u: TestUser): Promise<string> {
  await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
  return ((await request(app).get(api('/workspaces')).set(bearer(u)).expect(200)).body.data as Workspace[])[0]!.id;
}

async function uploadReady(u: TestUser, ws: string, buffer: Buffer, filename: string): Promise<string> {
  const res = await request(app).post(api('/datasets')).set(bearer(u)).field('workspace_id', ws).attach('file', buffer, filename).expect(201);
  const id = (res.body.data as Dataset).id;
  for (let i = 0; i < 240; i++) {
    const d = (await request(app).get(api(`/datasets/${id}`)).set(bearer(u)).expect(200)).body.data as DatasetDetail;
    if (d.status === 'ready') return id;
    if (d.status === 'failed') throw new Error(`profiling failed: ${d.error_message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('profiling did not finish');
}

const ask = async (u: TestUser, datasetId: string, question: string) =>
  (await request(app).post(api(`/datasets/${datasetId}/ask`)).set(bearer(u)).send({ question }).expect(201)).body.data as Block;
const makeReport = async (u: TestUser, ws: string, title: string, blockIds: string[]) =>
  (await request(app).post(api('/reports')).set(bearer(u)).send({ workspace_id: ws, title, block_ids: blockIds }).expect(201)).body.data as ReportDetail;
const events = async (u: TestUser, kind: string) =>
  (await supabaseAdmin().from('usage_events').select('id', { count: 'exact', head: true }).eq('owner_id', u.id).eq('kind', kind)).count ?? 0;
const createLink = (u: TestUser, reportId: string, body: Record<string, unknown> = {}) =>
  request(app).post(api(`/reports/${reportId}/share-links`)).set(bearer(u)).send(body);
const publicGet = (token: string) => request(app).get(api(`/public/reports/${token}`));
const exportXlsx = (u: TestUser, reportId: string) =>
  request(app)
    .get(api(`/reports/${reportId}/export.xlsx`))
    .set(bearer(u))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

async function sheetsOf(buf: Buffer): Promise<Map<string, string[][]>> {
  const wb = openWorkbook(buf);
  const out = new Map<string, string[][]>();
  for (const sheet of wb.sheets) {
    const rows: string[][] = [];
    for await (const r of readSheetRows(buf, wb, sheet)) rows[r.n - 1] = r.cells;
    out.set(sheet.name, Array.from(rows, (r) => r ?? []));
  }
  return out;
}

beforeAll(async () => {
  [a, b] = await Promise.all([createTestUser(), createTestUser()]);
  await setPlan(a.id, 'practice');
  [wsA, wsB] = await Promise.all([consent(a), consent(b)]);
  const [items, people, itemsB] = await Promise.all([
    uploadReady(a, wsA, ITEMS, 'secret-items-file.csv'),
    uploadReady(a, wsA, PEOPLE, 'secret-people-file.csv'),
    uploadReady(b, wsB, ITEMS, 'b-file.csv'),
  ]);
  datasetsA.push(items, people);
  itemsBlock = await ask(a, items, 'What sold most?');
  const piiBlock = await ask(a, people, 'PII orders per customer');
  reportA = await makeReport(a, wsA, 'October report', [itemsBlock.id]);
  piiReport = await makeReport(a, wsA, 'Customers', [piiBlock.id, itemsBlock.id]);
  reportB = await makeReport(b, wsB, 'B report', [(await ask(b, itemsB, 'What sold?')).id]);
}, 180_000);

afterAll(async () => {
  await profilingIdle();
  await deleteTestUsers();
});

// ---------- Excel export ----------

describe('GET /reports/:id/export.xlsx', () => {
  it('streams the workbook with the file name header and counts one export', async () => {
    const before = await events(a, 'export');
    const res = await exportXlsx(a, reportA.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="october-report-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    // The client is on another origin and reads the file name from this header.
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
    const sheets = await sheetsOf(res.body as Buffer);
    expect([...sheets.keys()]).toEqual(['Summary', 'Amount by item', 'Working']);
    // The hostile item name from the file comes back as text.
    expect(sheets.get('Amount by item')!.flat()).toContain('=SUM(A1:A9)');
    expect(sheets.get('Summary')!.flat()).not.toContain(`Made with ${env().APP_NAME}`);
    expect(await events(a, 'export')).toBe(before + 1);
  });

  it('free can export (Excel is not gated), with the watermark line', async () => {
    const res = await exportXlsx(b, reportB.id);
    expect(res.status).toBe(200);
    expect((await sheetsOf(res.body as Buffer)).get('Summary')!).toContainEqual([`Made with ${env().APP_NAME}`]);
  });

  it('cross-user is 404 and counts nothing', async () => {
    const before = await events(b, 'export');
    const res = await request(app).get(api(`/reports/${reportA.id}/export.xlsx`)).set(bearer(b));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(await events(b, 'export')).toBe(before);
  });

  it('a report too large to build fails with a clear message and counts nothing', async () => {
    // One answer of 500 rows x 600 columns: above the 300 000-cell cap. Inserted directly (no model can produce it).
    const columns = Array.from({ length: 600 }, (_, i) => ({ name: `c${i}`, format: 'integer' }));
    const row = Object.fromEntries(columns.map((c) => [c.name, 1]));
    const { data: big, error } = await supabaseAdmin()
      .from('blocks')
      .insert({
        owner_id: a.id,
        dataset_id: datasetsA[0],
        question: 'big',
        title: 'Big',
        sql: 'SELECT 1',
        columns,
        rows: Array.from({ length: 500 }, () => row),
        row_count: 500,
        chart: { type: 'table', x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: {} },
        narrative_template: 'x',
        narrative: 'x',
      })
      .select('id')
      .single<{ id: string }>();
    // Failed once under load in a full run (2026-11-16) without a recorded cause: say why if it happens again.
    expect(error, `insert: ${error?.code} ${error?.message}`).toBeNull();
    const bigReport = await makeReport(a, wsA, 'Big', [big!.id]);
    const before = await events(a, 'export');
    const res = await request(app).get(api(`/reports/${bigReport.id}/export.xlsx`)).set(bearer(a));
    expect(res.status, res.text).toBe(500);
    expect(res.body.error).toEqual({ code: 'internal', message: 'This report is too large to export to Excel. Remove some answers or ask for fewer rows, then try again.' });
    expect(await events(a, 'export')).toBe(before);
  }, 60_000);
});

// ---------- share links ----------

describe('share links', () => {
  let link: ShareLink;

  it('free cannot create a link (402, limit 0)', async () => {
    const before = await events(b, 'share');
    const res = await createLink(b, reportB.id);
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'plan_limit', details: { limit_key: 'share_links', limit: 0, used: 0, upgrade_to: 'solo' } });
    expect(await events(b, 'share')).toBe(before);
  });

  it('creates a link (201) with a 43-character token, the client URL, defaults, and one share event', async () => {
    const before = await events(a, 'share');
    const res = await createLink(a, reportA.id);
    expect(res.status).toBe(201);
    link = res.body.data as ShareLink;
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({
      report_id: reportA.id,
      url: `${env().CLIENT_URL.replace(/\/+$/, '')}/r/${link.token}`,
      show_working: false,
      expires_at: null,
      revoked_at: null,
      view_count: 0,
      contains_personal_data: false,
    });
    expect(await events(a, 'share')).toBe(before + 1);
  });

  it('expires_in_days sets expires_at that many days ahead', async () => {
    const res = await createLink(a, reportA.id, { expires_in_days: 7 });
    const ms = Date.parse((res.body.data as ShareLink).expires_at!) - Date.now();
    expect(ms).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(ms).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it('refuses an unknown field or another number of days (422)', async () => {
    expect((await createLink(a, reportA.id, { expires_in_days: 14 })).status).toBe(422);
    expect((await createLink(a, reportA.id, { token: 'mine' })).status).toBe(422);
  });

  it('contains_personal_data is true for a report holding customer emails', async () => {
    const res = await createLink(a, piiReport.id);
    expect((res.body.data as ShareLink).contains_personal_data).toBe(true);
    const list = (await request(app).get(api(`/reports/${piiReport.id}/share-links`)).set(bearer(a)).expect(200)).body.data as ShareLink[];
    expect(list.every((l) => l.contains_personal_data)).toBe(true);
  });

  it('lists the report links newest first', async () => {
    const list = (await request(app).get(api(`/reports/${reportA.id}/share-links`)).set(bearer(a)).expect(200)).body.data as ShareLink[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.map((l) => l.created_at)).toEqual([...list.map((l) => l.created_at)].sort().reverse());
  });

  it('B cannot list, create on, or revoke A’s links (404)', async () => {
    expect((await request(app).get(api(`/reports/${reportA.id}/share-links`)).set(bearer(b))).status).toBe(404);
    expect((await createLink(b, reportA.id)).status).toBe(404);
    expect((await request(app).delete(api(`/share-links/${link.id}`)).set(bearer(b))).status).toBe(404);
    expect((await request(app).delete(api(`/share-links/${randomUUID()}`)).set(bearer(a))).status).toBe(404);
  });

  it('revokes, and repeating it is harmless (same revoked_at)', async () => {
    const live = (await createLink(a, reportA.id)).body.data as ShareLink;
    const first = (await request(app).delete(api(`/share-links/${live.id}`)).set(bearer(a)).expect(200)).body.data as ShareLink;
    expect(first.revoked_at).not.toBeNull();
    expect(first.token).toBe(live.token); // the full link, as the contract says
    const again = (await request(app).delete(api(`/share-links/${live.id}`)).set(bearer(a)).expect(200)).body.data as ShareLink;
    expect(again.revoked_at).toBe(first.revoked_at);
    expect((await publicGet(live.token)).status).toBe(404);
  });
});

// ---------- the public report ----------

describe('GET /public/reports/:token', () => {
  it('returns the PublicReport with the three headers, counting views', async () => {
    const link = (await createLink(a, reportA.id)).body.data as ShareLink;
    const res = await publicGet(link.token);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const p = res.body.data as PublicReport;
    expect(p).toMatchObject({ id: reportA.id, title: 'October report', watermark: false, block_count: 1 });
    await publicGet(link.token).expect(200);
    const list = (await request(app).get(api(`/reports/${reportA.id}/share-links`)).set(bearer(a)).expect(200)).body.data as ShareLink[];
    expect(list.find((l) => l.id === link.id)!.view_count).toBe(2);
  });

  it('show_working false hides SQL and checks; true shows them; source rows never', async () => {
    const hidden = (await publicGet(((await createLink(a, reportA.id)).body.data as ShareLink).token).expect(200)).body.data as PublicReport;
    expect(hidden.blocks[0]!.block).toMatchObject({ sql: '', checks: [], has_source_rows: false });
    const shown = (await publicGet(((await createLink(a, reportA.id, { show_working: true })).body.data as ShareLink).token).expect(200)).body.data as PublicReport;
    expect(shown.blocks[0]!.block.sql).toBe(itemsBlock.sql);
    expect(shown.blocks[0]!.block.checks).toEqual(itemsBlock.checks);
    expect(shown.blocks[0]!.block.has_source_rows).toBe(false);
  });

  it('leaks nothing: no owner id or email, workspace or dataset id, file name or storage path anywhere in the JSON', async () => {
    const link = (await createLink(a, piiReport.id, { show_working: true })).body.data as ShareLink;
    const res = await publicGet(link.token).expect(200);
    const { data: datasets } = await supabaseAdmin().from('datasets').select('id, original_filename, storage_path, normalised_path').eq('owner_id', a.id);
    const forbidden = [
      a.id,
      a.email,
      wsA,
      ...(datasets ?? []).flatMap((d) => [d.id, d.original_filename, d.storage_path, d.normalised_path].filter((v): v is string => typeof v === 'string')),
      'storage/v1',
      'owner_id',
      'workspace_id',
      'dataset_id',
      'template_id',
    ];
    // Walk every key and value of the response.
    const seen: string[] = [];
    const walk = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) return v.forEach(walk);
      if (typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          seen.push(k);
          walk(x);
        }
        return;
      }
      seen.push(String(v));
    };
    walk(res.body);
    for (const f of forbidden) expect(seen.filter((s) => s.includes(f))).toEqual([]);
    expect(res.text).not.toContain(a.id);
  });

  it('ignores any Authorization header (another user’s or a broken one)', async () => {
    const link = (await createLink(a, reportA.id)).body.data as ShareLink;
    expect((await publicGet(link.token).set(bearer(b))).status).toBe(200);
    expect((await publicGet(link.token).set('Authorization', 'Bearer not-a-jwt')).status).toBe(200);
  });

  it('unknown, revoked and expired give byte-for-byte the same 404', async () => {
    const revoked = (await createLink(a, reportA.id)).body.data as ShareLink;
    await request(app).delete(api(`/share-links/${revoked.id}`)).set(bearer(a)).expect(200);
    const expired = (await createLink(a, reportA.id, { expires_in_days: 7 })).body.data as ShareLink;
    await supabaseAdmin().from('share_links').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', expired.id);
    const responses = await Promise.all([publicGet(newToken()), publicGet(revoked.token), publicGet(expired.token), publicGet('short')]);
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(responses[0]!.text);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    }
    expect(JSON.parse(responses[0]!.text)).toEqual({ error: { code: 'not_found', message: 'This link is not valid. Ask the sender for a new one.' } });
  });

  it('deleting the report removes its links: the public URL then 404s', async () => {
    const doomed = await makeReport(a, wsA, 'Doomed', [itemsBlock.id]);
    const link = (await createLink(a, doomed.id)).body.data as ShareLink;
    await publicGet(link.token).expect(200);
    await request(app).delete(api(`/reports/${doomed.id}`)).set(bearer(a)).expect(200);
    expect((await publicGet(link.token)).status).toBe(404);
    const { count } = await supabaseAdmin().from('share_links').select('id', { count: 'exact', head: true }).eq('id', link.id);
    expect(count).toBe(0);
  });

  // Last: it uses up this process's public rate-limit bucket for the test IP.
  it('rate limit: the 61st request in a minute from one IP is 429 with Retry-After', async () => {
    let limited: request.Response | null = null;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await publicGet(newToken());
      if (r.status === 429) limited = r;
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited!.body.error.code).toBe('rate_limited');
  }, 60_000);
});
