import { useId, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { errorMessage } from '@/api/client';
import type { Block } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AnswerCard } from './AnswerCard';
import type { DatasetState } from './HowCalculated';
import { useAnswerHistory } from './queries';

interface AnswerHistoryProps {
  datasetId: string;
  dataset: DatasetState;
  /** The newest answer is shown above the history, so it is left out here. */
  excludeId?: string | null;
  asking: boolean;
  onFollowUp: (question: string) => void;
}

export function AnswerHistory({ datasetId, dataset, excludeId, asking, onFollowUp }: AnswerHistoryProps) {
  const history = useAnswerHistory(datasetId);
  const blocks = (history.data?.pages.flatMap((p) => p.items) ?? []).filter((b) => b.id !== excludeId);

  return (
    <section aria-labelledby="history-heading" className="space-y-3">
      <h2 id="history-heading" className="text-xl font-semibold">
        Earlier answers
      </h2>
      {history.isPending ? (
        <InlineLoading label="Loading your earlier answers" />
      ) : history.isError ? (
        <div className="space-y-2">
          <FormMessage>{errorMessage(history.error)}</FormMessage>
          <Button variant="outline" onClick={() => void history.refetch()}>
            Try again
          </Button>
        </div>
      ) : blocks.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card p-4 text-sm">
          {excludeId ? 'Your earlier answers will appear here.' : 'No answers yet. Ask your first question above.'}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {blocks.map((block) => (
              <HistoryItem key={block.id} block={block} dataset={dataset} asking={asking} onFollowUp={onFollowUp} />
            ))}
          </ul>
          {history.hasNextPage && (
            <Button variant="outline" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
              {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function HistoryItem({ block, dataset, asking, onFollowUp }: { block: Block; dataset: DatasetState; asking: boolean; onFollowUp: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li className="rounded-xl border bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-start gap-3 rounded-xl p-4 text-left hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-words">{block.title}</span>
            {block.status === 'flagged' && (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/50 bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning">
                <TriangleAlert className="size-3.5" aria-hidden />
                Check the numbers
              </span>
            )}
          </span>
          <span className="block text-sm text-muted-foreground break-words">“{block.question}”</span>
          <span className="block text-sm text-muted-foreground">{formatDateTime(block.created_at)}</span>
        </span>
        <ChevronDown className={cn('mt-1 size-4 shrink-0 text-muted-foreground', open && 'rotate-180')} aria-hidden />
      </button>
      {/* Charts are only drawn for open items. */}
      {open && (
        <div id={panelId} className="border-t p-2 sm:p-3">
          <AnswerCard block={block} dataset={dataset} headingLevel={3} asking={asking} onFollowUp={onFollowUp} />
        </div>
      )}
    </li>
  );
}
