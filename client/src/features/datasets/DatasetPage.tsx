import { Suspense, lazy, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { ArrowLeft, Archive, CircleAlert, TriangleAlert } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { DatasetDetail } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import { formatDate, formatNumber } from '@/lib/format';
import { DatasetHeader } from './DatasetHeader';
import { ParseDialog } from './ParseDialog';
import { ProfilingState } from './ProfilingState';
import { useDatasetPolling, useReparseDataset } from './queries';
import { DataTab } from './workspace/DataTab';
import { ReadingBar } from './workspace/ReadingBar';
import { ReportsTab } from './workspace/ReportsTab';
import { TabBar, panelId, tabId } from './workspace/TabBar';
import { defaultTabFor, tabPath, tabsFor, type WorkspaceTab } from './workspace/tabs';

// Loaded on demand: answers draw charts (Recharts), which are most of the bundle.
const AskTab = lazy(async () => ({ default: (await import('@/features/ask/AskTab')).AskTab }));

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

/** /datasets/:id and /datasets/:id/:tab: the file workspace. */
export function DatasetPage() {
  const { id = '', tab } = useParams();
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
        <DatasetView dataset={query.data} slow={query.isSlow} tab={tab} />
      )}
    </div>
  );
}

function DatasetView({ dataset, slow, tab }: { dataset: DatasetDetail; slow: boolean; tab: string | undefined }) {
  const location = useLocation();
  const [parseOpen, setParseOpen] = useState(false);
  const reparse = useReparseDataset(dataset.id);
  const tabs = tabsFor(dataset.status);
  const active = tabs.find((t) => t.key === tab)?.key;
  const fallback = defaultTabFor(dataset.status);

  // No tab, or one this file does not have: open the default tab (keeping ?q= from older links).
  if (fallback && !active) {
    return <Navigate to={{ pathname: tabPath(dataset.id, fallback), search: location.search }} replace />;
  }

  const openParse = () => setParseOpen(true);

  return (
    <>
      <DatasetHeader dataset={dataset} />
      {dataset.status === 'ready' && <ReadingBar dataset={dataset} onChange={openParse} />}
      {dataset.status === 'ready' && dataset.warnings.length > 0 && <Warnings dataset={dataset} onCheckReading={openParse} />}
      {(dataset.status === 'profiling' || dataset.status === 'uploading') && <ProfilingState slow={slow} />}
      {dataset.status === 'failed' && <FailedPanel dataset={dataset} onCheckReading={openParse} />}
      {dataset.status === 'expired' && (
        <div className="flex items-start gap-3 rounded-2xl border bg-card p-6">
          <Archive className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p>
            {dataset.expires_at
              ? `The original file was deleted on ${formatDate(dataset.expires_at)}.`
              : 'The original file was deleted.'}{' '}
            Anything you saved from it is kept.
          </p>
        </div>
      )}

      {active && (
        <div className="space-y-6">
          <TabBar datasetId={dataset.id} tabs={tabs} active={active} />
          <div role="tabpanel" id={panelId(active)} aria-labelledby={tabId(active)} tabIndex={-1} className="outline-none">
            <TabPanel tab={active} dataset={dataset} />
          </div>
        </div>
      )}

      <ParseDialog
        dataset={dataset}
        open={parseOpen}
        onClose={() => setParseOpen(false)}
        onSubmit={(options) => reparse.mutateAsync(options)}
      />
    </>
  );
}

function TabPanel({ tab, dataset }: { tab: WorkspaceTab; dataset: DatasetDetail }) {
  switch (tab) {
    case 'data':
      return <DataTab dataset={dataset} />;
    case 'ask':
      return (
        <Suspense fallback={<InlineLoading label="Loading" />}>
          <AskTab dataset={dataset} />
        </Suspense>
      );
    case 'reports':
      return <ReportsTab dataset={dataset} />;
  }
}

function Warnings({ dataset, onCheckReading }: { dataset: DatasetDetail; onCheckReading: () => void }) {
  return (
    <section aria-labelledby="warnings-heading" className="rounded-2xl border border-warning/40 bg-warning-bg p-5">
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
  );
}

function FailedPanel({ dataset, onCheckReading }: { dataset: DatasetDetail; onCheckReading: () => void }) {
  const me = useMe();
  const [showLimit, setShowLimit] = useState(false);
  // Flow A step 5: a plan-limit failure (max_rows) carries structured details, including the plan that allows it.
  const rowLimit = dataset.error_details;
  return (
    <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-6">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">We could not read this file</h2>
          <p>{dataset.error_message ?? 'Something in the file stopped us from reading it.'}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onCheckReading}>Check how we read your file</Button>
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
