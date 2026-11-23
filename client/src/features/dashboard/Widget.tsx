import { useId, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import type { DashboardWidget, WidgetResult } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BlockChart } from '@/features/ask/BlockChart';
import { formatOf, groupKeyColumns } from '@/features/ask/chartData';
import { ChecksList, SqlPanel } from '@/features/ask/HowCalculated';
import { ResultTable } from '@/features/ask/ResultTable';
import { formatNumber, formatValue } from '@/lib/format';
import { cn } from '@/lib/utils';
import { widthClass } from './layout';

/** A table widget shows this many rows until "Show all". */
export const TABLE_ROWS = 10;

/** How a kpi with no value reads. */
export const NO_VALUE = '–';

interface WidgetProps {
  widget: DashboardWidget;
  /** Undefined while the first results load. */
  result: WidgetResult | undefined;
  /** True when the result was produced under at least one filter. */
  filtered: boolean;
}

/** One dashboard widget: a white card with its title, the value, chart or table, and "Show the working". */
export function Widget({ widget, result, filtered }: WidgetProps) {
  const headingId = useId();
  const failedCheck = result?.checks.some((c) => !c.ok) ?? false;
  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex min-w-0 flex-col gap-2.5 rounded-2xl border bg-card p-4', widthClass(widget.width))}
      data-widget={widget.id}
      data-width={widget.width}
    >
      <h3 id={headingId} className="font-sans text-sm font-semibold">
        {widget.title}
      </h3>
      <WidgetBody widget={widget} result={result} filtered={filtered} />
      {result && !result.error && result.truncated && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/50 bg-warning-bg px-3 py-2 text-sm tabular" data-truncated>
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          Showing the first {formatNumber(result.rows.length, 0)} of {formatNumber(result.total_rows, 0)} rows
        </p>
      )}
      {result && failedCheck && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/50 bg-warning-bg px-3 py-2 text-sm" data-check-warning>
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          A check did not pass. Open “Show the working” to see which.
        </p>
      )}
      {result && <Working widget={widget} result={result} />}
    </section>
  );
}

function WidgetBody({ widget, result, filtered }: WidgetProps) {
  if (!result) {
    return (
      <div role="status" className="space-y-2">
        <span className="sr-only">Loading</span>
        <Skeleton className={widget.chart.type === 'kpi' ? 'h-10 w-2/3' : 'h-40 w-full'} aria-hidden />
      </div>
    );
  }
  if (result.error) {
    return (
      <div className="space-y-1 text-sm" data-widget-error>
        <p>This could not be built for this selection.</p>
        {filtered && <p className="text-muted-foreground">Try changing the filters.</p>}
      </div>
    );
  }
  if (result.rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-4 text-sm" data-widget-empty>
        {filtered ? 'No rows match these filters.' : 'There are no rows to show.'}
      </p>
    );
  }
  const source = { chart: widget.chart, columns: result.columns };
  if (widget.chart.type === 'kpi') {
    const column = widget.chart.y[0] ?? result.columns[0]?.name ?? '';
    const value = result.rows[0]?.[column] ?? null;
    return (
      // Smaller on a phone, where two tiles share a row, so a rand amount stays on one line.
      <p className="font-heading text-xl font-semibold tabular break-words sm:text-2xl lg:text-3xl" data-kpi-value>
        {formatValue(value, formatOf(source, column)) || NO_VALUE}
      </p>
    );
  }
  if (widget.chart.type === 'table') return <TableWidget widget={widget} result={result} />;
  return <BlockChart block={{ title: widget.title, chart: widget.chart, columns: result.columns, rows: result.rows }} />;
}

function tableColumns(widget: DashboardWidget, result: WidgetResult) {
  const source = { chart: widget.chart, columns: result.columns };
  const keys = groupKeyColumns(source);
  return result.columns.map((c) => ({ name: c.name, format: formatOf(source, c.name), key: keys.has(c.name) }));
}

function TableWidget({ widget, result }: { widget: DashboardWidget; result: WidgetResult }) {
  const [all, setAll] = useState(false);
  const more = result.rows.length > TABLE_ROWS;
  return (
    <div className="space-y-2">
      <ResultTable columns={tableColumns(widget, result)} rows={all ? result.rows : result.rows.slice(0, TABLE_ROWS)} label={`Table: ${widget.title}`} />
      {more && (
        <Button variant="outline" size="sm" className="min-h-11" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${formatNumber(result.rows.length, 0)}`}
        </Button>
      )}
    </div>
  );
}

/** "Show the working": the query, its checks (a failed one is a visible warning) and the result rows. */
function Working({ widget, result }: { widget: DashboardWidget; result: WidgetResult }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // A headline tile: a small text button in its bottom corner; the working opens below the number while needed.
  if (widget.chart.type === 'kpi') {
    return (
      <div className="mt-auto">
        <div className="-mr-2 -mb-2 flex justify-end">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-working-toggle
          >
            {open ? 'Hide the working' : 'Show the working'}
            <ChevronDown className={cn('size-3.5 shrink-0', open && 'rotate-180')} aria-hidden />
          </button>
        </div>
        {open && <WorkingPanel id={id} widget={widget} result={result} className="mt-2 rounded-lg border bg-background" />}
      </div>
    );
  }
  return (
    <div className="mt-auto rounded-lg border bg-background">
      <h4 className="font-sans text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 py-1 text-left font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Show the working
          <ChevronDown className={cn('size-4 shrink-0', open && 'rotate-180')} aria-hidden />
        </button>
      </h4>
      {open && <WorkingPanel id={id} widget={widget} result={result} className="border-t" />}
    </div>
  );
}

function WorkingPanel({ id, widget, result, className }: { id: string; widget: DashboardWidget; result: WidgetResult; className: string }) {
  return (
    <div id={id} className={cn('space-y-3 px-3 py-2.5', className)} data-working>
      <p className="text-sm">Analyst wrote this query when it planned the dashboard; the server runs it on your file each time.</p>
      <SqlPanel sql={widget.sql} />
      {result.error && (
        <p className="text-sm">
          <span className="font-medium">What went wrong:</span> {result.error}
        </p>
      )}
      {result.checks.length > 0 && (
        <div className="space-y-2">
          <h5 className="font-sans text-sm font-semibold">Checks</h5>
          <ChecksList block={{ checks: result.checks, chart: widget.chart, columns: result.columns }} />
        </div>
      )}
      {!result.error && (
        <div className="space-y-2">
          <h5 className="font-sans text-sm font-semibold">The result</h5>
          {result.rows.length === 0 ? (
            <p className="text-sm">No rows.</p>
          ) : (
            <ResultTable columns={tableColumns(widget, result)} rows={result.rows} label={`Result rows: ${widget.title}`} />
          )}
        </div>
      )}
    </div>
  );
}
