import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Download, LayoutTemplate, Pencil, Plus, Share2, Trash2, X } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import { getDataset } from '@/api/datasets';
import type { ID, ReportDetail } from '@/api/types';
import { meKey } from '@/auth/useMe';
import { FieldError, FormMessage, TextField } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
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
import { env } from '@/env';
import { formatNumber } from '@/lib/format';
import { AnswerCard } from '@/features/ask/AnswerCard';
import type { DatasetState } from '@/features/ask/HowCalculated';
import { AddAnswersDialog } from './AddAnswersDialog';
import { PERIOD_MAX, SUBTITLE_MAX, TITLE_MAX } from './CreateReportDialog';
import { useDeleteReport, useReport, useUpdateReport, reportKeys } from './queries';
import { ReportHeader } from './ReportHeader';
import { HEADING_MAX, NOTES_MAX, buildReportPatch, draftErrors, draftFrom, moveBlock, type DraftErrors, type ReportDraft } from './reportDraft';
import { MAX_REPORT_BLOCKS } from './tray';

function BackLink() {
  return (
    <Link to="/reports" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline">
      <ArrowLeft className="size-4" aria-hidden />
      All reports
    </Link>
  );
}

export function ReportPage() {
  const { id = '' } = useParams();
  const report = useReport(id);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BackLink />
      {report.isPending ? (
        <InlineLoading label="Loading the report" />
      ) : report.isError ? (
        <FormMessage>
          {isApiError(report.error) && report.error.code === 'not_found' ? 'We could not find this report. It may have been deleted.' : errorMessage(report.error)}
        </FormMessage>
      ) : (
        <ReportView report={report.data} />
      )}
    </div>
  );
}

/** What each answer's file looks like now (deleted, expired or ready), for the "rows behind this answer" section. */
function useDatasetStates(datasetIds: Array<ID | null>): Map<ID, DatasetState> {
  const ids = [...new Set(datasetIds.filter((d): d is ID => Boolean(d)))];
  const results = useQueries({
    queries: ids.map((datasetId) => ({
      queryKey: ['datasets', 'detail', datasetId],
      queryFn: ({ signal }: { signal: AbortSignal }) => getDataset(datasetId, signal),
      retry: false,
      staleTime: 60_000,
    })),
  });
  return new Map(
    ids.map((datasetId, i) => {
      const r = results[i];
      const gone = isApiError(r?.error) && r.error.code === 'not_found';
      return [
        datasetId,
        {
          exists: !gone,
          status: r?.data?.status ?? null,
          expires_at: r?.data?.expires_at ?? null,
          columns: r?.data?.columns ?? [],
          workspace_id: r?.data?.workspace_id ?? null,
          name: r?.data?.name ?? null,
        },
      ];
    }),
  );
}

const DELETED: DatasetState = { exists: false, status: null, expires_at: null, columns: [] };

