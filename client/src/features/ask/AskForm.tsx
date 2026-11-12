import { useId, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import type { ChartType } from '@/api/types';
import { FieldError } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { selectClass } from '@/features/datasets/ColumnsForm';

export const MIN_QUESTION = 3;
export const MAX_QUESTION = 500;

export const CHART_HINTS: Array<{ value: '' | ChartType; label: string }> = [
  { value: '', label: 'Let Analyst choose' },
  { value: 'table', label: 'Table' },
  { value: 'bar', label: 'Bar chart' },
  { value: 'line', label: 'Line chart' },
  { value: 'area', label: 'Area chart' },
  { value: 'pie', label: 'Pie chart' },
  { value: 'kpi', label: 'One big number' },
];

export function questionError(question: string): string | null {
  const length = question.trim().length;
  if (length < MIN_QUESTION) return `Write at least ${MIN_QUESTION} characters.`;
  if (length > MAX_QUESTION) return `Keep it to ${formatNumber(MAX_QUESTION, 0)} characters or fewer.`;
  return null;
}

interface AskFormProps {
  question: string;
  hint: '' | ChartType;
  asking: boolean;
  error: string | null;
  disabledReason?: string | null;
  onQuestionChange: (value: string) => void;
  onHintChange: (value: '' | ChartType) => void;
  onSubmit: () => void;
}

/** The question box: 3 to 500 characters, Enter asks, Shift+Enter makes a new line. */
export function AskForm({ question, hint, asking, error, disabledReason, onQuestionChange, onHintChange, onSubmit }: AskFormProps) {
  const id = useId();
  const length = question.length;
  const disabled = asking || Boolean(disabledReason);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!disabled) onSubmit();
    }
  };

  return (
    <form
      noValidate
      className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-question`}>Your question</Label>
        <textarea
          id={`${id}-question`}
          value={question}
          rows={3}
          maxLength={MAX_QUESTION}
          disabled={disabled}
          placeholder="For example: Which store had the highest net sales?"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-count${error ? ` ${id}-error` : ''}`}
          onChange={(event) => onQuestionChange(event.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            'min-h-24 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-base outline-none md:text-sm',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 aria-invalid:border-destructive',
          )}
        />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <FieldError id={`${id}-error`} message={error ?? undefined} />
          <p id={`${id}-count`} className="ml-auto text-sm text-muted-foreground tabular" aria-live="polite">
            {formatNumber(length, 0)} of {formatNumber(MAX_QUESTION, 0)} characters
          </p>
        </div>
        <p className="text-sm text-muted-foreground">Press Enter to ask. Shift and Enter starts a new line.</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5 sm:w-56">
          <Label htmlFor={`${id}-hint`}>Show it as</Label>
          <select
            id={`${id}-hint`}
            className={selectClass}
            value={hint}
            disabled={disabled}
            onChange={(event) => onHintChange(event.target.value as '' | ChartType)}
          >
            {CHART_HINTS.map((o) => (
              <option key={o.value || 'auto'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={disabled} className="sm:ml-auto">
          <Send aria-hidden />
          {asking ? 'Asking…' : 'Ask'}
        </Button>
      </div>
      {disabledReason && <p className="text-sm">{disabledReason}</p>}
    </form>
  );
}
