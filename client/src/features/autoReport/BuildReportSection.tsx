import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CircleAlert, FileText, Sparkles } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { AutoReportRun, DatasetDetail, PlanLimitDetails } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';
import { describeStartError } from './autoReportErrors';
import { BuildReportDialog } from './BuildReportDialog';
import { useAfterRun, useAutoReportRun, useStartAutoReport } from './queries';
import { runStore, useStoredRun, type StoredRun } from './runStore';

/** A report needs at least 3 suggested questions (Flow B2; the server answers 422 otherwise). */
export const MIN_SUGGESTIONS = 3;

export const SLOW_MESSAGE = 'This is taking longer than usual. You can leave this page; we will keep working.';

const count = (n: number, one: string, many: string) => `${formatNumber(n, 0)} ${n === 1 ? one : many}`;

/** "Build my report" on a ready dataset: the button, or the run's progress or result in its place. */
export function BuildReportSection({ dataset }: { dataset: DatasetDetail }) {
  const stored = useStoredRun(dataset.id);
  if (stored) return <RunPanel key={stored.run_id} dataset={dataset} stored={stored} />;
  if (dataset.status !== 'ready' || dataset.suggestions.length < MIN_SUGGESTIONS) return null;
  return <StartPanel dataset={dataset} />;
}

function StartPanel({ dataset }: { dataset: DatasetDetail }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const asked = dataset.suggestions.length;
  // The numbers come from Me; the server does the real check (402 opens the upgrade dialog).
  const quota = me.data
    ? `Uses up to ${formatNumber(asked, 0)} of your ${count(
        Math.max(0, me.data.limits.max_questions_per_month - me.data.usage.questions),
        'question',
        'questions',
      )} left this month and 1 report.`
    : null;

  return (
    <section aria-labelledby="build-report-heading" className="space-y-3 rounded-xl border bg-card p-5">
      <h2 id="build-report-heading" className="sr-only">
        Build my report
      </h2>
      <Button size="lg" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden />
        Build my report
      </Button>
      <p>Analyst answers the suggested questions from the Ask tab and puts them in a draft report. You can change anything afterwards.</p>
      {quota && <p className="text-sm text-muted-foreground tabular">{quota}</p>}
      <BuildReportDialog open={open} dataset={dataset} onClose={() => setOpen(false)} />
    </section>
  );
}

function RunPanel({ dataset, stored }: { dataset: DatasetDetail; stored: StoredRun }) {
  const run = useAutoReportRun(stored.run_id, stored.started_at);
  const navigate = useNavigate();
  const afterRun = useAfterRun(dataset.id);
  // Whether this page saw the run still running: then 'done' opens the report at once.
  const sawRunning = useRef(false);
  const status = run.data?.status;
  if (status === 'running') sawRunning.current = true;
  const gone = run.isError && isApiError(run.error) && run.error.code === 'not_found';

  useEffect(() => {
    if (status === 'done' || status === 'failed') afterRun();
    if (status === 'done' && sawRunning.current && run.data?.report_id) {
      runStore.clear(dataset.id);
      navigate(`/reports/${run.data.report_id}?draft=1`);
    }
    // afterRun is a new function each render; the status change is what matters.
  }, [status]);

  useEffect(() => {
    // The run no longer exists (another session, or it was cleaned up): offer the button again.
    if (gone) runStore.clear(dataset.id);
  }, [gone, dataset.id]);

  if (run.isPending) return <InlineLoading label="Checking your report" />;
  if (run.isError) {
    if (gone) return null;
    return (
      <div className="space-y-3">
        <FormMessage>{errorMessage(run.error)}</FormMessage>
        <Button variant="outline" onClick={() => void run.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const data = run.data;
  if (data.status === 'running') return <ProgressPanel run={data} slow={run.isSlow} />;
  if (data.status === 'failed') return <FailedPanel dataset={dataset} run={data} stored={stored} />;
  return <DonePanel dataset={dataset} run={data} />;
}

function ProgressPanel({ run, slow }: { run: AutoReportRun; slow: boolean }) {
  // Counting finished questions is fine; the figures themselves only ever come from the API.
  const current = Math.min(run.blocks_done + 1, run.blocks_total);
  const step =
    run.blocks_done >= run.blocks_total
      ? 'Putting your report together'
      : `Answering question ${formatNumber(current, 0)} of ${formatNumber(run.blocks_total, 0)}`;
  return (
    <section aria-labelledby="build-progress-heading" className="space-y-3 rounded-xl border bg-card p-5">
      <h2 id="build-progress-heading" className="text-lg font-semibold">
        Building your report
      </h2>
      <progress
        className="block h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
        value={run.blocks_done}
        max={Math.max(run.blocks_total, 1)}
        aria-labelledby="build-progress-heading"
      />
      <p aria-live="polite" className="tabular">
        {step}
      </p>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {slow ? SLOW_MESSAGE : 'Analyst is asking the suggested questions one by one. This usually takes under a minute.'}
      </p>
    </section>
  );
}

function FailedPanel({ dataset, run, stored }: { dataset: DatasetDetail; run: AutoReportRun; stored: StoredRun }) {
  const me = useMe();
  const start = useStartAutoReport(dataset.id);
  const [message, setMessage] = useState<string | null>(null);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | null>(null);

  const tryAgain = () => {
    setMessage(null);
    start.mutate(stored.request, {
      onError: (error) => {
        const view = describeStartError(error, dataset);
        if (view.kind === 'plan_limit') return setPlanLimit(view.details);
        // Someone already started it again (another tab): follow that run instead.
        if (view.kind === 'running') return runStore.follow(dataset.id, view.runId, stored.request);
        setMessage(view.kind === 'message' ? view.message : errorMessage(error));
      },
    });
  };

  return (
    <section role="alert" aria-labelledby="build-failed-heading" className="space-y-3 rounded-xl border border-destructive/40 bg-card p-5">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="space-y-2">
          <h2 id="build-failed-heading" className="text-lg font-semibold">
            We could not build your report
          </h2>
          {/* API text, rendered as text. */}
          <p>{run.error_message ?? 'Something stopped the report from being built.'}</p>
          <p className="text-sm text-muted-foreground">Any answers already made are kept in this file's history.</p>
        </div>
      </div>
      {message && <FormMessage>{message}</FormMessage>}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to={`/datasets/${dataset.id}/ask`}>Ask your own questions</Link>
        </Button>
        <Button onClick={tryAgain} disabled={start.isPending}>
          {start.isPending ? 'Starting…' : 'Try again'}
        </Button>
      </div>
      {me.data && <UpgradeDialog details={planLimit} plan={me.data.plan} onClose={() => setPlanLimit(null)} />}
    </section>
  );
}

/** Shown when the run had already finished before this visit: open it, or put the button back. */
function DonePanel({ dataset, run }: { dataset: DatasetDetail; run: AutoReportRun }) {
  return (
    <section aria-labelledby="build-done-heading" className="space-y-3 rounded-xl border border-primary/40 bg-card p-5">
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <h2 id="build-done-heading" className="text-lg font-semibold">
            Your draft report is ready
          </h2>
          <p>It is a draft: check it before you send it.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {run.report_id && (
          <Button asChild>
            <Link to={`/reports/${run.report_id}?draft=1`} onClick={() => runStore.clear(dataset.id)}>
              Open the draft report
            </Link>
          </Button>
        )}
        <Button variant="outline" onClick={() => runStore.clear(dataset.id)}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
