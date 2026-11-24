import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CircleAlert, Info } from 'lucide-react';
import { useMutationState, useQueryClient } from '@tanstack/react-query';
import type { Dashboard, DashboardWidgetWidth, DatasetDetail } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { tabPath } from '@/features/datasets/workspace/tabs';
import { DashboardBody } from './DashboardBody';
import { dashboardError } from './dashboardErrors';
import { widthClass } from './layout';
import { claimAutoPlan, planMutationKey, useDashboard, usePlanDashboard, usePlanningSlow } from './queries';

/**
 * The Dashboard tab. Opening it reads the dashboard; when there is none yet (404) it asks the server to plan one, once
 * per session for this file, then polls until it is ready or failed. Leaving the tab cancels nothing.
 */
export function DashboardTab({ dataset }: { dataset: DatasetDetail }) {
  const client = useQueryClient();
  const query = useDashboard(dataset.id);
  const plan = usePlanDashboard(dataset.id);
  // The latest planning request, also when it was sent before this tab was last opened.
  const planState = useMutationState({ filters: { mutationKey: planMutationKey(dataset.id) }, select: (m) => m.state }).at(-1);
  const none = query.data === null;
  const mutate = plan.mutate;

  useEffect(() => {
    if (none && claimAutoPlan(client, dataset.id)) mutate();
  }, [none, client, dataset.id, mutate]);

  const sending = planState?.status === 'pending';
  const planError = planState?.status === 'error' ? planState.error : null;
  const tryAgain = () => mutate();

  if (query.isPending) return <InlineLoading label="Loading the dashboard" />;

  if (query.isError) {
    const { text, canRetry } = dashboardError(query.error);
    return <ErrorCard text={text} onRetry={canRetry ? () => void query.refetch() : undefined} datasetId={dataset.id} />;
  }

  const dashboard = query.data;
  if (dashboard === null) {
    if (planError) {
      const { text, canRetry } = dashboardError(planError, { planning: true });
      return <ErrorCard text={text} onRetry={canRetry ? tryAgain : undefined} datasetId={dataset.id} />;
    }
    return <PlanningCard datasetId={dataset.id} />;
  }

  if (dashboard.status === 'planning') return <PlanningCard datasetId={dataset.id} />;

  if (dashboard.status === 'failed') {
    return (
      <FailedCard
        dashboard={dashboard}
        datasetId={dataset.id}
        onRetry={tryAgain}
        sending={sending}
        planError={planError ? dashboardError(planError, { planning: true }).text : null}
      />
    );
  }

  return (
    <ReadyDashboard
      dashboard={dashboard}
      dataset={dataset}
      onRebuild={tryAgain}
      sending={sending}
      planError={planError ? dashboardError(planError, { planning: true }).text : null}
    />
  );
}

/** The skeleton tiles under the planning card: a likely first dashboard's shape. */
const PLANNING_TILES: DashboardWidgetWidth[] = ['quarter', 'quarter', 'quarter', 'quarter', 'half', 'half', 'full'];

function PlanningCard({ datasetId }: { datasetId: string }) {
  const slow = usePlanningSlow(datasetId, true);
  return (
    <div className="space-y-4" data-dashboard-planning>
      <section role="status" className="rounded-2xl border bg-card p-6">
        <h2 className="text-lg font-semibold">Analyst is planning your dashboard</h2>
        <p className="mt-1 text-muted-foreground">This takes about a minute the first time.</p>
        {slow && <p className="mt-2">Taking longer than usual. You can keep using the other tabs.</p>}
      </section>
      <div className="grid grid-cols-12 gap-4" aria-hidden>
        {PLANNING_TILES.map((width, i) => (
          <div key={i} className={widthClass(width)}>
            <div className="space-y-3 rounded-2xl border bg-card p-5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className={width === 'quarter' ? 'h-10 w-2/3' : 'h-40 w-full'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AskLink({ datasetId }: { datasetId: string }) {
  return (
    <Link
      to={tabPath(datasetId, 'ask')}
      className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      Ask a question instead
    </Link>
  );
}

function ErrorCard({ text, onRetry, datasetId }: { text: string; onRetry?: () => void; datasetId: string }) {
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-6" data-dashboard-error>
      <FormMessage>{text}</FormMessage>
      <div className="flex flex-wrap items-center gap-3">
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
        <AskLink datasetId={datasetId} />
      </div>
    </div>
  );
}

function FailedCard({
  dashboard,
  datasetId,
  onRetry,
  sending,
  planError,
}: {
  dashboard: Dashboard;
  datasetId: string;
  onRetry: () => void;
  sending: boolean;
  planError: string | null;
}) {
  return (
    <div role="alert" className="rounded-2xl border border-destructive/40 bg-card p-6" data-dashboard-failed>
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Analyst could not build a dashboard for this file</h2>
          <p>{dashboard.error_message ?? 'Something stopped Analyst from planning it.'}</p>
          {planError && <FormMessage>{planError}</FormMessage>}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={onRetry} disabled={sending}>
              {sending ? 'Starting…' : 'Try again'}
            </Button>
            <AskLink datasetId={datasetId} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadyDashboard({
  dashboard,
  dataset,
  onRebuild,
  sending,
  planError,
}: {
  dashboard: Dashboard;
  dataset: DatasetDetail;
  onRebuild: () => void;
  sending: boolean;
  planError: string | null;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="space-y-4" data-dashboard-ready>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <p className="max-w-[80ch] text-muted-foreground" data-reading-note>
          <span className="font-medium text-foreground">Analyst read this file as:</span> {dashboard.reading.text}
        </p>
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className="inline-flex min-h-11 items-center rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Rebuild dashboard
        </button>
      </div>
      {planError && <FormMessage>{planError}</FormMessage>}

      {dashboard.fallback && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-secondary/60 px-4 py-3 text-sm" data-dashboard-fallback>
          <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-muted-foreground">This is a basic dashboard. Analyst could not plan a custom one for this file.</p>
          <Button variant="outline" size="sm" className="min-h-11 bg-card" onClick={onRebuild} disabled={sending}>
            {sending ? 'Starting…' : 'Try again'}
          </Button>
        </div>
      )}

      {/* A rebuilt dashboard starts afresh (its filters may differ). */}
      <DashboardBody key={`${dashboard.id}:${dashboard.created_at}`} dashboard={dashboard} dataset={dataset} />

      <Dialog open={confirm} onOpenChange={(open) => !open && setConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Rebuild the dashboard?</DialogTitle>
            <DialogDescription className="text-base text-foreground">
              Analyst will plan the dashboard again and replace this one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Keep this one
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                onRebuild();
              }}
            >
              Rebuild dashboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
