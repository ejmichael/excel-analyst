import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { listDatasets } from '@/api/datasets';
import type { Block, Dataset, ID, PlanLimitDetails } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FieldError, FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog } from '@/components/UpgradeDialog';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDateTime, formatNumber } from '@/lib/format';
import { MAX_QUESTION, questionError } from '@/features/ask/AskForm';
import { describeAskError, type AskErrorView } from '@/features/ask/askErrors';
import { useAnswerHistory, useAsk } from '@/features/ask/queries';
import { selectClass } from '@/features/datasets/ColumnsForm';
import { MAX_REPORT_BLOCKS } from './tray';

export const ALL_IN_REPORT = 'Every answer for this file is already in the report. Ask a new question below.';
export const NO_ANSWERS_YET = 'No answers from this file yet. Ask a new question below.';

interface AddAnswersDialogProps {
  open: boolean;
  workspaceId: ID;
  /** The file the report is mainly from: the picker opens on it. */
  defaultDatasetId?: ID;
  /** Answers already in the report (not offered again). */
  memberIds: Set<ID>;
  onClose: () => void;
  onAdd: (blocks: Block[]) => void;
}

/**
 * Adds answers to a report being edited (up to 30 in all): existing answers from this workspace's files, or a new
 * question asked here. Nothing reaches the report until Save changes.
 */
