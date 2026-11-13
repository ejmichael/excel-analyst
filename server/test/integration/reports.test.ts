import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createTestUser, deleteTestUsers, setPlan, step, type TestUser } from './helpers.js';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { supabaseAdmin } from '../../src/lib/supabase.js';
import { profilingIdle } from '../../src/services/profiling.js';
import { DELETED_FILE_MESSAGE, OTHER_WORKSPACE_MESSAGE } from '../../src/services/reports.js';
import type { Block, Brand, Dataset, DatasetDetail, Me, Paged, Report, ReportDetail, Workspace } from '../../src/types/api.js';

/**
 * Reports and branding (S3) against real Supabase. Answers come from the mocked model (cheap): a question starting
 * with "TINY" plans over a small Item,Amount file, anything else plans net sales by store over fixture 01.
 */
vi.mock('../../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/client.js')>();
  const usage = (model: string) => ({ model, inputTokens: 200, outputTokens: 40, costUsd: 0.0012 });
  const chart = (x: string, y: string, vf: Record<string, string>) => ({ type: 'bar', x, y: [y], series: null, orientation: 'vertical', stacked: false, value_format: vf });
  const fake = {
    provider: 'openrouter' as const,
    modelFor: (role: string) => (role === 'planner' ? 'test/planner' : 'test/fast'),
    callTool: vi.fn(async (req: { tool: { name: string }; user: string }) => {
      const question = /^Question: (.*)$/m.exec(req.user)?.[1] ?? '';
      if (req.tool.name === 'plan_analysis') {
        const output = question.startsWith('TINY')
          ? {
              can_answer: true,
              title: 'Amount by item',
              sql: 'SELECT "item", ROUND(SUM("amount"), 2) AS amount FROM data GROUP BY 1 ORDER BY 2 DESC',
              source_filter_sql: null,
              chart: chart('item', 'amount', { item: 'text', amount: 'zar' }),
              reconcile: null,
              narrative_instructions: 'Name the top item.',
            }
          : {
              can_answer: true,
              title: 'Net sales by store',
              sql: 'SELECT "store", ROUND(SUM("net_amount"), 2) AS net FROM data GROUP BY "store" ORDER BY net DESC',
              source_filter_sql: null,
              chart: chart('store', 'net', { store: 'text', net: 'zar' }),
              reconcile: null,
              narrative_instructions: 'Mention the top store.',
            };
        return { output, usage: usage('test/planner') };
      }
      const first = /Result columns \(name \| format\): ([^ |]+)/.exec(req.user)?.[1] ?? 'x';
      return { output: { narrative_template: `{{r0.${first}}} comes first.`, follow_ups: [] }, usage: usage('test/fast') };
    }),
  };
  return { ...actual, llm: () => fake };
});

const app = createApp();
const api = (p: string) => `/api/v1${p}`;
const FIXTURES = new URL('../../../fixtures/', import.meta.url);
const logo = (name: string) => readFileSync(new URL(`../unit/logos/${name}`, import.meta.url));
const TINY = Buffer.from('Item,Amount\nTea,5.00\nCoffee,6.50\nCake,7.25\n');

let a: TestUser; // practice: reports, workspaces, logo
let b: TestUser; // free: limits, watermark, cross-user
let wsA: string;
let wsA2: string; // A's second workspace (another client)
let wsB: string;
let cardA: string;
const blocksA: Block[] = []; // 4 answers on fixture 01 in wsA
let tinyA: Block; // an answer on another file in wsA
let otherWsBlock: Block; // an answer on a file in wsA2
let blockB: Block;

async function consent(u: TestUser): Promise<string> {
  await request(app).patch(api('/me')).set(bearer(u)).send({ accept_terms: true }).expect(200);
  return ((await request(app).get(api('/workspaces')).set(bearer(u)).expect(200)).body.data as Workspace[])[0]!.id;
}