function ReportView({ report }: { report: ReportDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReportDraft>(() => draftFrom(report));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ID | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logoAttempts, setLogoAttempts] = useState(0);
  const update = useUpdateReport(report.id);
  const remove = useDeleteReport(report.id, report.workspace_id);

  const shown = editing ? draft.blocks : draftFrom(report).blocks;
  const datasets = useDatasetStates(shown.map((b) => b.block.dataset_id));
  const patch = useMemo(() => (editing ? buildReportPatch(report, draft) : null), [editing, report, draft]);

  /** A signed logo URL expires after an hour: on the first failure fetch fresh URLs once, then give up quietly. */
  const onLogoError = () => {
    if (logoAttempts === 0) {
      setLogoAttempts(1);
      void queryClient.invalidateQueries({ queryKey: reportKeys.detail(report.id) });
      void queryClient.invalidateQueries({ queryKey: meKey });
    } else {
      setLogoAttempts(2);
    }
  };

  const startEditing = () => {
    setDraft(draftFrom(report));
    setErrors({});
    setSaveMessage(null);
    setEditing(true);
  };

  const titleOf = (blockId: ID) => {
    const b = draft.blocks.find((x) => x.block_id === blockId);
    return b ? b.heading.trim() || b.block.title : 'An answer';
  };

  const save = () => {
    const problems = draftErrors(draft);
    setErrors(problems);
    setSaveMessage(null);
    if (Object.keys(problems).length > 0 || !patch) return;
    update.mutate(patch, {
      onSuccess: (next) => {
        setDraft(draftFrom(next));
        setEditing(false);
      },
      onError: (error) => {
        if (!isApiError(error)) return setSaveMessage(errorMessage(error));
        if (error.code === 'not_found') return setSaveMessage('This report, or one of the answers in it, no longer exists. Reload the page to see the report as it is now.');
        if (error.code === 'validation_failed') {
          const fields = error.fieldErrors;
          const ids = draft.blocks.map((b) => b.block_id);
          const named = Object.entries(fields).flatMap(([path, message]) => {
            const m = /^blocks\.(\d+)\./.exec(path);
            const blockId = m ? ids[Number(m[1])] : undefined;
            return blockId ? [`“${titleOf(blockId)}”: ${message}`] : [];
          });
          setErrors({ title: fields.title, subtitle: fields.subtitle, period_label: fields.period_label, notes: fields.notes });
          setSaveMessage(named.length > 0 ? named.join(' ') : (error.serverMessage ?? error.message));
          return;
        }
        setSaveMessage(errorMessage(error));
      },
    });
  };

  const set = (key: 'title' | 'subtitle' | 'period_label' | 'notes') => (event: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: event.target.value }));

  return (
    <div className="space-y-6">
      {/* Actions. Download, Share and Save as template come in later parts. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Report actions">
        {!editing && (
          <>
            <Button variant="outline" onClick={startEditing}>
              <Pencil aria-hidden />
              Edit report
            </Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden />
              Delete report
            </Button>
          </>
        )}
        <Button variant="outline" disabled>
          <Download aria-hidden />
          Download (Coming soon)
        </Button>
        <Button variant="outline" disabled>
          <Share2 aria-hidden />
          Share (Coming soon)
        </Button>
        <Button variant="outline" disabled>
          <LayoutTemplate aria-hidden />
          Save as template (Coming soon)
        </Button>
      </div>

      {editing ? (
        <section aria-label="Edit the report details" className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
          <h2 className="text-lg font-semibold">Editing the report</h2>
          <TextField label="Title" value={draft.title} maxLength={TITLE_MAX} error={errors.title} onChange={set('title')} />
          <TextField label="Subtitle (optional)" value={draft.subtitle} maxLength={SUBTITLE_MAX} error={errors.subtitle} onChange={set('subtitle')} />
          <TextField
            label="Period (optional)"
            value={draft.period_label}
            maxLength={PERIOD_MAX}
            placeholder="October 2026"
            error={errors.period_label}
            onChange={set('period_label')}
          />
          <div className="space-y-1.5">
            <Label htmlFor="report-notes">Notes (optional)</Label>
            <textarea
              id="report-notes"
              value={draft.notes}
              maxLength={NOTES_MAX}
              rows={4}
              onChange={set('notes')}
              aria-describedby="report-notes-count"
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 md:text-sm"
            />
            <p id="report-notes-count" className="text-sm text-muted-foreground tabular">
              {formatNumber(draft.notes.length, 0)} of {formatNumber(NOTES_MAX, 0)} characters. Shown as plain text under the title.
            </p>
            <FieldError message={errors.notes} />
          </div>
        </section>
      ) : (
        <ReportHeader
          brand={report.brand}
          title={report.title}
          subtitle={report.subtitle}
          periodLabel={report.period_label}
          createdAt={report.created_at}
          notes={report.notes}
          onLogoError={onLogoError}
          logoHidden={logoAttempts >= 2}
        />
      )}

      <ol className="space-y-6" aria-label="Answers in this report">
        {shown.map((item, i) => {
          const dataset = item.block.dataset_id ? (datasets.get(item.block.dataset_id) ?? DELETED) : DELETED;
          return (
            <li key={item.block_id} className="space-y-3">
              {editing && (
                <div className="space-y-3 rounded-xl border border-dashed bg-card p-3">
                  <TextField
                    label={`Heading for answer ${formatNumber(i + 1, 0)}`}
                    value={item.heading}
                    placeholder={item.block.title}
                    maxLength={HEADING_MAX}
                    hint="Leave empty to use the answer's own title."
                    error={errors.headings?.[item.block_id]}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => (b.block_id === item.block_id ? { ...b, heading: e.target.value } : b)) }))
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={i === 0} onClick={() => setDraft((d) => moveBlock(d, item.block_id, -1))}>
                      <ArrowUp aria-hidden />
                      Move up<span className="sr-only">: {item.heading || item.block.title}</span>
                    </Button>
                    <Button variant="outline" disabled={i === shown.length - 1} onClick={() => setDraft((d) => moveBlock(d, item.block_id, 1))}>
                      <ArrowDown aria-hidden />
                      Move down<span className="sr-only">: {item.heading || item.block.title}</span>
                    </Button>
                    <Button variant="outline" className="text-destructive" onClick={() => setRemoving(item.block_id)}>
                      <X aria-hidden />
                      Remove from report<span className="sr-only">: {item.heading || item.block.title}</span>
                    </Button>
                  </div>
                </div>
              )}
              <AnswerCard block={item.block} dataset={dataset} mode="report" heading={item.heading.trim() || undefined} />
            </li>
          );
        })}
      </ol>

      {editing && (
        <div className="sticky bottom-2 z-10 space-y-3 rounded-xl border border-primary/40 bg-card p-4 shadow-md">
          {errors.blocks && <FormMessage>{errors.blocks}</FormMessage>}
          {saveMessage && <FormMessage>{saveMessage}</FormMessage>}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setAdding(true)} disabled={draft.blocks.length >= MAX_REPORT_BLOCKS}>
              <Plus aria-hidden />
              Add answers
            </Button>
            <span className="text-sm text-muted-foreground tabular">
              {formatNumber(draft.blocks.length, 0)} of {formatNumber(MAX_REPORT_BLOCKS, 0)} answers
            </span>
            <span className="flex-1" />
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button disabled={!patch || update.isPending} onClick={save}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {patch ? 'You have unsaved changes.' : 'No changes yet.'}
          </p>
        </div>
      )}

      {report.watermark && <p className="pt-4 text-center text-sm text-muted-foreground">Made with {env.appName}</p>}

      <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Remove this answer from the report?</DialogTitle>
            <DialogDescription>
              “{removing ? titleOf(removing) : ''}” leaves this report when you save. The answer itself stays in your history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.block_id !== removing) }));
                setRemoving(null);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddAnswersDialog
        open={adding}
        workspaceId={report.workspace_id}
        memberIds={new Set(draft.blocks.map((b) => b.block_id))}
        onClose={() => setAdding(false)}
        onAdd={(blocks) =>
          setDraft((d) => ({
            ...d,
            blocks: [...d.blocks, ...blocks.map((block) => ({ block_id: block.id, heading: '', block }))].slice(0, MAX_REPORT_BLOCKS),
          }))
        }
      />

      <Dialog open={confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Delete “{report.title}”?</DialogTitle>
            <DialogDescription>The report is deleted. The answers in it are kept in your history. This cannot be undone.</DialogDescription>
          </DialogHeader>
          {remove.isError && <FormMessage>{errorMessage(remove.error)}</FormMessage>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => navigate('/reports', { replace: true }) })}>
              {remove.isPending ? 'Deleting…' : 'Delete report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
