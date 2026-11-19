import { Link } from 'react-router';
import { CircleCheck, Search } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { DatasetDetail, DatasetQuality, QualityBand, QualityIssue, QualityPartKey, QualitySeverity } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';
import { useDatasetQuality } from '../queries';
import { MAX_SEARCH } from './DataTab';
import { tabPath } from './tabs';

/** The three status colours of the Quality tab (the only colours it adds); the band is always said in words too. */
export const STATUS_COLOURS = { green: '#1E7A5F', amber: '#B27A00', red: '#B4472B' } as const;

export const BANDS: Record<QualityBand, { label: string; colour: string }> = {
  very_clean: { label: 'Very clean', colour: STATUS_COLOURS.green },
  good: { label: 'Good, with a few things to tidy', colour: STATUS_COLOURS.green },
  needs_attention: { label: 'Needs attention', colour: STATUS_COLOURS.amber },
  needs_cleaning: { label: 'Needs cleaning first', colour: STATUS_COLOURS.red },
};

export const PART_LABELS: Record<QualityPartKey, string> = {
  missing: 'Missing values',
  duplicates: 'Duplicate rows',
  types: 'Wrong types',
  odd_values: 'Odd values',
  consistency: 'Inconsistent writing',
};

const SEVERITIES: Record<QualitySeverity, { label: string; colour: string }> = {
  high: { label: 'High', colour: STATUS_COLOURS.red },
  medium: { label: 'Medium', colour: STATUS_COLOURS.amber },
  low: { label: 'Low', colour: '#56625C' },
};

const count = (n: number, one: string, many: string) => `${formatNumber(n, 0)} ${n === 1 ? one : many}`;

function qualityError(error: unknown): string {
  if (isApiError(error) && error.code === 'dataset_not_ready') return 'This file is still being read. Try again in a moment.';
  if (isApiError(error) && error.code === 'dataset_expired') return 'This file has expired, so it can no longer be checked.';
  return errorMessage(error);
}

/**
 * The Quality tab: the server's score, its five parts and the issues it found, as the server sends them. Nothing here
 * changes the file, and the client works out no score or count of its own.
 */
