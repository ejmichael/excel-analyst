import { useEffect, useId, useMemo, useState } from 'react';
import { errorMessage, isApiError } from '@/api/client';
import type { DatasetDetail, ReparseRequest } from '@/api/types';
import { FieldError, FormMessage } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { selectClass } from './ColumnsForm';
import { DATE_ORDER_LABELS, DECIMAL_LABELS, DELIMITER_LABELS, describeParseOptions } from './labels';
import { changedOptions, fieldsFor, formValuesFrom, headerRowError, type ParseFormValues } from './parseOptions';

interface ParseDialogProps {
  dataset: DatasetDetail;
  open: boolean;
  onClose: () => void;
  onSubmit: (options: ReparseRequest) => Promise<unknown>;
}

/** "Check how we read your file": what was detected, and the options to read it again differently. */
export function ParseDialog({ dataset, open, onClose, onSubmit }: ParseDialogProps) {
  const id = useId();
  const initial = useMemo(() => formValuesFrom(dataset.parse_options), [dataset.parse_options]);
  const [values, setValues] = useState<ParseFormValues>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setValues(initial);
      setError(null);
      setFieldErrors({});
    }
  }, [open, initial]);

  const fields = fieldsFor(dataset.file_type);
  const changes = changedOptions(dataset.file_type, initial, values);
  const headerError = headerRowError(values.header_row) ?? fieldErrors.header_row;
  const canSubmit = Object.keys(changes).length > 0 && !headerRowError(values.header_row) && !submitting;
  const set = (field: keyof ParseFormValues) => (event: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [field]: event.target.value }));

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await onSubmit(changes);
      onClose();
    } catch (e) {
      const byField = isApiError(e) ? e.fieldErrors : {};
      setFieldErrors(byField);
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const detected = describeParseOptions(dataset.parse_options, dataset.file_type);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Check how we read your file</DialogTitle>
            <DialogDescription>Change anything we got wrong and we will read the file again.</DialogDescription>
          </DialogHeader>

          {detected.length > 0 && (
            <div className="space-y-1 rounded-lg border bg-background p-3 text-sm">
              <p className="font-medium">What we found</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {detected.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {dataset.preamble_lines.length > 0 && (
            <div className="space-y-1 text-sm">
              <p className="font-medium">These lines above your table were skipped</p>
              <ol className="space-y-0.5 rounded-lg border bg-background p-3 font-mono text-xs">
                {dataset.preamble_lines.map((line, i) => (
                  <li key={i} className="break-all">
                    {line === '' ? <span className="text-muted-foreground">(empty line)</span> : line}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {fields.includes('sheet_name') && (
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-sheet`}>Sheet</Label>
                <select id={`${id}-sheet`} className={selectClass} value={values.sheet_name} onChange={set('sheet_name')}>
                  {initial.sheet_name === '' && <option value="">As detected</option>}
                  {dataset.sheet_names.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={`${id}-header`}>Row with the column names</Label>
              <Input
                id={`${id}-header`}
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                value={values.header_row}
                placeholder="As detected"
                aria-invalid={headerError ? true : undefined}
                aria-describedby={`${id}-header-hint${headerError ? ` ${id}-header-error` : ''}`}
                onChange={set('header_row')}
              />
              <p id={`${id}-header-hint`} className="text-sm text-muted-foreground">
                Row 1 is the first line of the file.
              </p>
              <FieldError id={`${id}-header-error`} message={headerError ?? undefined} />
            </div>

            {fields.includes('delimiter') && (
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-delimiter`}>Columns are separated by</Label>
                <select id={`${id}-delimiter`} className={selectClass} value={values.delimiter} onChange={set('delimiter')}>
                  {initial.delimiter === '' && <option value="">As detected</option>}
                  {Object.entries(DELIMITER_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <FieldError message={fieldErrors.delimiter} />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={`${id}-decimal`}>Decimal separator</Label>
              <select
                id={`${id}-decimal`}
                className={selectClass}
                value={values.decimal_separator}
                onChange={set('decimal_separator')}
              >
                {initial.decimal_separator === '' && <option value="">As detected</option>}
                {Object.entries(DECIMAL_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors.decimal_separator} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${id}-dates`}>Date order</Label>
              <select id={`${id}-dates`} className={selectClass} value={values.date_format} onChange={set('date_format')}>
                {initial.date_format === '' && <option value="">As detected</option>}
                {Object.entries(DATE_ORDER_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors.date_format} />
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Names, meanings and Private settings you changed are kept for every column that still exists after the file
            is read again. Suggested questions are made fresh.
          </p>

          {error && <FormMessage>{error}</FormMessage>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? 'Starting…' : 'Read the file again'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
