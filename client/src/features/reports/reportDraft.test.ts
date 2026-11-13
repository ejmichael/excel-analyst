import { describe, expect, it } from 'vitest';
import type { Block, ReportDetail } from '@/api/types';
import { buildReportPatch, draftErrors, draftFrom, moveBlock } from './reportDraft';

const block = (id: string): Block => ({ id, title: `Answer ${id}` }) as Block;

const report = (): ReportDetail =>
  ({
    id: 'r1',
    title: 'October',
    subtitle: null,
    period_label: 'October 2026',
    notes: null,
    blocks: [
      { position: 0, heading_override: null, block: block('a') },
      { position: 1, heading_override: 'Fees', block: block('b') },
    ],
  }) as unknown as ReportDetail;

describe('buildReportPatch', () => {
  it('is null when nothing changed', () => {
    expect(buildReportPatch(report(), draftFrom(report()))).toBeNull();
  });

  it('sends only the changed fields', () => {
    const draft = { ...draftFrom(report()), title: '  November  ', period_label: '' };
    expect(buildReportPatch(report(), draft)).toEqual({ title: 'November', period_label: null });
  });

  it('sends the full blocks list when the order changes', () => {
    const draft = moveBlock(draftFrom(report()), 'b', -1);
    expect(buildReportPatch(report(), draft)).toEqual({
      blocks: [
        { block_id: 'b', heading_override: 'Fees' },
        { block_id: 'a', heading_override: null },
      ],
    });
  });

  it('sends the full blocks list when a heading changes or an answer is removed', () => {
    const renamed = draftFrom(report());
    renamed.blocks[0]!.heading = 'Sales';
    expect(buildReportPatch(report(), renamed)?.blocks?.[0]).toEqual({ block_id: 'a', heading_override: 'Sales' });

    const removed = { ...draftFrom(report()), blocks: draftFrom(report()).blocks.slice(1) };
    expect(buildReportPatch(report(), removed)).toEqual({ blocks: [{ block_id: 'b', heading_override: 'Fees' }] });
  });
});

describe('draftErrors', () => {
  it('checks the same lengths as the server', () => {
    const draft = { ...draftFrom(report()), title: ' ', subtitle: 'x'.repeat(201), period_label: 'x'.repeat(61), notes: 'x'.repeat(2001) };
    draft.blocks[0]!.heading = 'h'.repeat(121);
    const errors = draftErrors(draft);
    expect(errors.title).toBe('Give the report a title.');
    expect(errors.subtitle).toMatch(/200/);
    expect(errors.period_label).toMatch(/60/);
    expect(errors.notes).toMatch(/000 characters or fewer/);
    expect(errors.headings?.a).toMatch(/120/);
    expect(draftErrors({ ...draftFrom(report()), blocks: [] }).blocks).toBe('A report needs at least one answer.');
  });
});