export function QualityTab({ dataset }: { dataset: DatasetDetail }) {
  const quality = useDatasetQuality(dataset.id, true);

  if (quality.isPending) {
    return (
      <div role="status" className="space-y-2 rounded-2xl border bg-card p-6">
        <p className="font-medium">Checking your file</p>
        <p className="text-muted-foreground">
          We look for empty cells, repeated rows and values that do not fit. The first check can take a few seconds; the
          other tabs work in the meantime.
        </p>
      </div>
    );
  }

  if (quality.isError) {
    return (
      <div className="space-y-3 rounded-2xl border bg-card p-6">
        <FormMessage>{qualityError(quality.error)}</FormMessage>
        <Button variant="outline" onClick={() => void quality.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const q = quality.data;
  return (
    <div className="space-y-6">
      <ScoreCard quality={q} dataset={dataset} />
      <Parts quality={q} />
      <Issues quality={q} dataset={dataset} />
    </div>
  );
}

function ScoreCard({ quality, dataset }: { quality: DatasetQuality; dataset: DatasetDetail }) {
  const band = BANDS[quality.band];
  const issues = quality.issues.length;
  const sampled = dataset.row_count !== null && quality.rows_checked < dataset.row_count;
  return (
    <section aria-labelledby="quality-heading" className="flex flex-col gap-5 rounded-2xl border bg-card p-5 sm:flex-row sm:items-center">
      <ScoreRing score={quality.score} colour={band.colour} />
      <div className="space-y-1.5">
        <h2 id="quality-heading" className="text-xl font-semibold">
          {band.label}
        </h2>
        <p>{issues === 0 ? 'No issues found.' : `${count(issues, 'issue', 'issues')} found.`}</p>
        {issues > 0 && <p className="text-sm text-muted-foreground">Fixes arrive in a later update.</p>}
        {sampled && (
          <p className="text-sm text-muted-foreground tabular">
            We checked the first {count(quality.rows_checked, 'row', 'rows')} of {formatNumber(dataset.row_count ?? 0, 0)}.
          </p>
        )}
      </div>
    </section>
  );
}

/** The score as a ring: the arc is the server's score out of 100 (the circle's length is set to 100). */
export function ScoreRing({ score, colour }: { score: number; colour: string }) {
  return (
    <div className="relative size-32 shrink-0" data-score-ring style={{ color: colour }}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border)" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${score} 100`}
        />
      </svg>
      <p className="absolute inset-0 flex flex-col items-center justify-center text-foreground">
        <span className="font-heading text-3xl font-semibold tabular">{formatNumber(score, 0)}</span>
        <span className="text-sm text-muted-foreground">out of 100</span>
      </p>
    </div>
  );
}

function Parts({ quality }: { quality: DatasetQuality }) {
  return (
    <section aria-labelledby="parts-heading" className="space-y-4 rounded-2xl border bg-card p-5">
      <h2 id="parts-heading" className="text-lg font-semibold">
        What the score is made of
      </h2>
      <ul className="space-y-4">
        {quality.parts.map((part) => (
          <li key={part.key} data-part={part.key} className="grid gap-1.5 sm:grid-cols-[12rem_1fr_3rem] sm:items-center sm:gap-4">
            <div>
              <p className="font-medium">{PART_LABELS[part.key]}</p>
              <p className="text-sm text-muted-foreground">{part.note}</p>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden>
              <div className="h-full rounded-full bg-primary" style={{ width: `${part.score}%` }} />
            </div>
            <p className="text-sm tabular sm:text-right">
              {formatNumber(part.score, 0)}
              <span className="sr-only"> out of 100</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Issues({ quality, dataset }: { quality: DatasetQuality; dataset: DatasetDetail }) {
  if (quality.issues.length === 0) {
    return (
      <section aria-labelledby="issues-heading" className="flex items-start gap-3 rounded-2xl border bg-card p-5">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <h2 id="issues-heading" className="text-lg font-semibold">
            No issues found
          </h2>
          <p className="text-muted-foreground">Every check passed. Your file is ready for questions.</p>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby="issues-heading" className="space-y-3">
      <h2 id="issues-heading" className="text-lg font-semibold">
        Issues
      </h2>
      <ul className="space-y-3">
        {quality.issues.map((issue) => (
          <IssueRow key={issue.id} issue={issue} quality={quality} dataset={dataset} />
        ))}
      </ul>
    </section>
  );
}

/**
 * "See the rows" can only work when the Data tab's search can find them: the issue names a text column and has an
 * example (none for private columns) short enough to search for.
 */
export function seeRowsSearch(issue: QualityIssue, dataset: DatasetDetail): string | null {
  const column = dataset.columns.find((c) => c.sql_name === issue.column);
  const example = issue.examples[0]?.trim();
  if (!column || column.data_type !== 'text' || !example || example.length > MAX_SEARCH) return null;
  return example;
}

function IssueRow({ issue, quality, dataset }: { issue: QualityIssue; quality: DatasetQuality; dataset: DatasetDetail }) {
  const severity = SEVERITIES[issue.severity];
  const column = dataset.columns.find((c) => c.sql_name === issue.column);
  const search = seeRowsSearch(issue, dataset);
  const sampled = dataset.row_count !== null && quality.rows_checked < dataset.row_count;
  return (
    <li className="space-y-2 rounded-2xl border bg-card p-4 sm:p-5" data-issue={issue.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium"
          style={{ color: severity.colour, borderColor: severity.colour }}
        >
          {severity.label}
        </span>
        <h3 className="font-sans text-base font-semibold">{issue.title}</h3>
      </div>
      <p>{issue.detail}</p>
      <p className="text-sm text-muted-foreground tabular">
        {column && <>Column: {column.display_name ?? column.name} · </>}
        {formatNumber(issue.affected_rows, 0)} of {sampled ? 'the first ' : ''}
        {count(quality.rows_checked, 'row', 'rows')}
        {sampled ? ' checked' : ''}
      </p>
      {issue.examples.length > 0 && (
        <p className="text-sm">
          <span className="text-muted-foreground">For example: </span>
          {issue.examples.slice(0, 3).map((e, i) => (
            <span key={i}>
              {i > 0 && ', '}“{e}”
            </span>
          ))}
        </p>
      )}
      {search && (
        <Link
          to={`${tabPath(dataset.id, 'data')}?q=${encodeURIComponent(search)}`}
          className="inline-flex min-h-11 items-center gap-1.5 font-medium text-primary underline underline-offset-4"
        >
          <Search className="size-4" aria-hidden />
          See the rows<span className="sr-only">: {issue.title}</span>
        </Link>
      )}
    </li>
  );
}
