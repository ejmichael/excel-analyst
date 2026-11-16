import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Link2, Link2Off, TriangleAlert } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { CreateShareLinkRequest, ID, PlanLimitDetails, ShareLink } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { formatDate, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { STATUS_WORDS, linkStatus, useCreateShareLink, useRevokeShareLink, useShareLinks } from './shareQueries';

export const LINK_EXPLAINER = "Anyone who has this link can see this report, including every table in it. They don't need an account.";
export const PERSONAL_DATA_NOTICE = 'This report may contain personal details such as names, emails or phone numbers. Check the tables before you share it.';
export const PERSONAL_DATA_CAVEAT = 'This is a best-effort check, not a guarantee: it can miss personal details, and it can flag some that are not.';

type Expiry = NonNullable<CreateShareLinkRequest['expires_in_days']> | null;
const EXPIRY_OPTIONS: Array<{ value: Expiry; label: string }> = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: null, label: 'No expiry' },
];

interface ShareDialogProps {
  open: boolean;
  report: { id: ID; title: string };
  onClose: () => void;
}

/**
 * Create, copy and turn off share links. The full link (with its token) is shown only here, to the owner; it is never
 * logged, put in an error message or in the page title.
 */
export function ShareDialog({ open, report, onClose }: ShareDialogProps) {
  const me = useMe();
  const links = useShareLinks(report.id, open);
  const create = useCreateShareLink(report.id);
  const [expiry, setExpiry] = useState<Expiry>(30);
  const [showWorking, setShowWorking] = useState(false);
  const [created, setCreated] = useState<ShareLink | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | null>(null);
  const expiryName = useId();
  const workingId = useId();

  useEffect(() => {
    if (open) {
      setCreated(null);
      setMessage(null);
    }
  }, [open]);

  const personalData = Boolean(created?.contains_personal_data) || (links.data ?? []).some((l) => l.contains_personal_data);

  const submit = () => {
    setMessage(null);
    create.mutate(
      { expires_in_days: expiry, show_working: showWorking },
      {
        onSuccess: (link) => setCreated(link),
        onError: (error) => {
          if (isApiError(error) && error.planLimit) return setPlanLimit(error.planLimit);
          setMessage(errorMessage(error));
        },
      },
    );
  };

  return (
    <>
      <Dialog open={open && !planLimit} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Share this report</DialogTitle>
            <DialogDescription className="text-base text-foreground">{LINK_EXPLAINER}</DialogDescription>
          </DialogHeader>

          {personalData && <PersonalDataNotice />}

          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">The link stops working after</legend>
              <div className="flex flex-wrap gap-2">
                {EXPIRY_OPTIONS.map((option) => (
                  <label
                    key={option.label}
                    className={cn(
                      'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      expiry === option.value && 'border-primary bg-accent',
                    )}
                  >
                    <input
                      type="radio"
                      name={expiryName}
                      className="size-4 accent-[var(--primary)]"
                      checked={expiry === option.value}
                      onChange={() => setExpiry(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex items-start gap-3">
              <Checkbox id={workingId} checked={showWorking} onCheckedChange={(v) => setShowWorking(v === true)} className="mt-1" />
              <div className="space-y-0.5">
                <Label htmlFor={workingId} className="min-h-6 leading-snug">
                  Show how each answer was calculated (the SQL and checks)
                </Label>
                <p className="text-sm text-muted-foreground">
                  Off: people see the answers, charts and tables, but not the queries or the checks behind them.
                </p>
              </div>
            </div>

            {message && <FormMessage>{message}</FormMessage>}
            <Button type="submit" disabled={create.isPending}>
              <Link2 aria-hidden />
              {create.isPending ? 'Creating the link…' : 'Create a link'}
            </Button>
          </form>

          {created && (
            <section aria-labelledby="new-link-heading" className="space-y-2 rounded-lg border border-primary/40 bg-accent/40 p-3">
              <h3 id="new-link-heading" className="font-sans text-sm font-semibold">
                Your new link
              </h3>
              <CopyLinkField url={created.url} label="New link" />
            </section>
          )}

          <section aria-labelledby="links-heading" className="space-y-3">
            <h3 id="links-heading" className="font-sans text-base font-semibold">
              Links to this report
            </h3>
            {links.isPending ? (
              <InlineLoading label="Loading the links" />
            ) : links.isError ? (
              <div className="space-y-2">
                <FormMessage>{errorMessage(links.error)}</FormMessage>
                <Button variant="outline" onClick={() => void links.refetch()}>
                  Try again
                </Button>
              </div>
            ) : links.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No links yet.</p>
            ) : (
              <ul className="space-y-3">
                {links.data.map((link) => (
                  <LinkItem key={link.id} link={link} reportId={report.id} />
                ))}
              </ul>
            )}
          </section>
        </DialogContent>
      </Dialog>
      {me.data && <UpgradeDialog details={planLimit} plan={me.data.plan} onClose={() => setPlanLimit(null)} />}
    </>
  );
}

function PersonalDataNotice() {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning-bg p-3">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
      <div className="space-y-1 text-sm">
        <p className="font-medium">{PERSONAL_DATA_NOTICE}</p>
        <p>{PERSONAL_DATA_CAVEAT}</p>
      </div>
    </div>
  );
}

function LinkItem({ link, reportId }: { link: ShareLink; reportId: ID }) {
  const revoke = useRevokeShareLink(reportId);
  const [confirm, setConfirm] = useState(false);
  const status = linkStatus(link);
  const details = [
    `Created ${formatDate(link.created_at)}`,
    link.expires_at ? `${status === 'expired' ? 'Expired' : 'Expires'} ${formatDate(link.expires_at)}` : 'No expiry',
    link.show_working ? 'Shows how answers were calculated' : 'Answers only',
    `Viewed ${formatNumber(link.view_count, 0)} ${link.view_count === 1 ? 'time' : 'times'}`,
  ];

  return (
    <li className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
            status === 'active' ? 'border-primary/40 bg-accent text-foreground' : 'bg-secondary text-muted-foreground',
          )}
        >
          {STATUS_WORDS[status]}
        </span>
        {link.contains_personal_data && <span className="text-xs font-medium text-foreground">May contain personal details</span>}
      </div>
      <p className="text-sm text-muted-foreground">{details.join(' · ')}</p>
      {status === 'active' && <CopyLinkField url={link.url} label={`Link created ${formatDate(link.created_at)}`} />}
      {status === 'active' &&
        (confirm ? (
          <div className="space-y-2 rounded-md border border-destructive/40 p-3">
            <p className="text-sm">Turn off this link? Anyone who opens it will see that it isn't available. This cannot be undone.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setConfirm(false)}>
                Keep it
              </Button>
              <Button
                variant="destructive"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(link.id, { onSuccess: () => setConfirm(false) })}
              >
                <Link2Off aria-hidden />
                Turn off
              </Button>
            </div>
            {revoke.isError && <FormMessage>{errorMessage(revoke.error)}</FormMessage>}
          </div>
        ) : (
          <Button variant="outline" className="text-destructive" onClick={() => setConfirm(true)}>
            <Link2Off aria-hidden />
            Turn off
          </Button>
        ))}
    </li>
  );
}

/** The link in a read-only field, with Copy. Without the clipboard API the field is selected for the user to copy. */
export function CopyLinkField({ url, label }: { url: string; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'manual'>('idle');
  const fieldId = useId();

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      setCopied('done');
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopied('manual');
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId} className="sr-only">
        {label}
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={inputRef}
          id={fieldId}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 w-full min-w-0 shrink-0 rounded-md border border-input bg-card px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-1"
        />
        <Button variant="outline" onClick={() => void copy()}>
          <Copy aria-hidden />
          Copy link
        </Button>
      </div>
      <p aria-live="polite" className="text-sm">
        {copied === 'done' ? 'Link copied.' : copied === 'manual' ? 'The link is selected: press Ctrl+C (or Cmd+C) to copy it.' : ''}
      </p>
    </div>
  );
}
