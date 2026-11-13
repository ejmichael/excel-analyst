import { Link } from 'react-router';
import { ChevronRight, FileText } from 'lucide-react';
import { errorMessage } from '@/api/client';
import type { Report } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { formatDate, formatNumber } from '@/lib/format';
import { PageHeader } from '@/features/shell/pages';
import { useActiveWorkspace } from '@/features/workspaces/WorkspaceProvider';
import { useReportsList } from './queries';

export const answersLabel = (n: number) => (n === 1 ? '1 answer' : `${formatNumber(n, 0)} answers`);

export function ReportsPage() {
  const { active } = useActiveWorkspace();
  const list = useReportsList(active?.id);
  const reports = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Reports" description={active ? `Workspace: ${active.name}` : undefined} />
      {!active || list.isPending ? (
        <InlineLoading label="Loading your reports" />
      ) : list.isError ? (
        <div className="space-y-3">
          <FormMessage>{errorMessage(list.error)}</FormMessage>
          <Button variant="outline" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : reports.length === 0 ? (
        <div className="flex items-start gap-3 rounded-xl border border-dashed bg-card p-6">
          <FileText className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">No reports in this workspace yet</p>
            <p className="text-sm">Ask a question, then choose Add to report.</p>
            <Link to="/datasets" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">
              Go to your files
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Your reports">
            {reports.map((r) => (
              <ReportRow key={r.id} report={r} />
            ))}
          </ul>
          {list.hasNextPage && (
            <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ReportRow({ report }: { report: Report }) {
  const second = report.subtitle || report.period_label;
  return (
    <li>
      <Link to={`/reports/${report.id}`} className="flex min-h-11 items-start gap-3 p-4 hover:bg-secondary/60 focus-visible:bg-secondary/60">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium break-words">{report.title}</p>
          {second && <p className="text-sm text-muted-foreground break-words">{second}</p>}
          <p className="text-sm text-muted-foreground tabular">
            {answersLabel(report.block_count)} · Created {formatDate(report.created_at)}
          </p>
        </div>
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}
