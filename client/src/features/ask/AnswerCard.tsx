import { useId, useState, type Ref } from 'react';
import { CircleCheck, Download, Flag, Trash2, TriangleAlert } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import { downloadBlockCsv } from '@/api/blocks';
import type { Block } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { saveBlob, slugify } from '@/lib/download';
import { formatDateTime, formatNumber, isoDateInSast } from '@/lib/format';
import { BlockChart } from './BlockChart';
import { HowCalculated, type DatasetState } from './HowCalculated';
import { useBlockFeedback, useDeleteBlock } from './queries';

export const PINNED_MESSAGE = "This answer is part of a report, so it can't be deleted.";
export const MAX_FEEDBACK_NOTE = 500;

/** Downloads the answer's CSV with the token and saves it. The server counts it as an export. */
export async function downloadAnswerCsv(block: Pick<Block, 'id' | 'title'>): Promise<void> {
  const { blob, filename } = await downloadBlockCsv(block.id);
  // The server's file name (Content-Disposition); <title>-<date>.csv only if the header is missing.
  saveBlob(blob, filename ?? `${slugify(block.title)}-${isoDateInSast()}.csv`);
}

interface AnswerCardProps {
  block: Block;
  dataset: DatasetState;
  /** The newest answer opens "How this was calculated"; history items start with it closed. */
  newest?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  /** 2 for the newest answer, 3 inside the history list (under its own heading). */
  headingLevel?: 2 | 3;
  asking?: boolean;
  onFollowUp: (question: string) => void;
  onDeleted?: (id: string) => void;
}

export function AnswerCard({ block, dataset, newest = false, headingRef, headingLevel = 2, asking = false, onFollowUp, onDeleted }: AnswerCardProps) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const failed = block.checks.filter((c) => !c.ok);

  return (
    <article aria-labelledby={headingId} className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
      <header className="space-y-1">
        <Heading id={headingId} ref={headingRef} tabIndex={-1} className="text-xl font-semibold break-words outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {block.title}
        </Heading>
        <p className="text-sm text-muted-foreground break-words">
          <span className="sr-only">Question: </span>“{block.question}”
        </p>
        <p className="text-sm text-muted-foreground">
          <time dateTime={block.created_at}>{formatDateTime(block.created_at)}</time>
        </p>
      </header>

      {block.status === 'flagged' ? (
        <div role="note" className="rounded-lg border border-warning/50 bg-warning-bg p-4">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
            <div className="space-y-2">
              <p className="font-medium">Some checks did not pass, so check these numbers before you rely on them.</p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {failed.map((c, i) => (
                  <li key={`${c.type}-${i}`}>
                    {c.label}
                    {c.detail ? `: ${c.detail}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-primary" aria-hidden />
          All checks passed.
        </p>
      )}

      {/* Plain text: React escapes it, so API text can never become markup. */}
      <p className="whitespace-pre-line break-words">{block.narrative}</p>

      {block.truncated && (
        <p className="text-sm tabular">
          Showing the first {formatNumber(block.rows.length, 0)} of {formatNumber(block.row_count, 0)} rows.
        </p>
      )}

      <BlockChart block={block} />

      {block.follow_ups.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-sans text-sm font-semibold">Ask next</h3>
          <div className="flex flex-wrap gap-2">
            {block.follow_ups.slice(0, 3).map((q) => (
              <Button key={q} variant="outline" className="h-auto min-h-11 text-left whitespace-normal" disabled={asking} onClick={() => onFollowUp(q)}>
                {q}
              </Button>
            ))}
          </div>
        </div>
      )}

      <HowCalculated block={block} dataset={dataset} defaultOpen={newest} />

      <AnswerActions block={block} onDeleted={onDeleted} />
    </article>
  );
}

function AnswerActions({ block, onDeleted }: { block: Block; onDeleted?: (id: string) => void }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [download, setDownload] = useState<{ state: 'idle' | 'busy' | 'done' } | { state: 'error'; message: string }>({ state: 'idle' });
  const remove = useDeleteBlock(block);

  const onDownload = async () => {
    setDownload({ state: 'busy' });
    try {
      await downloadAnswerCsv(block);
      setDownload({ state: 'done' });
    } catch (error) {
      setDownload({ state: 'error', message: errorMessage(error) });
    }
  };

  const deleteError =
    remove.isError && isApiError(remove.error) && remove.error.code === 'conflict' ? PINNED_MESSAGE : remove.isError ? errorMessage(remove.error) : null;

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" aria-expanded={feedbackOpen} onClick={() => setFeedbackOpen((o) => !o)}>
          <Flag aria-hidden />
          This looks wrong
        </Button>
        <Button variant="outline" disabled={download.state === 'busy'} onClick={() => void onDownload()}>
          <Download aria-hidden />
          {download.state === 'busy' ? 'Downloading…' : 'Download CSV'}
        </Button>
        <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden />
          Delete this answer
        </Button>
        {/* Room for "Add to report" (a later part). */}
        <span data-slot="add-to-report" className="hidden" />
      </div>
      <div aria-live="polite" className="space-y-2">
        {download.state === 'done' && <p className="text-sm">The CSV file has been downloaded.</p>}
        {download.state === 'error' && <FormMessage>{download.message}</FormMessage>}
        {deleteError && !confirmDelete && <FormMessage>{deleteError}</FormMessage>}
      </div>
      {feedbackOpen && <FeedbackForm blockId={block.id} onClose={() => setFeedbackOpen(false)} />}

      <Dialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Delete this answer?</DialogTitle>
            <DialogDescription>“{block.title}” will be removed from your history. This cannot be undone.</DialogDescription>
          </DialogHeader>
          {deleteError && <FormMessage>{deleteError}</FormMessage>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    onDeleted?.(block.id);
                  },
                })
              }
            >
              {remove.isPending ? 'Deleting…' : 'Delete answer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function FeedbackForm({ blockId, onClose }: { blockId: string; onClose: () => void }) {
  const id = useId();
  const [note, setNote] = useState('');
  const feedback = useBlockFeedback(blockId);

  if (feedback.isSuccess) {
    return (
      <div className="space-y-2 rounded-lg border bg-background p-3" role="status">
        <p className="text-sm">Thank you. We have noted that this answer looks wrong.</p>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-2 rounded-lg border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        feedback.mutate(note);
      }}
    >
      <Label htmlFor={`${id}-note`}>What looks wrong? (optional)</Label>
      <textarea
        id={`${id}-note`}
        value={note}
        maxLength={MAX_FEEDBACK_NOTE}
        rows={3}
        onChange={(event) => setNote(event.target.value)}
        aria-describedby={`${id}-count`}
        className="w-full rounded-md border border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 md:text-sm"
      />
      <p id={`${id}-count`} className="text-sm text-muted-foreground tabular">
        {formatNumber(note.length, 0)} of {formatNumber(MAX_FEEDBACK_NOTE, 0)} characters. Your note is not sent to the AI.
      </p>
      {feedback.isError && <FormMessage>{errorMessage(feedback.error)}</FormMessage>}
      <div className="flex gap-2">
        <Button type="submit" disabled={feedback.isPending}>
          {feedback.isPending ? 'Sending…' : 'Send'}
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
