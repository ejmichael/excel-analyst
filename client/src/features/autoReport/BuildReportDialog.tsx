import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AutoReportRequest, DatasetDetail, PlanLimitDetails } from '@/api/types';
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
import { PERIOD_MAX, TITLE_MAX } from '@/features/reports/CreateReportDialog';
import { describeStartError } from './autoReportErrors';
import { useStartAutoReport } from './queries';

interface Fields {
  title: string;
  period_label: string;
}

/** Flow B2 request rules: both optional; title trimmed 1 to 120 (default: the file's name), period up to 60. */
export function autoReportFieldErrors(values: Fields): Partial<Record<keyof Fields, string>> {
  const errors: Partial<Record<keyof Fields, string>> = {};
  if (values.title.trim().length > TITLE_MAX) errors.title = `Keep the title to ${TITLE_MAX} characters or fewer.`;
  if (values.period_label.trim().length > PERIOD_MAX) errors.period_label = `Keep the period to ${PERIOD_MAX} characters or fewer.`;
  return errors;
}

/** Only what was filled in is sent; the server uses the file's name when there is no title. */
export function autoReportRequest(values: Fields): AutoReportRequest {
  const title = values.title.trim();
  const period = values.period_label.trim();
  return { ...(title ? { title } : {}), ...(period ? { period_label: period } : {}) };
}

interface BuildReportDialogProps {
  open: boolean;
  dataset: DatasetDetail;
  onClose: () => void;
}

export function BuildReportDialog({ open, dataset, onClose }: BuildReportDialogProps) {
  const me = useMe();
  const start = useStartAutoReport(dataset.id);
  const [values, setValues] = useState<Fields>({ title: '', period_label: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [message, setMessage] = useState<{ text: string; offerAsk?: boolean } | null>(null);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | null>(null);

  useEffect(() => {
    if (open) {
      setValues({ title: '', period_label: '' });
      setErrors({});
      setMessage(null);
    }
    // Reset only when the dialog opens.
  }, [open]);

  const set = (key: keyof Fields) => (event: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: event.target.value }));

  const submit = () => {
    const problems = autoReportFieldErrors(values);
    setErrors(problems);
    setMessage(null);
    if (Object.keys(problems).length > 0) return;
    start.mutate(autoReportRequest(values), {
      // The dataset page now shows the progress in place of the button.
      onSuccess: onClose,
      onError: (error) => {
        const view = describeStartError(error, dataset);
        if (view.kind === 'plan_limit') return setPlanLimit(view.details);
        if (view.kind === 'fields') return setErrors({ title: view.title, period_label: view.period_label });
        setMessage({ text: view.message, offerAsk: view.offerAsk });
      },
    });
  };

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
              <DialogTitle className="font-heading text-xl">Build my report</DialogTitle>
              <DialogDescription>Both are optional. You can change them in the report afterwards.</DialogDescription>
            </DialogHeader>
            <TextField
              label="Title (optional)"
              value={values.title}
              placeholder={dataset.name}
              maxLength={TITLE_MAX}
              hint="Leave empty to use the file's name."
              error={errors.title}
              onChange={set('title')}
            />
            <TextField
              label="Period (optional)"
              value={values.period_label}
              placeholder="October 2026"
              maxLength={PERIOD_MAX}
              error={errors.period_label}
              onChange={set('period_label')}
            />
            {message && (
              <FormMessage>
                {message.text}
                {message.offerAsk && (
                  <>
                    {' '}
                    <Link to={`/datasets/${dataset.id}/ask`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
                      Ask your own questions
                    </Link>
                  </>
                )}
              </FormMessage>
            )}
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={start.isPending}>
                {start.isPending ? 'Starting…' : 'Start'}
              </Button>
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
            onClose();
          }}
        />
      )}
    </>
  );
}
