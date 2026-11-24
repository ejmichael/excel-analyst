import { Suspense, lazy, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { ArrowLeft, Archive, CircleAlert } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { DatasetDetail } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage } from '@/components/FormField';
import { PageContainer } from '@/components/PageContainer';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import { formatDate, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DatasetHeader } from './DatasetHeader';
import { ParseDialog } from './ParseDialog';
import { ProfilingState } from './ProfilingState';
import { useDatasetPolling, useDatasetQuality, useReparseDataset } from './queries';
import { DataTab } from './workspace/DataTab';
import { QualityTab } from './workspace/QualityTab';
import { ReadingBar } from './workspace/ReadingBar';
import { ReportsTab } from './workspace/ReportsTab';
import { TabBar, panelId, tabId } from './workspace/TabBar';
import { WarningsNotice } from './workspace/WarningsNotice';
import { defaultTabFor, tabPath, tabsFor, type WorkspaceTab } from './workspace/tabs';

// Loaded on demand: answers and the dashboard draw charts (Recharts), which are most of the bundle.
const AskTab = lazy(async () => ({ default: (await import('@/features/ask/AskTab')).AskTab }));
const DashboardTab = lazy(async () => ({ default: (await import('@/features/dashboard/DashboardTab')).DashboardTab }));

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
    <PageContainer variant="wide" className="space-y-4">
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
    </PageContainer>
  );
}

function DatasetView({ dataset, slow, tab }: { dataset: DatasetDetail; slow: boolean; tab: string | undefined }) {
  const location = useLocation();
  const [parseOpen, setParseOpen] = useState(false);
  const reparse = useReparseDataset(dataset.id);
  const tabs = tabsFor(dataset.status);
  const active = tabs.find((t) => t.key === tab)?.key;
  const fallback = defaultTabFor(dataset.status, { question: new URLSearchParams(location.search).has('q') });

  // No tab, or one this file does not have: open the default tab (older links with ?q= open Ask and still ask).
  if (fallback && !active) {
    return <Navigate to={{ pathname: tabPath(dataset.id, fallback), search: location.search }} replace />;
  }

  const openParse = () => setParseOpen(true);

  return (
    <>
      <DatasetHeader dataset={dataset} />
      {dataset.status === 'ready' && <ReadingBar dataset={dataset} onChange={openParse} />}
      {(dataset.status === 'ready' || dataset.status === 'failed') && dataset.warnings.length > 0 && (
        <WarningsNotice dataset={dataset} onCheckReading={openParse} />
      )}
      {(dataset.status === 'profiling' || dataset.status === 'uploading') && <ProfilingState slow={slow} />}
      {dataset.status === 'failed' && <FailedPanel dataset={dataset} onCheckReading={openParse} />}
      {dataset.status === 'expired' && (
        <div className="flex max-w-[80ch] items-start gap-3 rounded-2xl border bg-card p-6">
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
        <div className="space-y-5">
          <TabBar datasetId={dataset.id} tabs={tabs} active={active} badges={{ quality: <QualityBadge dataset={dataset} /> }} />
          <div role="tabpanel" id={panelId(active)} aria-labelledby={tabId(active)} tabIndex={-1} className={cn('outline-none', PANEL_WIDTH[active])}>
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

/** How wide each tab's content may grow on a wide screen: answers and reports read best capped; the table and the dashboard use it all. */
const PANEL_WIDTH: Record<WorkspaceTab, string> = {
  dashboard: '',
  data: '',
  quality: 'max-w-[1200px]',
  ask: 'max-w-[1100px]',
  reports: 'max-w-[1100px]',
};

function TabPanel({ tab, dataset }: { tab: WorkspaceTab; dataset: DatasetDetail }) {
  switch (tab) {
    case 'dashboard':
      return (
        <Suspense fallback={<InlineLoading label="Loading" />}>
          <DashboardTab dataset={dataset} />
        </Suspense>
      );
    case 'data':
      return <DataTab dataset={dataset} />;
    case 'quality':
      return <QualityTab dataset={dataset} />;
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

/** The score on the Quality tab once it has loaded; nothing while it loads or if it fails (the tab itself says why). */
function QualityBadge({ dataset }: { dataset: DatasetDetail }) {
  const quality = useDatasetQuality(dataset.id, dataset.status === 'ready');
  if (!quality.data) return null;
  return (
    <span className="rounded-full border bg-secondary px-2 py-0.5 text-xs font-medium text-foreground tabular" data-quality-badge>
      {formatNumber(quality.data.score, 0)}
      <span className="sr-only">, score out of 100</span>
    </span>
  );
}

function FailedPanel({ dataset, onCheckReading }: { dataset: DatasetDetail; onCheckReading: () => void }) {
  const me = useMe();
  const [showLimit, setShowLimit] = useState(false);
  // Flow A step 5: a plan-limit failure (max_rows) carries structured details, including the plan that allows it.
  const rowLimit = dataset.error_details;
  return (
    <div role="alert" className="max-w-[80ch] rounded-2xl border border-destructive/40 bg-card p-6">
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
