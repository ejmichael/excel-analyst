import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage, isApiError } from '@/api/client';
import { getBlock } from '@/api/blocks';
import type { ID, PlanLimitDetails } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage, TextField } from '@/components/FormField';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatNumber } from '@/lib/format';
import { useCreateReport } from './queries';
import type { TrayItem } from './tray';

export const TITLE_MAX = 120;
export const SUBTITLE_MAX = 200;
export const PERIOD_MAX = 60;

export interface ReportFields {
  title: string;
  subtitle: string;
  period_label: string;
}

/** Field errors in words for the report fields (the same bounds as the server). */
export function reportFieldErrors(values: ReportFields): Partial<Record<keyof ReportFields, string>> {
  const errors: Partial<Record<keyof ReportFields, string>> = {};
  const title = values.title.trim();
  if (!title) errors.title = 'Give the report a title.';
  else if (title.length > TITLE_MAX) errors.title = `Keep the title to ${formatNumber(TITLE_MAX, 0)} characters or fewer.`;
  if (values.subtitle.trim().length > SUBTITLE_MAX) errors.subtitle = `Keep the subtitle to ${formatNumber(SUBTITLE_MAX, 0)} characters or fewer.`;
  if (values.period_label.trim().length > PERIOD_MAX) errors.period_label = `Keep the period to ${formatNumber(PERIOD_MAX, 0)} characters or fewer.`;
  return errors;
}

/** Answers named in a 422 by position (block_ids.N or blocks.N.block_id), with the server's message. */
export function answersNamedIn(fieldErrors: Record<string, string>, ids: ID[]): Array<{ block_id: ID; message: string }> {
  const named: Array<{ block_id: ID; message: string }> = [];
  for (const [path, message] of Object.entries(fieldErrors)) {
    const m = /^(?:block_ids|blocks)\.(\d+)(?:\.block_id)?$/.exec(path);
    const id = m ? ids[Number(m[1])] : undefined;
    if (id) named.push({ block_id: id, message });
  }
  return named;
}

interface CreateReportDialogProps {
  open: boolean;
  workspaceId: ID;
  items: TrayItem[];
  onClose: () => void;
  onCreated: () => void;
  onDrop: (blockIds: ID[]) => void;
}

export function CreateReportDialog({ open, workspaceId, items, onClose, onCreated, onDrop }: CreateReportDialogProps) {
  const id = useId();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useCreateReport();
  const defaultTitle = `${items[0]?.dataset_name ?? 'Answers'} report`.slice(0, TITLE_MAX);
  const [values, setValues] = useState<ReportFields>({ title: defaultTitle, subtitle: '', period_label: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof ReportFields, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [named, setNamed] = useState<Array<{ block_id: ID; message: string }>>([]);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | null>(null);

  useEffect(() => {
    if (open) {
      setValues({ title: defaultTitle, subtitle: '', period_label: '' });
      setErrors({});
      setMessage(null);
      setNamed([]);
    }
    // Reset only when the dialog opens.
  }, [open]);

  const set = (key: keyof ReportFields) => (event: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: event.target.value }));

  /** A 404 does not say which answer is gone, so each one is checked and the missing ones dropped. */
  const dropMissing = async () => {
    const results = await Promise.all(
      items.map(async (item) => {
        try {
          await getBlock(item.block_id);
          return null;
        } catch (error) {
          return isApiError(error) && error.code === 'not_found' ? item : null;
        }
      }),
    );
    const missing = results.filter((r): r is TrayItem => r !== null);
    if (missing.length > 0) {
      onDrop(missing.map((m) => m.block_id));
      setMessage(
        `One of these answers no longer exists, so it was removed from your tray: ${missing.map((m) => `“${m.title}”`).join(', ')}.`,
      );
    } else {
      setMessage('Something in this report could not be found. Reload the page and try again.');
    }
  };

  const submit = () => {
    const problems = reportFieldErrors(values);
    setErrors(problems);
    setMessage(null);
    setNamed([]);
    if (Object.keys(problems).length > 0 || items.length === 0) return;
    const blockIds = items.map((i) => i.block_id);
    create.mutate(
      {
        workspace_id: workspaceId,
        title: values.title.trim(),
        subtitle: values.subtitle.trim() || null,
        period_label: values.period_label.trim() || null,
        block_ids: blockIds,
      },
      {
        onSuccess: (report) => {
          onCreated();
          navigate(`/reports/${report.id}`);
        },
        onError: (error) => {
          if (!isApiError(error)) return setMessage(errorMessage(error));
          if (error.planLimit) return setPlanLimit(error.planLimit);
          if (error.code === 'not_found') return void dropMissing();
          if (error.code === 'validation_failed') {
            const fields = error.fieldErrors;
            setErrors({ title: fields.title, subtitle: fields.subtitle, period_label: fields.period_label });
            const answers = answersNamedIn(fields, blockIds);
            setNamed(answers);
            const onFields = Boolean(fields.title || fields.subtitle || fields.period_label);
            // The server's message explains the workspace rule; it is written for the user.
            setMessage(onFields && answers.length === 0 ? null : (error.serverMessage ?? error.message));
            return;
          }
          setMessage(errorMessage(error));
        },
      },
    );
  };

  const used = me.data?.usage.reports;
  const limit = me.data?.limits.max_reports_per_month;
  const titleOf = (blockId: ID) => items.find((i) => i.block_id === blockId)?.title ?? 'An answer';

  return (
    <>
      <Dialog open={open && !planLimit} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <DialogHeader>
              <DialogTitle className="font-heading text-xl">Create a report</DialogTitle>
              <DialogDescription>
                {items.length === 1 ? '1 answer' : `${formatNumber(items.length, 0)} answers`}, in the order shown in your tray.
              </DialogDescription>
            </DialogHeader>
            <TextField
              label="Title"
              value={values.title}
              maxLength={TITLE_MAX}
              autoFocus
              required
              error={errors.title}
              onChange={set('title')}
            />
            <TextField
              label="Subtitle (optional)"
              value={values.subtitle}
              maxLength={SUBTITLE_MAX}
              error={errors.subtitle}
              onChange={set('subtitle')}
            />
            <TextField
              label="Period (optional)"
              value={values.period_label}
              maxLength={PERIOD_MAX}
              placeholder="October 2026"
              error={errors.period_label}
              onChange={set('period_label')}
            />

            {(message || named.length > 0) && (
              <FormMessage>
                {message}
                {named.length > 0 && (
                  <ul id={`${id}-named`} className="mt-2 list-disc space-y-1 pl-5">
                    {named.map((n) => (
                      <li key={n.block_id}>
                        “{titleOf(n.block_id)}”: {n.message}{' '}
                        <button
                          type="button"
                          className="inline-flex min-h-11 items-center font-medium underline underline-offset-4"
                          onClick={() => {
                            onDrop([n.block_id]);
                            setNamed((all) => all.filter((x) => x.block_id !== n.block_id));
                          }}
                        >
                          Remove it from the tray
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </FormMessage>
            )}

            <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col sm:items-end">
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={create.isPending || items.length === 0}>
                  {create.isPending ? 'Creating…' : 'Create report'}
                </Button>
              </div>
              {used !== undefined && limit !== undefined && (
                <p className="text-sm text-muted-foreground tabular">
                  {formatNumber(used, 0)} of {formatNumber(limit, 0)} reports used this month
                </p>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {me.data && (
        <UpgradeDialog
          details={planLimit}
          plan={me.data.plan}
          onClose={() => {
            setPlanLimit(null);
            void queryClient.invalidateQueries({ queryKey: ['me'] });
          }}
        />
      )}
    </>
  );
}
