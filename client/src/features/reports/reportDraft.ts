import type { Block, ID, ReportDetail, UpdateReportRequest } from '@/api/types';
import { formatNumber } from '@/lib/format';
import { MAX_REPORT_BLOCKS } from './tray';

export const NOTES_MAX = 2000;
export const HEADING_MAX = 120;

/** What edit mode changes. Strings are as typed; empty means "none" (null) for the optional fields. */
export interface ReportDraft {
  title: string;
  subtitle: string;
  period_label: string;
  notes: string;
  blocks: Array<{ block_id: ID; heading: string; block: Block }>;
}

export function draftFrom(report: ReportDetail): ReportDraft {
  return {
    title: report.title,
    subtitle: report.subtitle ?? '',
    period_label: report.period_label ?? '',
    notes: report.notes ?? '',
    blocks: report.blocks.map((b) => ({ block_id: b.block.id, heading: b.heading_override ?? '', block: b.block })),
  };
}

const orNull = (s: string) => s.trim() || null;

/**
 * One PATCH with only the changed fields, plus the full `blocks` list when membership, order or a heading changed
 * (`blocks` replaces the list, so it is all or nothing). Returns null when nothing changed.
 */
export function buildReportPatch(report: ReportDetail, draft: ReportDraft): UpdateReportRequest | null {
  const patch: UpdateReportRequest = {};
  if (draft.title.trim() !== report.title) patch.title = draft.title.trim();
  if (orNull(draft.subtitle) !== report.subtitle) patch.subtitle = orNull(draft.subtitle);
  if (orNull(draft.period_label) !== report.period_label) patch.period_label = orNull(draft.period_label);
  if (orNull(draft.notes) !== report.notes) patch.notes = orNull(draft.notes);

  const before = report.blocks.map((b) => `${b.block.id}|${b.heading_override ?? ''}`).join('\n');
  const after = draft.blocks.map((b) => `${b.block_id}|${b.heading.trim()}`).join('\n');
  if (before !== after) patch.blocks = draft.blocks.map((b) => ({ block_id: b.block_id, heading_override: orNull(b.heading) }));

  return Object.keys(patch).length > 0 ? patch : null;
}

export type DraftErrors = Partial<Record<'title' | 'subtitle' | 'period_label' | 'notes' | 'blocks', string>> & {
  headings?: Record<ID, string>;
};

/** The same bounds as the server, in words. */
export function draftErrors(draft: ReportDraft): DraftErrors {
  const errors: DraftErrors = {};
  const title = draft.title.trim();
  if (!title) errors.title = 'Give the report a title.';
  else if (title.length > 120) errors.title = 'Keep the title to 120 characters or fewer.';
  if (draft.subtitle.trim().length > 200) errors.subtitle = 'Keep the subtitle to 200 characters or fewer.';
  if (draft.period_label.trim().length > 60) errors.period_label = 'Keep the period to 60 characters or fewer.';
  if (draft.notes.length > NOTES_MAX) errors.notes = `Keep the notes to ${formatNumber(NOTES_MAX, 0)} characters or fewer.`;
  if (draft.blocks.length === 0) errors.blocks = 'A report needs at least one answer.';
  if (draft.blocks.length > MAX_REPORT_BLOCKS) errors.blocks = `A report holds at most ${formatNumber(MAX_REPORT_BLOCKS, 0)} answers.`;
  for (const b of draft.blocks) {
    if (b.heading.trim().length > HEADING_MAX) {
      errors.headings = { ...errors.headings, [b.block_id]: `Keep the heading to ${formatNumber(HEADING_MAX, 0)} characters or fewer.` };
    }
  }
  return errors;
}

export function moveBlock(draft: ReportDraft, blockId: ID, direction: -1 | 1): ReportDraft {
  const blocks = [...draft.blocks];
  const from = blocks.findIndex((b) => b.block_id === blockId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= blocks.length) return draft;
  [blocks[from], blocks[to]] = [blocks[to]!, blocks[from]!];
  return { ...draft, blocks };
}
