import { useEffect, useId, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronUp, FileText, X } from 'lucide-react';
import { isApiError } from '@/api/client';
import { getBlock } from '@/api/blocks';
import type { ID } from '@/api/types';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CreateReportDialog } from './CreateReportDialog';
import { MAX_REPORT_BLOCKS, useReportTray } from './tray';

/**
 * The report tray: shown whenever the active workspace's tray holds an answer. A bar at the bottom on small
 * screens (open it to see the list) and a side panel on wide screens.
 */
export function ReportTray({ workspaceId }: { workspaceId: ID | undefined }) {
  const tray = useReportTray(workspaceId);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dropped, setDropped] = useState<string | null>(null);
  const listId = useId();

  // Answers that can no longer be fetched (deleted elsewhere) are dropped with a short message.
  const checks = useQueries({
    queries: tray.items.map((item) => ({
      queryKey: ['blocks', 'exists', item.block_id],
      queryFn: ({ signal }: { signal: AbortSignal }) => getBlock(item.block_id, signal),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const missing = tray.items.filter((_, i) => {
    const error = checks[i]?.error;
    return isApiError(error) && error.code === 'not_found';
  });
  const missingKey = missing.map((m) => m.block_id).join(',');
  useEffect(() => {
    if (missing.length === 0) return;
    tray.remove(missing.map((m) => m.block_id));
    setDropped(
      missing.length === 1
        ? `“${missing[0]!.title}” no longer exists, so it was taken out of your tray.`
        : `${formatNumber(missing.length, 0)} answers no longer exist, so they were taken out of your tray.`,
    );
    // Runs when the set of missing answers changes.
  }, [missingKey]);

  if (!workspaceId || (tray.items.length === 0 && !dropped)) return null;
  const count = tray.items.length;
  const countText = count === 1 ? '1 answer selected' : `${formatNumber(count, 0)} answers selected`;

  return (
    <aside
      aria-label="Report tray"
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t bg-card shadow-[0_-4px_16px_rgba(22,35,31,0.08)]',
        'lg:inset-x-auto lg:top-16 lg:right-0 lg:bottom-0 lg:flex lg:w-80 lg:flex-col lg:border-t-0 lg:border-l lg:shadow-none',
      )}
    >
      <div className="flex items-center gap-2 px-4 py-2 lg:border-b lg:py-3">
        <FileText className="size-5 shrink-0 text-primary" aria-hidden />
        <p className="flex-1 font-medium" aria-live="polite">
          {count === 0 ? 'Report tray' : countText}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={open ? 'Hide the answers in the tray' : 'Show the answers in the tray'}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronUp className={cn('size-5', open && 'rotate-180')} aria-hidden />
        </Button>
        <Button className="lg:hidden" disabled={count === 0} onClick={() => setCreating(true)}>
          Create report
        </Button>
      </div>

      {dropped && (
        <div className="flex items-start gap-2 px-4 pb-2 text-sm" role="status">
          <p className="flex-1">{dropped}</p>
          <button type="button" className="inline-flex min-h-11 items-center underline underline-offset-4" onClick={() => setDropped(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div id={listId} className={cn('max-h-[50dvh] overflow-y-auto border-t lg:block lg:max-h-none lg:flex-1 lg:border-t-0', open ? 'block' : 'hidden')}>
        <ol className="divide-y">
          {tray.items.map((item, i) => (
            <li key={item.block_id} className="flex items-center gap-1 px-3 py-1">
              <span className="w-6 shrink-0 text-sm text-muted-foreground tabular" aria-hidden>
                {formatNumber(i + 1, 0)}.
              </span>
              <span className="min-w-0 flex-1 text-sm break-words">{item.title}</span>
              <Button variant="ghost" size="icon" disabled={i === 0} aria-label={`Move “${item.title}” up`} onClick={() => tray.move(item.block_id, -1)}>
                <ArrowUp aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={i === count - 1}
                aria-label={`Move “${item.title}” down`}
                onClick={() => tray.move(item.block_id, 1)}
              >
                <ArrowDown aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" aria-label={`Remove “${item.title}” from the tray`} onClick={() => tray.remove(item.block_id)}>
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
        {count >= MAX_REPORT_BLOCKS && (
          <p className="px-4 py-2 text-sm text-muted-foreground">
            The tray is full: a report holds at most {formatNumber(MAX_REPORT_BLOCKS, 0)} answers.
          </p>
        )}
      </div>

      <div className="hidden border-t p-4 lg:block">
        <Button className="w-full" disabled={count === 0} onClick={() => setCreating(true)}>
          Create report
        </Button>
      </div>

      <CreateReportDialog
        open={creating}
        workspaceId={workspaceId}
        items={tray.items}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          setOpen(false);
          tray.clear();
        }}
        onDrop={(ids) => tray.remove(ids)}
      />
    </aside>
  );
}