async function uploadReady(u: TestUser, workspace: string, buffer: Buffer, filename: string): Promise<string> {
  const res = await request(app).post(api('/datasets')).set(bearer(u)).field('workspace_id', workspace).attach('file', buffer, filename).expect(201);
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
const createReport = (u: TestUser, body: Record<string, unknown>) => request(app).post(api('/reports')).set(bearer(u)).send(body);
const getReport = async (u: TestUser, id: string) => (await request(app).get(api(`/reports/${id}`)).set(bearer(u)).expect(200)).body.data as ReportDetail;
const countEvents = async (userId: string, kind: string) =>
  (await supabaseAdmin().from('usage_events').select('id', { count: 'exact', head: true }).eq('owner_id', userId).eq('kind', kind)).count ?? 0;
const ids = (detail: ReportDetail) => detail.blocks.map((rb) => rb.block.id);

beforeAll(async () => {
  [a, b] = await Promise.all([createTestUser(), createTestUser()]);
  await setPlan(a.id, 'practice');
  [wsA, wsB] = await Promise.all([consent(a), consent(b)]);
  wsA2 = (await request(app).post(api('/workspaces')).set(bearer(a)).send({ name: 'Client two' }).expect(201)).body.data.id;
  await step('upload files and ask (mocked model)', async () => {
    cardA = await uploadReady(a, wsA, readFileSync(new URL('01_card_sales_semicolon_win1252.csv', FIXTURES)), 'card.csv');
    const [tinyId, otherId, tinyB] = await Promise.all([
      uploadReady(a, wsA, TINY, 'tiny.csv'),
      uploadReady(a, wsA2, TINY, 'client-two.csv'),
      uploadReady(b, wsB, TINY, 'b.csv'),
    ]);
    for (let i = 0; i < 4; i++) blocksA.push(await ask(a, cardA, `Net sales by store, take ${i + 1}`));
    tinyA = await ask(a, tinyId, 'TINY amount by item');
    otherWsBlock = await ask(a, otherId, 'TINY amount by item for client two');
    blockB = await ask(b, tinyB, 'TINY what sold?');
  });
}, 240_000);

afterAll(async () => {
  await profilingIdle();
  await deleteTestUsers();
});

describe('POST /reports', () => {
  let created: ReportDetail;

  it('creates a report (201 ReportDetail) from blocks of two files in the same workspace, in the given order', async () => {
    const before = await countEvents(a.id, 'report');
    const order = [blocksA[2]!.id, tinyA.id, blocksA[0]!.id];
    const res = await createReport(a, { workspace_id: wsA, title: '  October report ', subtitle: 'For the owners', period_label: 'October 2026', block_ids: order });
    expect(res.status).toBe(201);
    created = res.body.data as ReportDetail;
    expect(created).toMatchObject({ workspace_id: wsA, title: 'October report', subtitle: 'For the owners', period_label: 'October 2026', notes: null, template_id: null, block_count: 3, watermark: false, comparison: null });
    expect(ids(created)).toEqual(order);
    expect(created.blocks.map((rb) => rb.position)).toEqual([0, 1, 2]);
    expect(created.blocks.every((rb) => rb.heading_override === null)).toBe(true);
    expect(created.brand).toEqual({ business_name: null, logo_url: null, color: '#1E7A5F' });
    // The report usage event is written once, after success.
    expect(await countEvents(a.id, 'report')).toBe(before + 1);
  });

  it('refuses a block from a file in another workspace (422) and writes nothing', async () => {
    const before = await countEvents(a.id, 'report');
    const { count: reportsBefore } = await supabaseAdmin().from('reports').select('id', { count: 'exact', head: true }).eq('owner_id', a.id);
    const res = await createReport(a, { workspace_id: wsA, title: 'Mixed clients', block_ids: [blocksA[0]!.id, otherWsBlock.id] });
    expect(res.status).toBe(422);
    // One refused answer among valid ones: one entry, at its 0-based position in block_ids, with the unchanged message.
    expect(res.body.error).toEqual({
      code: 'validation_failed',
      message: OTHER_WORKSPACE_MESSAGE,
      details: { fields: [{ location: 'body', path: 'block_ids.1', message: OTHER_WORKSPACE_MESSAGE }] },
    });
    expect(await countEvents(a.id, 'report')).toBe(before);
    const { count: reportsAfter } = await supabaseAdmin().from('reports').select('id', { count: 'exact', head: true }).eq('owner_id', a.id);
    expect(reportsAfter).toBe(reportsBefore);
  });

  it('the same block is fine in a report of its own workspace', async () => {
    expect((await createReport(a, { workspace_id: wsA2, title: 'Client two', block_ids: [otherWsBlock.id] })).status).toBe(201);
  });

  it('validation: duplicates, 0 and 31 blocks, lengths and unknown fields are 422', async () => {
    const one = blocksA[0]!.id;
    for (const body of [
      { workspace_id: wsA, title: 'Dup', block_ids: [one, one] },
      { workspace_id: wsA, title: 'None', block_ids: [] },
      { workspace_id: wsA, title: 'Too many', block_ids: Array.from({ length: 31 }, () => crypto.randomUUID()) },
      { workspace_id: wsA, title: 'x'.repeat(121), block_ids: [one] },
      { workspace_id: wsA, title: 'Extra', block_ids: [one], notes: 'not on create' },
    ]) {
      const res = await createReport(a, body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('a workspace that is not the caller\'s is 404 (checked before the limit and the body)', async () => {
    expect((await createReport(a, { workspace_id: wsB, title: 'x', block_ids: [blocksA[0]!.id] })).status).toBe(404);
    expect((await createReport(b, { workspace_id: wsA, title: 'x', block_ids: [] })).status).toBe(404);
  });

  it('user B cannot use A\'s block ids (404, no hint which)', async () => {
    const res = await createReport(b, { workspace_id: wsB, title: 'Borrowed', block_ids: [blockB.id, blocksA[0]!.id] });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Answer not found.');
  });

  it('free plan: the first report is fine (watermarked), the second is 402 with PlanLimitDetails', async () => {
    const first = await createReport(b, { workspace_id: wsB, title: 'B one', block_ids: [blockB.id] });
    expect(first.status).toBe(201);
    expect((first.body.data as ReportDetail).watermark).toBe(true);
    const before = await countEvents(b.id, 'report');
    const second = await createReport(b, { workspace_id: wsB, title: 'B two', block_ids: [blockB.id] });
    expect(second.status).toBe(402);
    expect(second.body.error).toMatchObject({ code: 'plan_limit', details: { limit_key: 'max_reports_per_month', limit: 1, used: 1, upgrade_to: 'solo' } });
    expect(await countEvents(b.id, 'report')).toBe(before);
  });

  it('list and read: newest first with block_count; blocks in order with brand and watermark', async () => {
    const page = (await request(app).get(api(`/reports?workspace_id=${wsA}`)).set(bearer(a)).expect(200)).body.data as Paged<Report>;
    expect(page.items.map((r) => r.id)).toContain(created.id);
    expect(page.items.find((r) => r.id === created.id)!.block_count).toBe(3);
    const times = page.items.map((r) => Date.parse(r.created_at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(page).toMatchObject({ limit: 50, offset: 0 });
    // Another workspace's reports are not in this list.
    expect(page.items.every((r) => r.workspace_id === wsA)).toBe(true);
    const detail = await getReport(a, created.id);
    expect(ids(detail)).toEqual(ids(created));
    expect(detail.blocks[0]!.block).toMatchObject({ id: blocksA[2]!.id, title: 'Net sales by store' });
    expect(detail).toHaveProperty('brand');
    expect(detail.watermark).toBe(false);
    // workspace_id is required; another user's workspace is 404.
    expect((await request(app).get(api('/reports')).set(bearer(a))).status).toBe(422);
    expect((await request(app).get(api(`/reports?workspace_id=${wsA}`)).set(bearer(b))).status).toBe(404);
  });

  it('user B gets 404 on A\'s report: read, patch and delete', async () => {
    expect((await request(app).get(api(`/reports/${created.id}`)).set(bearer(b))).status).toBe(404);
    expect((await request(app).patch(api(`/reports/${created.id}`)).set(bearer(b)).send({ title: 'Mine now' })).status).toBe(404);
    expect((await request(app).delete(api(`/reports/${created.id}`)).set(bearer(b))).status).toBe(404);
    expect((await getReport(a, created.id)).title).toBe('October report');
  });
});

describe('PATCH /reports/:id', () => {
  let report: ReportDetail;
  beforeAll(async () => {
    report = (await createReport(a, { workspace_id: wsA, title: 'To edit', block_ids: [blocksA[0]!.id, blocksA[1]!.id, blocksA[2]!.id] }).expect(201)).body.data;
  });

  it('reorders, renames headings, removes and adds blocks in one go; edits do not count as a report', async () => {
    const before = await countEvents(a.id, 'report');
    const res = await request(app)
      .patch(api(`/reports/${report.id}`))
      .set(bearer(a))
      .send({
        title: 'Edited',
        notes: 'Checked with the bank statement.',
        subtitle: null,
        blocks: [
          { block_id: blocksA[3]!.id, heading_override: 'Added' },
          { block_id: blocksA[2]!.id, heading_override: '  Biggest store  ' },
          { block_id: blocksA[0]!.id },
        ],
      });
    expect(res.status).toBe(200);
    const d = res.body.data as ReportDetail;
    expect(d).toMatchObject({ title: 'Edited', notes: 'Checked with the bank statement.', subtitle: null, block_count: 3 });
    expect(ids(d)).toEqual([blocksA[3]!.id, blocksA[2]!.id, blocksA[0]!.id]);
    expect(d.blocks.map((rb) => [rb.position, rb.heading_override])).toEqual([
      [0, 'Added'],
      [1, 'Biggest store'],
      [2, null],
    ]);
    expect(await countEvents(a.id, 'report')).toBe(before);
    report = d;
  });

  it('a failure leaves the old blocks intact: a refused list (422), and a failing database write', async () => {
    const old = ids(report);
    const refused = await request(app)
      .patch(api(`/reports/${report.id}`))
      .set(bearer(a))
      .send({ blocks: [{ block_id: blocksA[1]!.id }, { block_id: otherWsBlock.id }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toEqual({
      code: 'validation_failed',
      message: OTHER_WORKSPACE_MESSAGE,
      details: { fields: [{ location: 'body', path: 'blocks.1.block_id', message: OTHER_WORKSPACE_MESSAGE }] },
    });
    expect(ids(await getReport(a, report.id))).toEqual(old);
    // Inject a failure inside the transaction: the SQL function first applies the new title, then fails on a block id
    // that does not exist. The title change must roll back with it, and the blocks stay as they were.
    const { error } = await supabaseAdmin().rpc('update_report_with_blocks', {
      p_owner_id: a.id,
      p_report_id: report.id,
      p_fields: { title: 'Should not stick' },
      p_blocks: [{ block_id: blocksA[1]!.id, heading_override: null }, { block_id: crypto.randomUUID(), heading_override: null }],
    });
    expect(error).not.toBeNull();
    const after = await getReport(a, report.id);
    expect(ids(after)).toEqual(old);
    expect(after.title).toBe('Edited');
  });

  it('strict body, empty body, lengths and another user\'s block', async () => {
    const patch = (body: unknown) => request(app).patch(api(`/reports/${report.id}`)).set(bearer(a)).send(body as object);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ workspace_id: wsA2 })).status).toBe(422);
    expect((await patch({ notes: 'x'.repeat(2001) })).status).toBe(422);
    expect((await patch({ blocks: [{ block_id: blocksA[0]!.id, heading_override: 'x'.repeat(121) }] })).status).toBe(422);
    expect((await patch({ blocks: [{ block_id: blockB.id }] })).status).toBe(404);
  });

  it('a block whose file was deleted: refused on create, kept on update only when already in the report', async () => {
    const tmp = await uploadReady(a, wsA, TINY, 'to-delete.csv');
    const orphan = await ask(a, tmp, 'TINY soon an orphan');
    const holder = (await createReport(a, { workspace_id: wsA, title: 'Holds the orphan', block_ids: [orphan.id] }).expect(201)).body.data as ReportDetail;
    await request(app).delete(api(`/datasets/${tmp}`)).set(bearer(a)).expect(200);

    const created = await createReport(a, { workspace_id: wsA, title: 'New with orphan', block_ids: [orphan.id] });
    expect(created.status).toBe(422);
    expect(created.body.error.message).toBe(DELETED_FILE_MESSAGE);

    const kept = await request(app).patch(api(`/reports/${holder.id}`)).set(bearer(a)).send({ blocks: [{ block_id: blocksA[0]!.id }, { block_id: orphan.id, heading_override: 'Old file' }] });
    expect(kept.status).toBe(200);
    expect(ids(kept.body.data as ReportDetail)).toEqual([blocksA[0]!.id, orphan.id]);

    const added = await request(app).patch(api(`/reports/${report.id}`)).set(bearer(a)).send({ blocks: [{ block_id: blocksA[0]!.id }, { block_id: orphan.id }] });
    expect(added.status).toBe(422);
    expect(added.body.error.message).toBe(DELETED_FILE_MESSAGE);
    expect(added.body.error.details.fields).toEqual([{ location: 'body', path: 'blocks.1.block_id', message: DELETED_FILE_MESSAGE }]);

    // Two refused answers in one request: two entries with the right positions, each with its own message.
    const twoOnCreate = await createReport(a, { workspace_id: wsA, title: 'Two refused', block_ids: [blocksA[0]!.id, otherWsBlock.id, orphan.id] });
    expect(twoOnCreate.status).toBe(422);
    expect(twoOnCreate.body.error.message).toBe(OTHER_WORKSPACE_MESSAGE);
    expect(twoOnCreate.body.error.details.fields).toEqual([
      { location: 'body', path: 'block_ids.1', message: OTHER_WORKSPACE_MESSAGE },
      { location: 'body', path: 'block_ids.2', message: DELETED_FILE_MESSAGE },
    ]);
    const twoOnPatch = await request(app)
      .patch(api(`/reports/${report.id}`))
      .set(bearer(a))
      .send({ blocks: [{ block_id: otherWsBlock.id }, { block_id: blocksA[0]!.id }, { block_id: orphan.id }] });
    expect(twoOnPatch.status).toBe(422);
    expect(twoOnPatch.body.error.details.fields).toEqual([
      { location: 'body', path: 'blocks.0.block_id', message: OTHER_WORKSPACE_MESSAGE },
      { location: 'body', path: 'blocks.2.block_id', message: DELETED_FILE_MESSAGE },
    ]);
  });
});

describe('the report SQL functions are server-only', () => {
  it('a signed-in user calling them through the Supabase REST /rpc endpoint gets permission denied, and nothing is written', async () => {
    const { count: before } = await supabaseAdmin().from('reports').select('id', { count: 'exact', head: true }).eq('owner_id', a.id);
    const rpc = (fn: string, body: unknown) =>
      fetch(`${env().SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: env().SUPABASE_ANON_KEY, Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    // A's own token and A's own ids: still refused, because only the service role may execute them.
    const create = await rpc('create_report_with_blocks', {
      p_owner_id: a.id,
      p_workspace_id: wsA,
      p_title: 'Straight to the database',
      p_subtitle: null,
      p_period_label: null,
      p_block_ids: [blocksA[0]!.id],
    });
    const anyReport = (await supabaseAdmin().from('reports').select('id').eq('owner_id', a.id).limit(1).single()).data!.id;
    const update = await rpc('update_report_with_blocks', { p_owner_id: a.id, p_report_id: anyReport, p_fields: { title: 'Hijacked' }, p_blocks: null });
    for (const res of [create, update]) {
      expect([401, 403]).toContain(res.status);
      expect(((await res.json()) as { code: string }).code).toBe('42501'); // insufficient_privilege: permission denied
    }
    const { count: after } = await supabaseAdmin().from('reports').select('id', { count: 'exact', head: true }).eq('owner_id', a.id);
    expect(after).toBe(before);
    expect((await supabaseAdmin().from('reports').select('title').eq('id', anyReport).single()).data!.title).not.toBe('Hijacked');
  });
});

describe('DELETE /reports/:id and pinned blocks', () => {
  it('a pinned block cannot be deleted (409) until its reports are deleted; deleting a report keeps its blocks', async () => {
    const pinnedBlock = await ask(a, cardA, 'Net sales by store, to pin');
    const r = (await createReport(a, { workspace_id: wsA, title: 'Pins', block_ids: [pinnedBlock.id] }).expect(201)).body.data as ReportDetail;
    const refused = await request(app).delete(api(`/blocks/${pinnedBlock.id}`)).set(bearer(a));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('conflict');

    expect((await request(app).delete(api(`/reports/${r.id}`)).set(bearer(a)).expect(200)).body).toEqual({ data: { deleted: true } });
    expect((await request(app).get(api(`/reports/${r.id}`)).set(bearer(a))).status).toBe(404);
    const { count } = await supabaseAdmin().from('report_blocks').select('id', { count: 'exact', head: true }).eq('report_id', r.id);
    expect(count).toBe(0);
    expect((await request(app).get(api(`/blocks/${pinnedBlock.id}`)).set(bearer(a))).status).toBe(200);
    await request(app).delete(api(`/blocks/${pinnedBlock.id}`)).set(bearer(a)).expect(200);
  });
});

describe('branding', () => {
  const upload = (u: TestUser, buf: Buffer, name: string) => request(app).post(api('/me/logo')).set(bearer(u)).attach('file', buf, name);
  const listLogos = async (ownerId: string) => {
    const { data } = await supabaseAdmin().storage.from(env().STORAGE_BUCKET_BRANDING).list(ownerId);
    return (data ?? []).map((o) => o.name).sort();
  };

  it('on free, brand_color and the logo are 402 with upgrade_to solo', async () => {
    const color = await request(app).patch(api('/me')).set(bearer(b)).send({ brand_color: '#112233' });
    expect(color.status).toBe(402);
    expect(color.body.error.details).toMatchObject({ limit_key: 'branding', limit: 0, upgrade_to: 'solo' });
    const up = await upload(b, logo('logo.png'), 'logo.png');
    expect(up.status).toBe(402);
    expect(up.body.error.details).toMatchObject({ limit_key: 'branding', limit: 0, upgrade_to: 'solo' });
    expect((await request(app).delete(api('/me/logo')).set(bearer(b))).status).toBe(402);
  });

  it('on a paid plan: upload, a working signed URL, a path with only owner_id, replace, then delete', async () => {
    await request(app).patch(api('/me')).set(bearer(a)).send({ brand_color: '#AA3300', business_name: 'Padstal Traders' }).expect(200);
    const res = await upload(a, logo('logo.png'), 'company logo.gif'); // the name and its extension play no part
    expect(res.status).toBe(200);
    const brand = res.body.data as Brand;
    expect(brand).toMatchObject({ business_name: 'Padstal Traders', color: '#AA3300' });
    expect(brand.logo_url).toMatch(/^https:\/\/.+\/storage\/v1\/object\/sign\/.+token=/);
    const fetched = await fetch(brand.logo_url!);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(logo('logo.png'))).toBe(true);
    const { data: profile } = await supabaseAdmin().from('profiles').select('brand_logo_path').eq('id', a.id).single();
    expect(profile!.brand_logo_path).toBe(`${a.id}/logo.png`); // the path, never a signed URL
    expect(await listLogos(a.id)).toEqual(['logo.png']);

    // GET /me signs a fresh URL; a report carries the brand too.
    const me = (await request(app).get(api('/me')).set(bearer(a)).expect(200)).body.data as Me;
    expect(me.brand.logo_url).toMatch(/token=/);
    const r = (await createReport(a, { workspace_id: wsA, title: 'Branded', block_ids: [blocksA[0]!.id] }).expect(201)).body.data as ReportDetail;
    expect(r.brand).toMatchObject({ business_name: 'Padstal Traders', color: '#AA3300' });
    expect(r.brand.logo_url).toMatch(/token=/);

    // Replacing with a JPEG removes the PNG.
    const replaced = await upload(a, logo('logo.jpg'), 'logo.jpg');
    expect(replaced.status).toBe(200);
    expect(await listLogos(a.id)).toEqual(['logo.jpg']);

    // Refusals change nothing.
    expect((await upload(a, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'logo.svg')).status).toBe(415);
    expect((await upload(a, logo('logo.gif'), 'logo.gif')).status).toBe(415);
    expect((await upload(a, Buffer.from('plain text'), 'logo.png')).status).toBe(415);
    expect((await upload(a, logo('wide.png'), 'wide.png')).status).toBe(422);
    expect((await upload(a, Buffer.concat([logo('logo.png'), Buffer.alloc(1024 * 1024)]), 'big.png')).status).toBe(413);
    expect(await listLogos(a.id)).toEqual(['logo.jpg']);

    const removed = await request(app).delete(api('/me/logo')).set(bearer(a));
    expect(removed.status).toBe(200);
    expect((removed.body.data as Brand).logo_url).toBeNull();
    expect(await listLogos(a.id)).toEqual([]);
    const { data: after } = await supabaseAdmin().from('profiles').select('brand_logo_path').eq('id', a.id).single();
    expect(after!.brand_logo_path).toBeNull();
  });

  it("A's logo is not reachable through B", async () => {
    await request(app).post(api('/me/logo')).set(bearer(a)).attach('file', logo('logo-lossless.webp'), 'l.webp').expect(200);
    // B's own brand has no logo, and B's signed-in storage client cannot read A's object (private bucket, no policy).
    expect(((await request(app).get(api('/me')).set(bearer(b)).expect(200)).body.data as Me).brand.logo_url).toBeNull();
    const asB = createClient(env().SUPABASE_URL, env().SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${b.token}` } },
    });
    const { data, error } = await asB.storage.from(env().STORAGE_BUCKET_BRANDING).download(`${a.id}/logo.webp`);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    const { data: signed } = await asB.storage.from(env().STORAGE_BUCKET_BRANDING).createSignedUrl(`${a.id}/logo.webp`, 60);
    expect(signed).toBeNull();
  });
});

describe('payload size of a 30-block ReportDetail', () => {
  it('is measured with and without compression', async () => {
    // 30 answers of 500 rows each (the stored maximum), inserted directly: text, references, amounts and dates that differ
    // in every answer (identical answers would let brotli's large window deduplicate them and flatter the result).
    const { data: template } = await supabaseAdmin().from('blocks').select('*').eq('id', blocksA[0]!.id).single();
    let seed = 20261113;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const makeRows = () =>
      Array.from({ length: 500 }, () => ({
        transaction_date: `2026-10-${String(Math.floor(rand() * 31) + 1).padStart(2, '0')}`,
        store: ['Pietermaritzburg Padstal', 'Café Rosé Sandton', 'Müller Bakkery Pretoria'][Math.floor(rand() * 3)],
        reference: `TX${Math.floor(rand() * 1e8)}`,
        card_type: ['VISA', 'MASTERCARD', 'DEBIT'][Math.floor(rand() * 3)],
        gross: Math.round(rand() * 250000) / 100,
        net: Math.round(rand() * 240000) / 100,
      }));
    const columns = ['transaction_date', 'store', 'reference', 'card_type', 'gross', 'net'].map((name) => ({
      name,
      format: name === 'gross' || name === 'net' ? 'zar' : name === 'transaction_date' ? 'date' : 'text',
    }));
    const inserts = Array.from({ length: 30 }, (_, i) => {
      const { id: _id, created_at: _c, ...rest } = template!;
      return { ...rest, title: `Transactions ${i + 1}`, columns, rows: makeRows(), row_count: 500 };
    });
    const { data: made, error } = await supabaseAdmin().from('blocks').insert(inserts).select('id');
    expect(error).toBeNull();
    const big = (await createReport(a, { workspace_id: wsA, title: 'Thirty answers', block_ids: made!.map((m) => m.id) }).expect(201)).body.data as ReportDetail;

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const fetchBytes = (encoding: string) =>
        new Promise<{ bytes: number; encoding: string | undefined }>((resolve, reject) => {
          const req = httpRequest({ port, path: api(`/reports/${big.id}`), headers: { ...bearer(a), 'Accept-Encoding': encoding } }, (res) => {
            let bytes = 0;
            res.on('data', (c: Buffer) => (bytes += c.length));
            res.on('end', () => resolve({ bytes, encoding: res.headers['content-encoding'] }));
          });
          req.on('error', reject);
          req.end();
        });
      const plain = await fetchBytes('identity');
      const gzip = await fetchBytes('gzip');
      const brotli = await fetchBytes('br');
      expect(plain.encoding).toBeUndefined();
      expect(gzip.encoding).toBe('gzip');
      expect(gzip.bytes).toBeLessThan(plain.bytes / 4);
      // Sizes only (no data) for STATUS.md.
      console.log(`[payload] 30 blocks x 500 rows ReportDetail: identity ${plain.bytes} B, gzip ${gzip.bytes} B, br ${brotli.bytes} B (${brotli.encoding ?? 'identity'})`);
    } finally {
      server.close();
    }
    await request(app).delete(api(`/reports/${big.id}`)).set(bearer(a)).expect(200);
  }, 60_000);
});
