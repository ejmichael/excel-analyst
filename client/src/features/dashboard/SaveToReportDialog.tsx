import { useId, useMemo, useState, type ComponentType, type Ref, type RefObject } from 'react';
import { Link } from 'react-router';
import { AreaChart, BarChart3, FileOutput, Hash, LineChart, PieChart, Table2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChartType, Dashboard, DashboardFilterValue, DatasetDetail, ID, Report, SaveDashboardToReportRequest, WidgetResult } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage, TextField } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { describePlanLimit, describeUpgrade } from '@/components/planLimit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useReportsList } from '@/features/reports/queries';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { dashboardKeys, useSaveDashboardToReport } from './queries';
import {
  SHARED_REPORT_LINE,
  chartCount,
  defaultReportTitle,
  filtersNote,
  isWorking,
  readSaveFailure,
  submitBlocker,
  type SaveFailure,
} from './saveToReport';

const CHART_ICONS: Record<ChartType, ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  kpi: Hash,
  bar: BarChart3,
  line: LineChart,
  area: AreaChart,
  pie: PieChart,
  table: Table2,
};

const CHART_NAMES: Record<ChartType, string> = {
  kpi: 'Number',
  bar: 'Bar chart',
  line: 'Line chart',
  area: 'Area chart',
  pie: 'Pie chart',
  table: 'Table',
};

export interface SavedToReport {
  report: Report;
  created: boolean;
  count: number;
}

interface SaveToReportDialogProps {
  onClose: () => void;
  /** Where focus goes when the dialog closes: the button that opened it. */
  returnFocus: RefObject<HTMLButtonElement | null>;
  onSaved: (saved: SavedToReport) => void;
  dataset: DatasetDetail;
  dashboard: Dashboard;
  /** The results on screen, by widget id. */
  results: Map<ID, WidgetResult>;
  /** The filters the charts on screen were run with (never an unapplied change in the filters bar). */
  applied: DashboardFilterValue[];
  /** True when the filters bar holds a change the charts have not been run with yet. */
  unapplied: boolean;
}

/**
 * "Save to a report": the charts on screen, under the filters they were run with, become answers in a new report or
 * at the end of an existing one. Only widget ids and filters are sent; the server runs each chart again. Mounted only
 * while open, so every opening starts afresh: New report, the default title and every chart that works.
 */
