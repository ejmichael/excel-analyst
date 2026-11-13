import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '@/api/client';
import { listDatasets } from '@/api/datasets';
import type { Block, ID } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { formatDateTime, formatNumber } from '@/lib/format';
import { selectClass } from '@/features/datasets/ColumnsForm';
import { useAnswerHistory } from '@/features/ask/queries';
import { MAX_REPORT_BLOCKS } from './tray';

interface AddAnswersDialogProps {
  open: boolean;
  workspaceId: ID;
  /** Answers already in the report (marked, and not offered again). */
  memberIds: Set<ID>;
  onClose: () => void;
  onAdd: (blocks: Block[]) => void;
}

/** Picks answers from this workspace's files to add to a report, up to 30 in all. */
export function AddAnswersDialog({ open, workspaceId, memberIds, onClose, onAdd }: AddAnswersDialogProps) {
  const id = useId();
  const [datasetId, setDatasetId] = useState('');
  const [picked, setPicked] = useState<Map<ID, Block>>(new Map());
  const datasets = useQuery({
    queryKey: ['datasets', 'picker', workspaceId],
    queryFn: ({ signal }) => listDatasets(workspaceId, { limit: 200, offset: 0 }, signal),
    enabled: open,
  });

  useEffect(() => {
    if (open) setPicked(new Map());
  }, [open]);

  const room = MAX_REPORT_BLOCKS - memberIds.size - picked.size;
  const toggle = (block: Block) =>
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(block.id)) next.delete(block.id);
      else if (room > 0) next.set(block.id, block);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl">Add answers</DialogTitle>
          <DialogDescription>Choose a file from this workspace, then the answers to add. A report holds at most {formatNumber(MAX_REPORT_BLOCKS, 0)}.</DialogDescription>
        </DialogHeader>

        {datasets.isPending ? (
          <InlineLoading label="Loading your files" />
        ) : datasets.isError ? (
          <FormMessage>{errorMessage(datasets.error)}</FormMessage>
        ) : datasets.data.items.length === 0 ? (
          <p className="text-sm">This workspace has no files yet.</p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-file`}>File</Label>
            <select id={`${id}-file`} className={selectClass} value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
              <option value="">Choose a file</option>
              {datasets.data.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {datasetId && <AnswerChoices datasetId={datasetId} memberIds={memberIds} picked={picked} room={room} onToggle={toggle} />}

        <p className="text-sm tabular" aria-live="polite">
          {room <= 0
            ? `The report is full: it holds at most ${formatNumber(MAX_REPORT_BLOCKS, 0)} answers.`
            : `${formatNumber(picked.size, 0)} chosen. Room for ${formatNumber(room, 0)} more.`}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() => {
              onAdd([...picked.values()]);
              onClose();
            }}
          >
            {picked.size === 1 ? 'Add 1 answer' : `Add ${formatNumber(picked.size, 0)} answers`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AnswerChoices({
  datasetId,
  memberIds,
  picked,
  room,
  onToggle,
}: {
  datasetId: ID;
  memberIds: Set<ID>;
  picked: Map<ID, Block>;
  room: number;
  onToggle: (block: Block) => void;
}) {
  const history = useAnswerHistory(datasetId);
  const blocks = history.data?.pages.flatMap((p) => p.items) ?? [];
  if (history.isPending) return <InlineLoading label="Loading the answers" />;
  if (history.isError) return <FormMessage>{errorMessage(history.error)}</FormMessage>;
  if (blocks.length === 0) return <p className="text-sm">No answers from this file yet.</p>;

  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border" aria-label="Answers from this file">
        {blocks.map((block) => {
          const member = memberIds.has(block.id);
          const checked = member || picked.has(block.id);
          const disabled = member || (!checked && room <= 0);
          const boxId = `pick-${block.id}`;
          return (
            <li key={block.id} className="flex items-start gap-3 p-3">
              <Checkbox id={boxId} checked={checked} disabled={disabled} onCheckedChange={() => onToggle(block)} className="mt-1" />
              <label htmlFor={boxId} className="min-w-0 flex-1 cursor-pointer space-y-0.5">
                <span className="block font-medium break-words">{block.title}</span>
                <span className="block text-sm text-muted-foreground break-words">“{block.question}”</span>
                <span className="block text-sm text-muted-foreground">
                  {formatDateTime(block.created_at)}
                  {member && ' · Already in this report'}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {history.hasNextPage && (
        <Button variant="outline" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
          {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
