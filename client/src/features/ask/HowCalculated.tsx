import { useId, useState } from 'react';
import { ChevronDown, CircleAlert, CircleCheck, Copy, ShieldCheck } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { Block, BlockCheck, DatasetColumn, ValueFormat } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { formatCell, formatDate, formatNumber, formatValue } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSourceRows } from './queries';

/** What the answer card knows about the file behind it. */
export interface DatasetState {
  /** False when the dataset row is gone (Block.dataset_id is null). */
  exists: boolean;
  status: string | null;
  expires_at: string | null;
  columns: DatasetColumn[];
}

/**
 * The format for a reconcile check's expected and actual totals: the result's value format when every number
 * column shares one (for example all rand), otherwise plain en-ZA numbers.
 */
export function reconcileFormat(block: Pick<Block, 'chart' | 'columns'>): ValueFormat {
  const numeric = new Set(
    block.columns
      .map((c) => block.chart.value_format[c.name] ?? c.format)
      .filter((f) => f === 'zar' || f === 'number' || f === 'integer' || f === 'percent'),
  );
  return numeric.size === 1 ? ([...numeric][0] as ValueFormat) : 'number';
}

export function ChecksList({ block }: { block: Block }) {
  const format = reconcileFormat(block);
  return (
    <ul className="space-y-2" aria-label="Checks">
      {block.checks.map((check, i) => (
        <CheckItem key={`${check.type}-${i}`} check={check} format={format} />
      ))}
    </ul>
  );
}

function CheckItem({ check, format }: { check: BlockCheck; format: ValueFormat }) {
  const Icon = check.ok ? CircleCheck : CircleAlert;
  const hasTotals = check.type === 'total_reconciles' && (check.expected !== undefined || check.actual !== undefined);
  return (
    <li className={cn('flex items-start gap-2 rounded-lg border p-3', check.ok ? 'bg-card' : 'border-warning/50 bg-warning-bg')}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', check.ok ? 'text-primary' : 'text-warning')} aria-hidden />
      <div className="min-w-0 space-y-0.5 text-sm">
        <p>
          <span className="font-medium">{check.ok ? 'Passed' : 'Did not pass'}:</span> {check.label}
        </p>
        {check.detail && <p className="text-muted-foreground">{check.detail}</p>}
        {hasTotals && (
          <p className="tabular text-muted-foreground">
            Your file: {check.expected !== undefined ? formatValue(check.expected, format) : 'not given'} · This answer:{' '}
            {check.actual !== undefined ? formatValue(check.actual, format) : 'not given'}
          </p>
        )}
      </div>
    </li>
  );
}

export function SqlPanel({ sql }: { sql: string }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-sans text-sm font-semibold">The query</h4>
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          <Copy aria-hidden />
          Copy
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
        <code>{sql}</code>
      </pre>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {copied === 'done' ? 'Copied the query.' : copied === 'failed' ? 'Could not copy. Select the text and copy it instead.' : ''}
      </p>
    </div>
  );
}

export function sourceRowsUnavailable(block: Block, dataset: DatasetState): string | null {
  if (!block.dataset_id || !dataset.exists) return 'The original file was deleted, so the rows behind this answer can no longer be shown.';
  if (dataset.status === 'expired') {
    return dataset.expires_at
      ? `The original file was deleted on ${formatDate(dataset.expires_at)}, so the rows behind this answer can no longer be shown.`
      : 'The original file was deleted, so the rows behind this answer can no longer be shown.';
  }
  if (!block.has_source_rows) return 'This answer uses every row in your file, so there is no smaller set of rows to show.';
  return null;
}

export function SourceRowsPanel({ block, dataset }: { block: Block; dataset: DatasetState }) {
  const [open, setOpen] = useState(false);
  const unavailable = sourceRowsUnavailable(block, dataset);
  const query = useSourceRows(block.id, open && !unavailable);
  const pages = query.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const first = pages[0];
  const total = first?.total ?? 0;
  const types = new Map(dataset.columns.map((c) => [c.sql_name, c]));

  return (
    <div className="space-y-3">
      <h4 className="font-sans text-sm font-semibold">The rows behind this answer</h4>
      {unavailable ? (
        <p className="text-sm">{unavailable}</p>
      ) : !open ? (
        <Button variant="outline" onClick={() => setOpen(true)}>
          Show the rows this is based on
        </Button>
      ) : query.isPending ? (
        <InlineLoading label="Loading the rows" />
      ) : query.isError ? (
        <div className="space-y-2">
          <FormMessage>
            {isApiError(query.error) && query.error.code === 'dataset_expired'
              ? 'The original file was deleted, so the rows behind this answer can no longer be shown.'
              : errorMessage(query.error)}
          </FormMessage>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="flex items-start gap-1.5 text-sm">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            These are rows from your file. Only you can see this.
          </p>
          <p className="text-sm text-muted-foreground tabular">
            {rows.length === 0
              ? 'No rows matched.'
              : `Showing 1 to ${formatNumber(rows.length, 0)} of ${formatNumber(total, 0)}`}
          </p>
          {rows.length > 0 && first && (
            <div className="max-h-[22rem] overflow-auto rounded-lg border bg-card" tabIndex={0} role="region" aria-label="Rows from your file">
              <table className="w-full border-collapse text-sm tabular">
                <thead>
                  <tr>
                    {first.columns.map((c) => (
                      <th key={c.sql_name} scope="col" className="sticky top-0 z-10 border-b bg-secondary px-3 py-2 text-left font-medium whitespace-nowrap">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      {first.columns.map((c) => {
                        const column = types.get(c.sql_name);
                        return (
                          <td key={c.sql_name} className="px-3 py-2 whitespace-nowrap">
                            {formatCell(row[c.sql_name] ?? null, column?.data_type, { money: column?.semantic === 'currency_zar' })}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {query.hasNextPage && (
            <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The "How this was calculated" disclosure. */
export function HowCalculated({ block, dataset, defaultOpen }: { block: Block; dataset: DatasetState; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="rounded-lg border bg-background">
      <h3 className="font-sans text-base">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-4 py-2 text-left font-semibold focus-visible:ring-2 focus-visible:ring-ring"
        >
          How this was calculated
          <ChevronDown className={cn('size-4 shrink-0', open && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      {open && (
        <div id={id} className="space-y-5 border-t px-4 py-4">
          <p className="text-sm">
            Analyst wrote a query, ran it on your file, and the numbers below come from that result. The AI did not calculate
            them.
          </p>
          <SqlPanel sql={block.sql} />
          <div className="space-y-2">
            <h4 className="font-sans text-sm font-semibold">Checks</h4>
            <ChecksList block={block} />
          </div>
          <SourceRowsPanel block={block} dataset={dataset} />
        </div>
      )}
    </div>
  );
}