export function SaveToReportDialog({ onClose, returnFocus, onSaved, dataset, dashboard, results, applied, unapplied }: SaveToReportDialogProps) {
  const id = useId();
  const me = useMe();
  const client = useQueryClient();
  const save = useSaveDashboardToReport(dataset.id);
  const reports = useReportsList(dataset.workspace_id);
  const reportList = useMemo(() => reports.data?.pages.flatMap((p) => p.items) ?? [], [reports.data]);
  const widgets = useMemo(() => [...dashboard.widgets].sort((a, b) => a.position - b.position), [dashboard.widgets]);

  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [title, setTitle] = useState(() => defaultReportTitle(dataset.name));
  const [reportId, setReportId] = useState<ID | null>(null);
  const [selected, setSelected] = useState<Set<ID>>(() => new Set(widgets.filter((w) => isWorking(results.get(w.id))).map((w) => w.id)));
  // Refused by the server during this dialog session: reports with an open share link, charts that could not run.
  const [sharedReports, setSharedReports] = useState<Set<ID>>(new Set());
  const [failedWidgets, setFailedWidgets] = useState<Set<ID>>(new Set());
  const [failure, setFailure] = useState<SaveFailure | null>(null);

  const canSave = (widgetId: ID) => isWorking(results.get(widgetId)) && !failedWidgets.has(widgetId);
  const savable = widgets.filter((w) => canSave(w.id));

  const noReports = reports.isSuccess && reportList.length === 0;
  const report = reportList.find((r) => r.id === reportId) ?? null;
  const ticked = widgets.filter((w) => selected.has(w.id) && canSave(w.id)).map((w) => w.id);
  const blocker = submitBlocker({ selected: ticked.length, target, title, report });

  const toggle = (widgetId: ID, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(widgetId);
      else next.delete(widgetId);
      return next;
    });

  const submit = () => {
    if (blocker || save.isPending) return;
    // In dashboard order, whatever order they were ticked in.
    const widgetIds = ticked;
    const body: SaveDashboardToReportRequest =
      target === 'new' ? { filters: applied, widget_ids: widgetIds, title: title.trim() } : { filters: applied, widget_ids: widgetIds, report_id: report!.id };
    setFailure(null);
    save.save(body, {
      onSuccess: ({ report: saved, created }) => onSaved({ report: saved, created, count: widgetIds.length }),
      onError: (error) => {
        const read = readSaveFailure(error, { sent: widgetIds, widgets, report });
        setFailure(read);
        if (read.kind === 'shared_report' && report) {
          setSharedReports((prev) => new Set(prev).add(report.id));
          setReportId(null);
          void reports.refetch();
        }
        if (read.kind === 'widgets') {
          setFailedWidgets((prev) => new Set([...prev, ...read.widgetIds]));
          setSelected((prev) => new Set([...prev].filter((w) => !read.widgetIds.includes(w))));
          void client.invalidateQueries({ queryKey: dashboardKeys.all(dataset.id) });
        }
      },
    });
  };

  const blockerId = `${id}-blocker`;
  const errorText = failure && failure.kind !== 'plan_limit' ? failure.text : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90dvh] max-w-[calc(100%-1rem)] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Save to a report</DialogTitle>
            <DialogDescription>
              The charts become answers in a report, where you can download them, print them or share them.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">Where to</legend>
            <RadioCard name={`${id}-target`} value="new" checked={target === 'new'} onChange={() => setTarget('new')} label="New report" />
            {target === 'new' && (
              <TextField
                label="Report title"
                value={title}
                required
                onChange={(e) => setTitle(e.target.value)}
                className="pl-8"
              />
            )}
            <RadioCard
              name={`${id}-target`}
              value="existing"
              checked={target === 'existing'}
              disabled={noReports}
              onChange={() => setTarget('existing')}
              label="Add to an existing report"
              note={noReports ? 'You have no reports for this file yet.' : undefined}
            />
            {target === 'existing' && (
              <div className="space-y-2 pl-8">
                {reports.isPending ? (
                  <InlineLoading label="Loading your reports" />
                ) : reports.isError ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <FormMessage>We could not load your reports.</FormMessage>
                    <Button type="button" variant="outline" onClick={() => void reports.refetch()}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <fieldset className="space-y-2">
                    <legend className="sr-only">Report to add to</legend>
                    {reportList.map((r) => (
                      <RadioCard
                        key={r.id}
                        name={`${id}-report`}
                        value={r.id}
                        checked={reportId === r.id}
                        disabled={sharedReports.has(r.id)}
                        onChange={() => setReportId(r.id)}
                        label={r.title}
                        detail={`Last edited ${formatDate(r.updated_at)}`}
                        note={sharedReports.has(r.id) ? SHARED_REPORT_LINE : undefined}
                      />
                    ))}
                    {reports.hasNextPage && (
                      <Button type="button" variant="outline" disabled={reports.isFetchingNextPage} onClick={() => void reports.fetchNextPage()}>
                        {reports.isFetchingNextPage ? 'Loading…' : 'Show more reports'}
                      </Button>
                    )}
                  </fieldset>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">What to save</legend>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <p className="mr-2 text-sm text-muted-foreground tabular" aria-live="polite" data-chart-counter>
                  {ticked.length} of {chartCount(widgets.length)}
                </p>
                <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setSelected(new Set(savable.map((w) => w.id)))}>
                  Select all
                </Button>
                <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
            <ul className="space-y-1 rounded-xl border p-2">
              {widgets.map((w) => {
                const usable = canSave(w.id);
                const Icon = CHART_ICONS[w.chart.type];
                const boxId = `${id}-w-${w.id}`;
                const noteId = `${boxId}-note`;
                return (
                  <li key={w.id} className={cn('flex min-h-11 items-center gap-3 rounded-lg px-2', !usable && 'opacity-70')}>
                    <Checkbox
                      id={boxId}
                      checked={usable && selected.has(w.id)}
                      disabled={!usable}
                      aria-describedby={usable ? undefined : noteId}
                      onCheckedChange={(v) => toggle(w.id, v === true)}
                    />
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <label htmlFor={boxId} className="min-w-0 flex-1 py-2 text-sm break-words">
                      {w.title}
                      <span className="sr-only">, {CHART_NAMES[w.chart.type]}</span>
                      {!usable && (
                        <span id={noteId} className="block text-muted-foreground">
                          This chart has an error.
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <div className="space-y-1 rounded-xl bg-secondary px-4 py-3 text-sm" data-filters-note>
            <p className="font-medium break-words">{filtersNote(applied, dashboard.filters)}</p>
            <p className="text-muted-foreground">The charts are re-run on the file now, so the report shows these exact filters.</p>
            {unapplied && <p className="text-muted-foreground">Unapplied changes in the filters bar are not included.</p>}
          </div>

          <div aria-live="polite" className="space-y-2">
            {errorText && (
              <div className="flex flex-wrap items-center gap-2" data-save-error>
                <FormMessage>{errorText}</FormMessage>
                {failure?.kind === 'other' && failure.canRetry && (
                  <Button type="button" variant="outline" onClick={submit} disabled={Boolean(blocker) || save.isPending}>
                    Retry
                  </Button>
                )}
              </div>
            )}
            {failure?.kind === 'plan_limit' && me.data && (
              <div className="space-y-1" data-save-error>
                <FormMessage>
                  {describePlanLimit(failure.details, me.data.plan)} {describeUpgrade(failure.details.upgrade_to)}
                </FormMessage>
                <Link to="/settings" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
                  See your plan in Settings
                </Link>
              </div>
            )}
          </div>

          <DialogFooter className="items-center">
            {blocker && (
              <p id={blockerId} className="text-sm text-muted-foreground sm:mr-auto">
                {blocker}
              </p>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={Boolean(blocker) || save.isPending} aria-describedby={blocker ? blockerId : undefined}>
              {save.isPending ? 'Saving…' : 'Save to report'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RadioCard({
  name,
  value,
  checked,
  disabled = false,
  onChange,
  label,
  detail,
  note,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
  detail?: string;
  note?: string;
}) {
  const inputId = `${name}-${value}`;
  const detailId = detail ? `${inputId}-detail` : undefined;
  const noteId = note ? `${inputId}-note` : undefined;
  return (
    // The whole card picks the option; the radio's name is its label only, the rest describes it.
    <div
      onClick={() => !disabled && !checked && onChange()}
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card px-3 py-2.5 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        disabled && 'cursor-not-allowed opacity-70',
      )}
    >
      <input
        id={inputId}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-describedby={[detailId, noteId].filter(Boolean).join(' ') || undefined}
        onChange={onChange}
        onClick={(event) => event.stopPropagation()}
        className="mt-1 size-4 shrink-0 accent-primary"
      />
      <div className="min-w-0 flex-1 text-sm">
        <label htmlFor={inputId} className={cn('block font-medium break-words', disabled ? 'cursor-not-allowed' : 'cursor-pointer')} onClick={(event) => event.stopPropagation()}>
          {label}
        </label>
        {detail && (
          <span id={detailId} className="block text-muted-foreground">
            {detail}
          </span>
        )}
        {note && (
          <span id={noteId} className="block text-muted-foreground">
            {note}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The "Save to a report" button. When it cannot be used, it is disabled and says why: in its tooltip (title) and to
 * screen readers (described by the same words).
 */
export function SaveToReportButton({
  disabledReason,
  onClick,
  ref,
}: {
  disabledReason: string | null;
  onClick?: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const reasonId = useId();
  return (
    <span className="inline-flex" title={disabledReason ?? undefined} data-save-to-report>
      <Button
        ref={ref}
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 bg-card"
        disabled={disabledReason !== null}
        aria-describedby={disabledReason ? reasonId : undefined}
        onClick={onClick}
      >
        <FileOutput aria-hidden />
        Save to a report
      </Button>
      {disabledReason && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </span>
  );
}
