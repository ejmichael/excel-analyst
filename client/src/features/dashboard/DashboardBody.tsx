import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@/api/client';
import type { Dashboard, DashboardFilterValue, DatasetDetail } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { Toast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { dashboardError } from './dashboardErrors';
import { FilterBar } from './FilterBar';
import { FILTERS_PARAM, hasBackwardsRange, parseFilters, sendable, serialiseFilters, toRequest, type FilterState } from './filters';
import { dashboardKeys, useDashboardData } from './queries';
import { SaveToReportButton, SaveToReportDialog, type SavedToReport } from './SaveToReportDialog';
import { isWorking, savedMessage } from './saveToReport';
import { Widget } from './Widget';

/** A filter change waits this long for the next one, so a burst of changes sends one request. */
export const FILTER_DEBOUNCE_MS = 300;

const sameFilters = (a: DashboardFilterValue[], b: DashboardFilterValue[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A ready dashboard: the filter bar (its state in ?filters=) and the widgets. Every settled filter change asks the
 * server to run the widgets again; the previous results stay, dimmed, until the answer for the current filters comes.
 * `header` draws the row above the filters, given the "Save to a report" button (which needs the results on screen).
 */
export function DashboardBody({
  dashboard,
  dataset,
  header,
}: {
  dashboard: Dashboard;
  dataset: DatasetDetail;
  header?: (saveButton: ReactNode) => ReactNode;
}) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get(FILTERS_PARAM);
  const state = useMemo(() => parseFilters(raw, dashboard.filters), [raw, dashboard.filters]);
  const backwards = hasBackwardsRange(state);
  const wanted = useMemo(() => toRequest(sendable(state), dashboard.filters), [state, dashboard.filters]);

  // The filters last sent: the URL's straight away on first load, then each change once it has settled (never while
  // From is later than To).
  const [settled, setSettled] = useState(wanted);
  const wantedKey = JSON.stringify(wanted);
  useEffect(() => {
    if (backwards || sameFilters(wanted, settled)) return;
    const timer = setTimeout(() => setSettled(wanted), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // wantedKey stands for `wanted` (a new array on every parse).
  }, [wantedKey, backwards]);

  const query = useDashboardData(dataset.id, dashboard, settled);
  const shown = query.data;
  const current = Boolean(shown && !query.isPlaceholderData && sameFilters(shown.filters, settled));
  const loading = !current || !sameFilters(settled, wanted);

  // The dashboard was replanned elsewhere (409 dashboard_not_ready): read it again.
  useEffect(() => {
    if (isApiError(query.error) && query.error.code === 'dashboard_not_ready') {
      void client.invalidateQueries({ queryKey: dashboardKeys.dashboard(dataset.id) });
    }
  }, [query.error, client, dataset.id]);

  const setState = (next: FilterState) => {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        const value = serialiseFilters(next, dashboard.filters);
        if (value) out.set(FILTERS_PARAM, value);
        else out.delete(FILTERS_PARAM);
        return out;
      },
      { replace: true },
    );
  };

  const results = new Map((shown?.data.widgets ?? []).map((r) => [r.widget_id, r]));
  const filtered = (shown?.filters.length ?? 0) > 0;
  const widgets = [...dashboard.widgets].sort((a, b) => a.position - b.position);
  const failure = query.isError && !query.isFetching ? dashboardError(query.error) : null;

  // Saving: the charts on screen, with the filters they were run with (not a change still waiting in the bar).
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState<SavedToReport | null>(null);
  const saveBlocked = !shown
    ? 'The charts are still loading.'
    : !widgets.some((w) => isWorking(results.get(w.id)))
      ? 'None of the charts can be saved right now: each one has an error.'
      : null;
  const unapplied = Boolean(shown) && (backwards || !sameFilters(wanted, shown!.filters));
  const saveTrigger = useRef<HTMLButtonElement>(null);
  const saveButton = <SaveToReportButton ref={saveTrigger} disabledReason={saveBlocked} onClick={() => setSaveOpen(true)} />;

  return (
    <div className="space-y-4">
      {header ? header(saveButton) : saveButton}
      <FilterBar filters={dashboard.filters} state={state} onChange={setState} data={shown?.data ?? null} />
      {failure && (
        <div className="flex flex-wrap items-center gap-3" data-data-error>
          <FormMessage>{failure.text}</FormMessage>
          {failure.canRetry && (
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          )}
        </div>
      )}
      <div
        className={cn('grid grid-cols-12 gap-4 transition-opacity', shown && loading && 'opacity-60')}
        aria-busy={loading}
        data-widget-grid
        data-current={current || undefined}
      >
        {widgets.map((widget) => (
          <Widget
            key={widget.id}
            widget={widget}
            // While a request is out with nothing to show yet, the cards wait; a response that never names this
            // widget is shown as could not be built.
            result={shown ? (results.get(widget.id) ?? missing(widget.id)) : undefined}
            filtered={filtered}
          />
        ))}
      </div>
      {shown && saveOpen && (
        <SaveToReportDialog
          onClose={() => setSaveOpen(false)}
          returnFocus={saveTrigger}
          onSaved={(result) => {
            setSaveOpen(false);
            setSaved(result);
          }}
          dataset={dataset}
          dashboard={dashboard}
          results={results}
          applied={shown.filters}
          unapplied={unapplied}
        />
      )}
      <Toast
        message={saved ? savedMessage({ title: saved.report.title, count: saved.count, created: saved.created }) : null}
        onDismiss={() => setSaved(null)}
        action={
          saved && (
            <Link
              to={`/reports/${saved.report.id}`}
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Open report
            </Link>
          )
        }
      />
    </div>
  );
}

function missing(widgetId: string) {
  return { widget_id: widgetId, columns: [], rows: [], total_rows: 0, truncated: false, checks: [], error: 'No result was returned for this widget.' };
}
