import { useEffect, useId, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { DatasetColumn, DatasetDetail, UpdateDatasetRequest } from '@/api/types';
import { FieldError, FormMessage } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { buildColumnsPatch, columnFieldErrors, draftsFrom, type ColumnDraft, type ColumnDrafts } from './columnsPatch';
import { DATA_TYPE_LABELS, PII_SEMANTICS, SEMANTIC_OPTIONS, semanticHelp } from './labels';

export const selectClass =
  'h-11 w-full rounded-md border border-input bg-card px-3 text-base md:text-sm focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 outline-none aria-invalid:border-destructive';

const VAT_OPTIONS: Array<{ value: string; label: string; stored: boolean | null }> = [
  { value: 'unknown', label: 'Not sure yet', stored: null },
  { value: 'incl', label: 'Includes VAT', stored: true },
  { value: 'excl', label: 'Excludes VAT', stored: false },
];

interface ColumnsFormProps {
  columns: DatasetColumn[];
  onSave: (columns: NonNullable<UpdateDatasetRequest['columns']>) => Promise<DatasetDetail>;
}

/** Column names, meanings, Private and VAT, edited locally and saved together. */
export function ColumnsForm({ columns, onSave }: ColumnsFormProps) {
  const [drafts, setDrafts] = useState<ColumnDrafts>(() => draftsFrom(columns));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<ReturnType<typeof columnFieldErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // New data from the server (after a save or a re-read) replaces the drafts.
  useEffect(() => setDrafts(draftsFrom(columns)), [columns]);

  const patch = useMemo(() => buildColumnsPatch(columns, drafts), [columns, drafts]);
  const dirty = patch.length > 0;

  const update = (id: string, change: Partial<ColumnDraft>) => {
    setSaved(false);
    setDrafts((d) => {
      const current = d[id];
      return current ? { ...d, [id]: { ...current, ...change } } : d;
    });
  };

  const save = async () => {
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      await onSave(patch);
      setSaved(true);
    } catch (error) {
      const byColumn = isApiError(error) ? columnFieldErrors(error.fieldErrors, patch) : {};
      setErrors(byColumn);
      if (Object.keys(byColumn).length === 0) setFormError(errorMessage(error));
      else setFormError('Some columns need attention. Check the messages next to them.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="columns-heading" className="space-y-4">
      <div>
        <h2 id="columns-heading" className="text-xl font-semibold">
          Columns
        </h2>
        <p className="text-sm text-muted-foreground">
          Rename columns and say what they mean. Private columns are hidden from the AI: it never sees their values.
        </p>
      </div>

      <ul className="space-y-3">
        {columns.map((column) => {
          const draft = drafts[column.id];
          return draft ? (
            <ColumnRow
              key={column.id}
              column={column}
              draft={draft}
              errors={errors[column.id] ?? {}}
              onChange={(change) => update(column.id, change)}
            />
          ) : null;
        })}
      </ul>

      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center',
          // Pinned to the bottom of the screen only while there is something to save.
          dirty && 'sticky bottom-2 z-10 border-primary/50 shadow-md',
        )}
      >
        <div className="flex-1 space-y-2" aria-live="polite">
          {formError && <FormMessage>{formError}</FormMessage>}
          {!formError && (
            <p className="text-sm">
              {dirty
                ? `Unsaved changes in ${patch.length} ${patch.length === 1 ? 'column' : 'columns'}.`
                : saved
                  ? 'Changes saved.'
                  : 'No unsaved changes.'}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dirty || saving} onClick={() => setDrafts(draftsFrom(columns))}>
            Discard
          </Button>
          <Button disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ColumnRow({
  column,
  draft,
  errors,
  onChange,
}: {
  column: DatasetColumn;
  draft: ColumnDraft;
  errors: Partial<Record<keyof ColumnDraft | 'column', string>>;
  onChange: (change: Partial<ColumnDraft>) => void;
}) {
  const id = useId();
  const willTurnPrivate = PII_SEMANTICS.has(draft.semantic) && !draft.is_pii && draft.semantic !== column.semantic;
  const samples = column.sample_values.filter((v) => v !== '').slice(0, 3);

  return (
    <li className="rounded-xl border bg-card p-4" aria-labelledby={`${id}-name`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={`${id}-name`} className="font-sans text-base font-semibold">
          {column.name}
        </h3>
        <span className="text-sm text-muted-foreground">{DATA_TYPE_LABELS[column.data_type]}</span>
        {column.is_pii && (
          <span className="inline-flex items-center gap-1 text-sm text-primary">
            <ShieldCheck className="size-4" aria-hidden /> Private
          </span>
        )}
      </div>
      {samples.length > 0 && (
        <p className="mt-1 truncate text-sm text-muted-foreground">
          Examples: <span className="tabular">{samples.join(', ')}</span>
        </p>
      )}
      <FieldError message={errors.column} />

      <div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-display`}>Display name</Label>
          <Input
            id={`${id}-display`}
            value={draft.display_name}
            placeholder={column.name}
            maxLength={120}
            aria-invalid={errors.display_name ? true : undefined}
            aria-describedby={errors.display_name ? `${id}-display-error` : undefined}
            onChange={(event) => onChange({ display_name: event.target.value })}
          />
          <FieldError id={`${id}-display-error`} message={errors.display_name} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-semantic`}>Meaning</Label>
          <select
            id={`${id}-semantic`}
            className={selectClass}
            value={draft.semantic}
            aria-invalid={errors.semantic ? true : undefined}
            aria-describedby={`${id}-semantic-help`}
            onChange={(event) => onChange({ semantic: event.target.value as ColumnDraft['semantic'] })}
          >
            {SEMANTIC_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p id={`${id}-semantic-help`} className="text-sm text-muted-foreground">
            {semanticHelp(draft.semantic)}
            {willTurnPrivate && ' Saving turns Private on.'}
          </p>
          <FieldError message={errors.semantic} />
        </div>

        <div className="space-y-1.5">
          <span className="block text-sm font-medium" id={`${id}-pii-label`}>
            Private
          </span>
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <Switch
              checked={draft.is_pii}
              onCheckedChange={(checked) => onChange({ is_pii: checked })}
              aria-labelledby={`${id}-pii-label`}
              aria-describedby={`${id}-pii-hint`}
              className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <span id={`${id}-pii-hint`} className="text-sm">
              Hidden from the AI <span className="text-muted-foreground">({draft.is_pii ? 'on' : 'off'})</span>
            </span>
          </label>
          <FieldError message={errors.is_pii} />
        </div>

        {draft.semantic === 'currency_zar' && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-vat`}>VAT</Label>
            <select
              id={`${id}-vat`}
              className={selectClass}
              value={VAT_OPTIONS.find((o) => o.stored === draft.vat_included)?.value ?? 'unknown'}
              onChange={(event) =>
                onChange({ vat_included: VAT_OPTIONS.find((o) => o.value === event.target.value)?.stored ?? null })
              }
            >
              {VAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <FieldError message={errors.vat_included} />
          </div>
        )}
      </div>
    </li>
  );
}
