import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { watermarkFor } from '../../src/services/brand.js';
import {
  createReportBody,
  DELETED_FILE_MESSAGE,
  MAX_REPORT_BLOCKS,
  OTHER_WORKSPACE_MESSAGE,
  updateReportBody,
  workspaceRuleRefusals,
} from '../../src/services/reports.js';

const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
const ws = randomUUID();
const create = (over: Record<string, unknown> = {}) => createReportBody.safeParse({ workspace_id: ws, title: 'October', block_ids: ids(2), ...over });
const update = (body: unknown) => updateReportBody.safeParse(body);

describe('CreateReportRequest validation', () => {
  it('accepts a normal body, trims text and stores empty optional text as null', () => {
    const r = create({ title: '  October report  ', subtitle: '  ', period_label: 'October 2026' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ title: 'October report', subtitle: null, period_label: 'October 2026' });
  });

  it('is strict: unknown fields are refused', () => {
    expect(create({ notes: 'not allowed on create' }).success).toBe(false);
    expect(create({ owner_id: randomUUID() }).success).toBe(false);
  });

  it.each([
    ['empty title', { title: '   ' }],
    ['title of 121 characters', { title: 'x'.repeat(121) }],
    ['subtitle of 201 characters', { subtitle: 'x'.repeat(201) }],
    ['period_label of 61 characters', { period_label: 'x'.repeat(61) }],
    ['0 blocks', { block_ids: [] }],
    ['31 blocks', { block_ids: ids(MAX_REPORT_BLOCKS + 1) }],
    ['a duplicate block', { block_ids: (() => { const [a, b] = ids(2); return [a, b, a]; })() }],
    ['a block id that is not a UUID', { block_ids: ['abc'] }],
    ['a workspace id that is not a UUID', { workspace_id: 'nope' }],
  ])('refuses %s', (_name, over) => {
    expect(create(over).success).toBe(false);
  });

  it('accepts exactly 1, 30, and the length limits', () => {
    expect(create({ block_ids: ids(1) }).success).toBe(true);
    expect(create({ block_ids: ids(30) }).success).toBe(true);
    expect(create({ title: 'x'.repeat(120), subtitle: 'x'.repeat(200), period_label: 'x'.repeat(60) }).success).toBe(true);
  });

  it('the duplicate message is plain English', () => {
    const [a] = ids(1);
    const r = create({ block_ids: [a, a] });
    expect(r.error?.issues[0]?.message).toBe('Each answer can appear only once in a report.');
  });
});

describe('UpdateReportRequest validation', () => {
  it('an empty body is refused', () => {
    expect(update({}).success).toBe(false);
  });

  it('is strict, including inside blocks', () => {
    expect(update({ title: 'x', workspace_id: ws }).success).toBe(false);
    expect(update({ blocks: [{ block_id: randomUUID(), position: 3 }] }).success).toBe(false);
  });

  it.each([
    ['notes of 2001 characters', { notes: 'x'.repeat(2001) }],
    ['0 blocks', { blocks: [] }],
    ['31 blocks', { blocks: ids(31).map((block_id) => ({ block_id })) }],
    ['a duplicate block', { blocks: (() => { const [a] = ids(1); return [{ block_id: a }, { block_id: a }]; })() }],
    ['a heading of 121 characters', { blocks: [{ block_id: randomUUID(), heading_override: 'x'.repeat(121) }] }],
    ['an empty title', { title: '' }],
  ])('refuses %s', (_name, body) => {
    expect(update(body).success).toBe(false);
  });

  it('accepts notes of 2000, headings of 120 or null, and null to clear text', () => {
    const r = update({ notes: 'x'.repeat(2000), subtitle: null, blocks: [{ block_id: randomUUID(), heading_override: 'x'.repeat(120) }, { block_id: randomUUID(), heading_override: null }] });
    expect(r.success).toBe(true);
    expect(r.data?.subtitle).toBeNull();
  });
});

describe('the workspace rule', () => {
  const [d1, d2, other] = ids(3);
  const here = (id: string, dataset: string) => ({ id, dataset_id: dataset, workspace_id: ws });

  const elsewhere = () => ({ id: randomUUID(), dataset_id: d2!, workspace_id: other! });
  const orphan = () => ({ id: randomUUID(), dataset_id: null, workspace_id: null });

  it('blocks from datasets in the same workspace are allowed, from one or several datasets', () => {
    expect(workspaceRuleRefusals([here(randomUUID(), d1!), here(randomUUID(), d2!)], ws, null)).toEqual([]);
  });

  it('one refused answer among valid ones gives one refusal at its position, with the message unchanged', () => {
    const blocks = [here(randomUUID(), d1!), elsewhere(), here(randomUUID(), d1!)];
    expect(workspaceRuleRefusals(blocks, ws, null)).toEqual([{ index: 1, message: OTHER_WORKSPACE_MESSAGE }]);
    expect(workspaceRuleRefusals(blocks, ws, new Set(blocks.map((b) => b.id)))).toEqual([{ index: 1, message: OTHER_WORKSPACE_MESSAGE }]);
    expect(OTHER_WORKSPACE_MESSAGE).toBe('Some of these answers come from a file in another workspace. A report can only hold answers from files in its own workspace.');
  });

  it('two refused answers give two refusals with the right positions, each with its own message', () => {
    const blocks = [elsewhere(), here(randomUUID(), d1!), here(randomUUID(), d1!), orphan()];
    expect(workspaceRuleRefusals(blocks, ws, null)).toEqual([
      { index: 0, message: OTHER_WORKSPACE_MESSAGE },
      { index: 3, message: DELETED_FILE_MESSAGE },
    ]);
  });

  it('a block whose dataset was deleted is refused on create', () => {
    expect(workspaceRuleRefusals([orphan()], ws, null)).toEqual([{ index: 0, message: DELETED_FILE_MESSAGE }]);
    expect(DELETED_FILE_MESSAGE).toBe('Some of these answers come from a file that has been deleted, so we cannot check which workspace they belong to. Remove them from the report.');
  });

  it('on update it is allowed only when already in the report', () => {
    const o = orphan();
    expect(workspaceRuleRefusals([o], ws, new Set([o.id]))).toEqual([]);
    expect(workspaceRuleRefusals([here(randomUUID(), d1!), o], ws, new Set([randomUUID()]))).toEqual([{ index: 1, message: DELETED_FILE_MESSAGE }]);
  });
});

describe('watermark', () => {
  it('is true only on free', () => {
    expect(watermarkFor('free')).toBe(true);
    for (const plan of ['solo', 'practice', 'practice_plus'] as const) expect(watermarkFor(plan)).toBe(false);
  });
});
