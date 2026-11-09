import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Archive, CircleAlert, MessageSquareText, TriangleAlert } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { DatasetDetail } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog, type LocalPlanLimit } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import { formatDate, formatNumber } from '@/lib/format';
import { ColumnsForm } from './ColumnsForm';
import { DatasetHeader } from './DatasetHeader';
import { ParseDialog } from './ParseDialog';
import { PreviewTable } from './PreviewTable';
import { ProfilingState } from './ProfilingState';
import { useDatasetPolling, useDatasetPreview, useReparseDataset, useUpdateDataset } from './queries';

/** Flow A step 5: a row-limit failure ends as `failed` with "Your plan allows N rows; this file has M." */
export function rowLimitFrom(message: string | null): LocalPlanLimit | null {
  const match = message && /plan allows ([\d\s,.  ]+) rows?; this file has ([\d\s,.  ]+)/i.exec(message);
  if (!match) return null;
  const digits = (s: string | undefined) => Number((s ?? '').replace(/\D/g, ''));
  return { limit_key: 'max_rows', limit: digits(match[1]), used: digits(match[2]) };
}

function BackLink() {
  return (
    <Link
      to="/datasets"
      className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden />
      All files
    </Link>
  );
}

export function DatasetPage() {
  const { id = '' } = useParams();
  const query = useDatasetPolling(id);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <BackLink />
      {query.isPending ? (
        <InlineLoading label="Loading the file" />
      ) : query.isError ? (
        <div className="space-y-3">
          <FormMessage>
            {isApiError(query.error) && query.error.code === 'not_found'
              ? 'We could not find this file. It may have been deleted.'
              : errorMessage(query.error)}
          </FormMessage>
          {!(isApiError(query.error) && query.error.code === 'not_found') && (
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          )}
        </div>
      ) : (
        <DatasetView dataset={query.data} slow={query.isSlow} />
      )}
    </div>
  );
}

function DatasetView({ dataset, slow }: { dataset: DatasetDetail; slow: boolean }) {
  const [parseOpen, setParseOpen] = useState(false);
  const reparse = useReparseDataset(dataset.id);
  const parseDialog = (
    <ParseDialog
      dataset={dataset}
      open={parseOpen}
      onClose={() => setParseOpen(false)}
      onSubmit={(options) => reparse.mutateAsync(options)}
    />
  );

  return (
    <>
      <DatasetHeader dataset={dataset} />
      {(dataset.status === 'profiling' || dataset.status === 'uploading') && <ProfilingState slow={slow} />}
      {dataset.status === 'failed' && <FailedPanel dataset={dataset} onTryOptions={() => setParseOpen(true)} />}
      {dataset.status === 'expired' && (
        <div className="flex items-start gap-3 rounded-xl border bg-card p-6">
          <Archive className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p>
            {dataset.expires_at
              ? `The original file was deleted on ${formatDate(dataset.expires_at)}.`
              : 'The original file was deleted.'}{' '}
            Anything you saved from it is kept.
          </p>
        </div>
      )}
      {dataset.status === 'ready' && <ReadyView dataset={dataset} onCheckReading={() => setParseOpen(true)} />}
      {parseDialog}
    </>
  );
}

function FailedPanel({ dataset, onTryOptions }: { dataset: DatasetDetail; onTryOptions: () => void }) {
  const me = useMe();
  const [showLimit, setShowLimit] = useState(false);
  const rowLimit = rowLimitFrom(dataset.error_message);
  return (
    <div role="alert" className="rounded-xl border border-destructive/40 bg-card p-6">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">We could not read this file</h2>
          <p>{dataset.error_message ?? 'Something in the file stopped us from reading it.'}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onTryOptions}>Try other options</Button>
            {rowLimit && (
              <Button variant="outline" onClick={() => setShowLimit(true)}>
                About this limit
              </Button>
            )}
          </div>
        </div>
      </div>
      {me.data && (
        <UpgradeDialog details={showLimit ? rowLimit : null} plan={me.data.plan} onClose={() => setShowLimit(false)} />
      )}
    </div>
  );
}

function ReadyView({ dataset, onCheckReading }: { dataset: DatasetDetail; onCheckReading: () => void }) {
  const update = useUpdateDataset(dataset.id);
  const preview = useDatasetPreview(dataset.id, true);
  const suggestions = dataset.suggestions.slice(0, 5);

  return (
    <div className="space-y-8">
      {dataset.warnings.length > 0 && (
        <section
          aria-labelledby="warnings-heading"
          className="rounded-xl border border-warning/40 bg-warning-bg p-5"
        >
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
            <div className="space-y-3">
              <h2 id="warnings-heading" className="text-lg font-semibold">
                Please check: {dataset.warnings.length === 1 ? 'one thing' : `${formatNumber(dataset.warnings.length, 0)} things`} we were not sure about
              </h2>
              <ul className="list-disc space-y-1 pl-5">
                {dataset.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <Button variant="outline" className="bg-card" onClick={onCheckReading}>
                Check how we read your file
              </Button>
            </div>
          </div>
        </section>
      )}

      {suggestions.length > 0 && (
        <section aria-labelledby="suggestions-heading" className="space-y-3">
          <h2 id="suggestions-heading" className="text-xl font-semibold">
            Questions you could ask
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {suggestions.map((s) => (
              <li key={s.question}>
                <Link
                  to={`/datasets/${dataset.id}/ask?q=${encodeURIComponent(s.question)}`}
                  className="flex h-full min-h-11 items-start gap-3 rounded-xl border bg-card p-4 hover:border-primary/50 hover:bg-accent/40"
                >
                  <MessageSquareText className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                  <span className="space-y-1">
                    <span className="block font-medium">{s.question}</span>
                    <span className="block text-sm text-muted-foreground">{s.why}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ColumnsForm
        columns={dataset.columns}
        onSave={(columns) => update.mutateAsync({ columns })}
      />

      <section aria-labelledby="preview-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="preview-heading" className="text-xl font-semibold">
            Preview
          </h2>
          {dataset.warnings.length === 0 && (
            <Button variant="link" className="px-0" onClick={onCheckReading}>
              Check how we read your file
            </Button>
          )}
        </div>
        {preview.isPending ? (
          <InlineLoading label="Loading the preview" />
        ) : preview.isError ? (
          <div className="space-y-3">
            <FormMessage>{errorMessage(preview.error)}</FormMessage>
            <Button variant="outline" onClick={() => void preview.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <PreviewTable preview={preview.data} />
        )}
      </section>
    </div>
  );
}