export function AddAnswersDialog({ open, workspaceId, defaultDatasetId, memberIds, onClose, onAdd }: AddAnswersDialogProps) {
  const id = useId();
  const me = useMe();
  const [datasetId, setDatasetId] = useState('');
  const [picked, setPicked] = useState<Map<ID, Block>>(new Map());
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | null>(null);
  const datasets = useQuery({
    queryKey: ['datasets', 'picker', workspaceId],
    queryFn: ({ signal }) => listDatasets(workspaceId, { limit: 200, offset: 0 }, signal),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setPicked(new Map());
      setDatasetId(defaultDatasetId ?? '');
    }
    // Reset only when the picker opens.
  }, [open]);

  const dataset = datasets.data?.items.find((d) => d.id === datasetId) ?? null;
  const room = MAX_REPORT_BLOCKS - memberIds.size - picked.size;
  const toggle = (block: Block) =>
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(block.id)) next.delete(block.id);
      else if (room > 0) next.set(block.id, block);
      return next;
    });

  return (
    <>
      <Dialog open={open && !planLimit} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Add an answer</DialogTitle>
            <DialogDescription>
              Choose answers from a file in this workspace, or ask a new question about it. A report holds at most{' '}
              {formatNumber(MAX_REPORT_BLOCKS, 0)}. Nothing changes until you save.
            </DialogDescription>
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

          {dataset && (
            <>
              <AnswerChoices datasetId={dataset.id} memberIds={memberIds} picked={picked} room={room} onToggle={toggle} />
              <AskInPicker
                // A new file gets a fresh question box.
                key={dataset.id}
                dataset={dataset}
                room={room}
                used={me.data?.usage.questions}
                limit={me.data?.limits.max_questions_per_month}
                onAnswered={(block) => {
                  // Added at the end of the report's edit list; saved only with Save changes.
                  onAdd([...picked.values(), block]);
                  onClose();
                }}
                onPlanLimit={setPlanLimit}
              />
            </>
          )}

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
      {me.data && <UpgradeDialog details={planLimit} plan={me.data.plan} onClose={() => setPlanLimit(null)} />}
    </>
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
  const searchId = useId();
  const [search, setSearch] = useState('');
  const history = useAnswerHistory(datasetId);
  if (history.isPending) return <InlineLoading label="Loading the answers" />;
  if (history.isError) return <FormMessage>{errorMessage(history.error)}</FormMessage>;

  // Newest first, as the API returns them; answers already in the report are not offered again.
  const all = history.data.pages.flatMap((p) => p.items);
  const offered = all.filter((b) => !memberIds.has(b.id));
  const needle = search.trim().toLocaleLowerCase('en-ZA');
  const shown = needle ? offered.filter((b) => `${b.title} ${b.question}`.toLocaleLowerCase('en-ZA').includes(needle)) : offered;

  if (all.length === 0 && !history.hasNextPage) return <p className="text-sm">{NO_ANSWERS_YET}</p>;
  if (offered.length === 0 && !history.hasNextPage) return <p className="text-sm">{ALL_IN_REPORT}</p>;

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={searchId}>Search this file's answers</Label>
        <Input id={searchId} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="A word from the title or question" />
      </div>
      {shown.length === 0 ? (
        <p className="text-sm">{offered.length === 0 ? ALL_IN_REPORT : 'No answers match your search.'}</p>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Answers from this file">
          {shown.map((block) => {
            const checked = picked.has(block.id);
            const disabled = !checked && room <= 0;
            const boxId = `pick-${block.id}`;
            return (
              <li key={block.id} className="flex items-start gap-3 p-3">
                <Checkbox id={boxId} checked={checked} disabled={disabled} onCheckedChange={() => onToggle(block)} className="mt-1" />
                <label htmlFor={boxId} className="min-w-0 flex-1 cursor-pointer space-y-0.5">
                  <span className="block font-medium break-words">{block.title}</span>
                  <span className="block text-sm text-muted-foreground break-words">“{block.question}”</span>
                  <span className="block text-sm text-muted-foreground">{formatDateTime(block.created_at)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {history.hasNextPage && (
        <Button variant="outline" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
          {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}

/** A new question about the chosen file, through the Ask screen's own hook, limits and error words. */
function AskInPicker({
  dataset,
  room,
  used,
  limit,
  onAnswered,
  onPlanLimit,
}: {
  dataset: Dataset;
  room: number;
  used: number | undefined;
  limit: number | undefined;
  onAnswered: (block: Block) => void;
  onPlanLimit: (details: PlanLimitDetails) => void;
}) {
  const boxId = useId();
  const countId = useId();
  const [question, setQuestion] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorView, setErrorView] = useState<AskErrorView | null>(null);
  const ask = useAsk(dataset.id);
  const notReady =
    dataset.status === 'ready'
      ? null
      : dataset.status === 'expired'
        ? 'The original file was deleted, so new questions cannot be asked about it.'
        : dataset.status === 'failed'
          ? 'This file could not be read, so it cannot answer questions.'
          : 'This file is still being read. You can ask as soon as it is ready.';
  const disabledReason = notReady ?? (room <= 0 ? `The report is full: it holds at most ${formatNumber(MAX_REPORT_BLOCKS, 0)} answers.` : null);

  const submit = () => {
    const problem = questionError(question);
    setFieldError(problem);
    setErrorView(null);
    if (problem || ask.isPending || disabledReason) return;
    ask.mutate(
      { question: question.trim(), source: 'user' },
      {
        onSuccess: (block) => onAnswered(block),
        onError: (error) => {
          const view = describeAskError(error, dataset);
          if (view.kind === 'plan_limit') return onPlanLimit(view.details);
          if (view.kind === 'field') return setFieldError(view.message);
          // Not added: "could not answer" and every other failure are said in words.
          setErrorView(view);
        },
      },
    );
  };

  return (
    <form
      noValidate
      className="space-y-2 rounded-lg border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Label htmlFor={boxId}>Ask a new question about this file</Label>
      <textarea
        id={boxId}
        rows={2}
        value={question}
        maxLength={MAX_QUESTION}
        disabled={Boolean(disabledReason) || ask.isPending}
        aria-invalid={fieldError ? true : undefined}
        aria-describedby={countId}
        onChange={(e) => setQuestion(e.target.value)}
        className="w-full rounded-md border border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 md:text-sm"
      />
      <p id={countId} className="text-sm text-muted-foreground tabular">
        {formatNumber(question.length, 0)} of {formatNumber(MAX_QUESTION, 0)} characters
        {used !== undefined && limit !== undefined && ` · ${formatNumber(used, 0)} of ${formatNumber(limit, 0)} questions used this month`}
      </p>
      <FieldError message={fieldError ?? undefined} />
      {disabledReason && <p className="text-sm">{disabledReason}</p>}
      {errorView && errorView.kind !== 'plan_limit' && errorView.kind !== 'field' && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning-bg p-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="space-y-1">
            {errorView.kind === 'cannot_answer' && <p className="font-medium">Analyst can't answer that from this file</p>}
            <p>{errorView.message}</p>
            {errorView.kind === 'cannot_answer' && <p>Nothing was added to the report.</p>}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" disabled={Boolean(disabledReason) || ask.isPending}>
          {ask.isPending ? 'Asking…' : 'Ask and add to the report'}
        </Button>
        <span aria-live="polite" className="text-sm text-muted-foreground">
          {ask.isPending ? 'Analyst is answering. This usually takes a few seconds.' : ''}
        </span>
      </div>
    </form>
  );
}
