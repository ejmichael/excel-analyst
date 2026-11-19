import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown, Search, X } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { RowsQuery } from '@/api/datasets';
import type { DatasetDetail, DatasetPreview } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatNumber } from '@/lib/format';
import { ColumnsForm } from '../ColumnsForm';
import { ROWS_PAGE_SIZE, useDatasetRows, useUpdateDataset } from '../queries';
import { DataTable, nextSort, type SortState } from './DataTable';

export const SEARCH_DEBOUNCE_MS = 300;
export const MAX_SEARCH = 100;

const sameQuery = (a: RowsQuery, b: RowsQuery) =>
  a.offset === b.offset && a.limit === b.limit && a.sort === b.sort && a.dir === b.dir && a.q === b.q;

const rows = (n: number) => `${formatNumber(n, 0)} ${n === 1 ? 'row' : 'rows'}`;

/** "Showing 1 to 50 of 25 310 rows", or with a search "Showing 1 to 12 of 12 matching rows (25 310 in the file)". */
export function rowsCaption(query: RowsQuery, preview: DatasetPreview): string {
  const from = formatNumber(query.offset + 1, 0);
  const to = formatNumber(query.offset + preview.rows.length, 0);
  if (!query.q) return `Showing ${from} to ${to} of ${rows(preview.total_rows)}`;
  const matching = `${formatNumber(preview.matched_rows, 0)} matching ${preview.matched_rows === 1 ? 'row' : 'rows'}`;
  return `Showing ${from} to ${to} of ${matching} (${formatNumber(preview.total_rows, 0)} in the file)`;
}

function rowsError(error: unknown): string {
  if (isApiError(error) && error.code === 'dataset_not_ready') return 'This file is still being read. Try again in a moment.';
  if (isApiError(error) && error.code === 'dataset_expired') return 'This file has expired, so its rows can no longer be shown.';
  return errorMessage(error);
}

/** The Data tab: the file's rows (paged, sorted and searched by the server) and the Columns card. */
export function DataTab({ dataset }: { dataset: DatasetDetail }) {
  const id = useId();
  const [params, setParams] = useSearchParams();
  // "See the rows" on the Quality tab arrives with ?q=; it fills the box once and leaves the URL.
  const [search, setSearch] = useState(() => (params.get('q') ?? '').slice(0, MAX_SEARCH));
  const [q, setQ] = useState(() => search.trim());
  const [sort, setSort] = useState<SortState | null>(null);
  // The page belongs to one search and sort; a new search or sort starts again at row 1 without an extra request.
  const filterKey = `${q}\u0000${sort?.column ?? ''}\u0000${sort?.dir ?? ''}`;
  const [page, setPage] = useState({ filterKey, offset: 0 });
  const offset = page.filterKey === filterKey ? page.offset : 0;

  useEffect(() => {
    if (!params.has('q')) return;
    const next = new URLSearchParams(params);
    next.delete('q');
    setParams(next, { replace: true });
    // Once, on arrival.
  }, []);

  // Debounced: one request once typing pauses.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => setQ(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, q]);

  const query: RowsQuery = { limit: ROWS_PAGE_SIZE, offset, sort: sort?.column ?? null, dir: sort?.dir ?? 'asc', q };
  const result = useDatasetRows(dataset.id, query);
  // What is on screen is always a response with its own query; a response for another page, sort or search is
  // only ever shown as the previous page while the current one loads.
  const shown = result.data;
  const current = shown !== undefined && sameQuery(shown.query, query);
  const hasText = dataset.columns.some((c) => c.data_type === 'text');

  const clear = () => {
    setSearch('');
    setQ('');
  };
  const goTo = (to: number) => setPage({ filterKey, offset: to });

  return (
    <div className="space-y-6">
      <section aria-labelledby={`${id}-rows`} className="space-y-4 rounded-2xl border bg-card p-4 sm:p-5">
        <h2 id={`${id}-rows`} className="text-xl font-semibold">
          Rows
        </h2>

        {hasText && (
          <div className="space-y-1.5 sm:max-w-md">
            <Label htmlFor={`${id}-search`}>Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id={`${id}-search`}
                type="search"
                value={search}
                maxLength={MAX_SEARCH}
                aria-describedby={`${id}-search-hint`}
                onChange={(e) => setSearch(e.target.value)}
                className="h-11 pr-11 pl-9 [&::-webkit-search-cancel-button]:hidden"
              />
              {search && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Clear search"
                  onClick={clear}
                  className="absolute top-0 right-0 size-11"
                >
                  <X aria-hidden />
                </Button>
              )}
            </div>
            <p id={`${id}-search-hint`} className="text-sm text-muted-foreground">
              Searches text columns
            </p>
          </div>
        )}

        {result.isError && !result.isFetching ? (
          <div className="space-y-3">
            <FormMessage>{rowsError(result.error)}</FormMessage>
            <Button variant="outline" onClick={() => void result.refetch()}>
              Retry
            </Button>
          </div>
        ) : !shown ? (
          <RowsSkeleton />
        ) : current && shown.preview.matched_rows === 0 && q ? (
          <div className="space-y-3 rounded-xl border border-dashed p-5">
            <p className="font-medium">No rows match “{q}”.</p>
            <Button variant="outline" onClick={clear}>
              Clear search
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground tabular" aria-live="polite">
              {current ? rowsCaption(shown.query, shown.preview) : 'Loading the rows…'}
            </p>
            <DataTable
              preview={shown.preview}
              columns={dataset.columns}
              sort={sort}
              busy={!current}
              onSort={(column) => setSort((s) => nextSort(s, column))}
            />
            <nav aria-label="Pages of rows" className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" disabled={offset === 0} onClick={() => goTo(Math.max(0, offset - ROWS_PAGE_SIZE))}>
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={!current || offset + shown.preview.rows.length >= shown.preview.matched_rows}
                onClick={() => goTo(offset + ROWS_PAGE_SIZE)}
              >
                Next
              </Button>
            </nav>
          </div>
        )}
      </section>

      <ColumnsCard dataset={dataset} />
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" className="space-y-2" aria-label="Loading the rows">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-9 rounded-md bg-secondary motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

const wideScreen = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)').matches : true);

/** The column table and its editing; collapsed by default on phones. */
function ColumnsCard({ dataset }: { dataset: DatasetDetail }) {
  const id = useId();
  const update = useUpdateDataset(dataset.id);
  const [open, setOpen] = useState(wideScreen);
  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <ColumnsForm
        columns={dataset.columns}
        onSave={(columns) => update.mutateAsync({ columns })}
        collapsed={!open}
        bodyId={`${id}-columns`}
        headerAction={
          <Button variant="outline" aria-expanded={open} aria-controls={`${id}-columns`} onClick={() => setOpen((o) => !o)}>
            <ChevronDown className={open ? 'rotate-180' : undefined} aria-hidden />
            {open ? 'Hide columns' : 'Show columns'}
          </Button>
        }
      />
    </div>
  );
}
