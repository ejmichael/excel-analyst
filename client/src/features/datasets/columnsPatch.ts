import type { ColumnSemantic, DatasetColumn, ID, UpdateDatasetRequest } from '@/api/types';

/** What the form edits for one column. An empty display name means "use the original name" (null). */
export interface ColumnDraft {
  display_name: string;
  semantic: ColumnSemantic;
  is_pii: boolean;
  vat_included: boolean | null;
}

export type ColumnDrafts = Record<ID, ColumnDraft>;
export type ColumnPatch = NonNullable<UpdateDatasetRequest['columns']>[number];

export function draftsFrom(columns: DatasetColumn[]): ColumnDrafts {
  return Object.fromEntries(
    columns.map((c) => [
      c.id,
      { display_name: c.display_name ?? '', semantic: c.semantic, is_pii: c.is_pii, vat_included: c.vat_included },
    ]),
  );
}

const displayValue = (value: string): string | null => value.trim() || null;

/** Only the columns that changed, and in each only the fields that changed. */
export function buildColumnsPatch(columns: DatasetColumn[], drafts: ColumnDrafts): ColumnPatch[] {
  const patch: ColumnPatch[] = [];
  for (const column of columns) {
    const draft = drafts[column.id];
    if (!draft) continue;
    const change: ColumnPatch = { id: column.id };
    if (displayValue(draft.display_name) !== column.display_name) change.display_name = displayValue(draft.display_name);
    if (draft.semantic !== column.semantic) change.semantic = draft.semantic;
    if (draft.is_pii !== column.is_pii) change.is_pii = draft.is_pii;
    if (draft.vat_included !== column.vat_included) change.vat_included = draft.vat_included;
    if (Object.keys(change).length > 1) patch.push(change);
  }
  return patch;
}

/**
 * Server field errors come back by position in the request (`columns.2.semantic`); this maps them to the
 * column id and field, so each message shows next to the right control.
 */
export function columnFieldErrors(
  fieldErrors: Record<string, string>,
  patch: ColumnPatch[],
): Record<ID, Partial<Record<keyof ColumnDraft | 'column', string>>> {
  const out: Record<ID, Partial<Record<keyof ColumnDraft | 'column', string>>> = {};
  for (const [path, message] of Object.entries(fieldErrors)) {
    const match = /^columns\.(\d+)(?:\.(\w+))?$/.exec(path);
    if (!match) continue;
    const id = patch[Number(match[1])]?.id;
    if (!id) continue;
    const field = match[2];
    const key = field === 'display_name' || field === 'semantic' || field === 'is_pii' || field === 'vat_included' ? field : 'column';
    out[id] = { ...out[id], [key]: message };
  }
  return out;
}
