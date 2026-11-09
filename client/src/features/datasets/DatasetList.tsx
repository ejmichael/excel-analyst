import { Link } from 'react-router';
import { ChevronRight, FileSpreadsheet } from 'lucide-react';
import type { Dataset } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { formatDate, formatNumber } from '@/lib/format';
import { StatusBadge } from './StatusBadge';

export function expirySentence(dataset: Pick<Dataset, 'status' | 'expires_at'>): string | null {
  if (!dataset.expires_at) return null;
  return dataset.status === 'expired'
    ? `The file was deleted on ${formatDate(dataset.expires_at)}.`
    : `We delete the file on ${formatDate(dataset.expires_at)}.`;
}

export function rowCountLabel(rows: number): string {
  return `${formatNumber(rows, 0)} ${rows === 1 ? 'row' : 'rows'}`;
}

interface DatasetListProps {
  status: 'pending' | 'error' | 'success';
  datasets: Dataset[];
  error?: string;
  onRetry?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

/** The datasets list in its four states: loading, error, empty and populated. */
export function DatasetList({ status, datasets, error, onRetry, hasMore, loadingMore, onLoadMore }: DatasetListProps) {
  if (status === 'pending') return <InlineLoading label="Loading your files" />;

  if (status === 'error') {
    return (
      <div className="space-y-3">
        <FormMessage>{error ?? 'We could not load your files.'}</FormMessage>
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  if (datasets.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-dashed bg-card p-6">
        <FileSpreadsheet className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <p className="font-medium">No files in this workspace yet</p>
          <p className="text-sm text-muted-foreground">
            Upload a CSV or Excel export, such as card machine sales, webstore orders or a bank statement, to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Your files">
        {datasets.map((d) => {
          const expiry = expirySentence(d);
          return (
            <li key={d.id}>
              <Link
                to={`/datasets/${d.id}`}
                className="flex min-h-11 items-start gap-3 p-4 hover:bg-secondary/60 focus-visible:bg-secondary/60"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{d.name}</span>
                    <StatusBadge status={d.status} />
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{d.original_filename}</p>
                  <p className="text-sm text-muted-foreground">
                    <span className="tabular">{d.row_count !== null ? `${rowCountLabel(d.row_count)} · ` : ''}</span>
                    Uploaded {formatDate(d.created_at)}
                  </p>
                  {expiry && <p className="text-sm text-muted-foreground">{expiry}</p>}
                </div>
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <Button variant="outline" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
