import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ImageUp, Lock, Trash2 } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import { deleteLogo, uploadLogo } from '@/api/reports';
import type { Me, PlanLimitDetails } from '@/api/types';
import { meKey, useMe, useUpdateMe } from '@/auth/useMe';
import { FieldError, FormMessage, TextField } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog, type LocalPlanLimit } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
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
import { env } from '@/env';
import { contrastGuidance, isHexColour } from '@/lib/color';
import { formatPercent } from '@/lib/format';
import { PageHeader } from '@/features/shell/pages';
import { ReportHeader } from '@/features/reports/ReportHeader';
import { LOGO_ACCEPT, checkLogoFile } from './logoValidation';

export const NO_BRANDING = "Your plan doesn't include branding.";
const BRANDING_LIMIT: LocalPlanLimit = { limit_key: 'branding', limit: 0, used: 0 };

export function BrandSettingsPage() {
  const me = useMe();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/settings" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline">
        <ArrowLeft className="size-4" aria-hidden />
        Settings
      </Link>
      <PageHeader title="Your brand" description="How your reports look: your business name, colour and logo." />
      {me.data ? <BrandForm me={me.data} /> : <InlineLoading />}
    </div>
  );
}

function BrandForm({ me }: { me: Me }) {
  const id = useId();
  const queryClient = useQueryClient();
  const updateMe = useUpdateMe();
  const branding = me.limits.branding;
  const [name, setName] = useState(me.business_name ?? '');
  const [colour, setColour] = useState(me.brand.color);
  const [nameState, setNameState] = useState<{ error?: string; saved?: boolean }>({});
  const [colourState, setColourState] = useState<{ error?: string; saved?: boolean }>({});
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | LocalPlanLimit | null>(null);

  useEffect(() => setColour(me.brand.color), [me.brand.color]);

  const colourValid = isHexColour(colour);
  // The preview shows exactly what the report page draws, with the values being edited.
  const previewBrand = { business_name: name.trim() || null, logo_url: me.brand.logo_url, color: colourValid ? colour.toUpperCase() : me.brand.color };

  const saveName = () => {
    const value = name.trim();
    if (value.length > 120) return setNameState({ error: 'Keep the business name to 120 characters or fewer.' });
    setNameState({});
    updateMe.mutate(
      { business_name: value || null },
      {
        onSuccess: () => setNameState({ saved: true }),
        onError: (error) => setNameState({ error: (isApiError(error) && error.fieldErrors.business_name) || errorMessage(error) }),
      },
    );
  };

  const saveColour = () => {
    if (!colourValid) return setColourState({ error: 'Enter a colour as # and six letters or digits, for example #1E7A5F.' });
    setColourState({});
    updateMe.mutate(
      { brand_color: colour.toUpperCase() },
      {
        onSuccess: () => setColourState({ saved: true }),
        onError: (error) => {
          if (isApiError(error) && error.planLimit) return setPlanLimit(error.planLimit);
          setColourState({ error: (isApiError(error) && error.fieldErrors.brand_color) || errorMessage(error) });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby={`${id}-preview`} className="space-y-2">
        <h2 id={`${id}-preview`} className="text-lg font-semibold">
          Preview
        </h2>
        <ReportHeader brand={previewBrand} title="Your report title" subtitle="A subtitle, if you add one" periodLabel="October 2026" headingLevel={2} />
      </section>

      <section aria-labelledby={`${id}-name`} className="space-y-3 rounded-xl border bg-card p-5">
        <h2 id={`${id}-name`} className="text-lg font-semibold">
          Business name
        </h2>
        <TextField
          label="Business name"
          value={name}
          maxLength={120}
          hint="Shown in your report header. Leave empty to show none."
          error={nameState.error}
          onChange={(e) => {
            setName(e.target.value);
            setNameState({});
          }}
        />
        <div className="flex items-center gap-3">
          <Button onClick={saveName} disabled={updateMe.isPending || name.trim() === (me.business_name ?? '')}>
            Save business name
          </Button>
          {nameState.saved && <p className="text-sm" role="status">Saved.</p>}
        </div>
      </section>

      {!branding && (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-5 sm:flex-row sm:items-center">
          <Lock className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="flex-1">{NO_BRANDING} You can still set your business name.</p>
          <Button variant="outline" onClick={() => setPlanLimit(BRANDING_LIMIT)}>
            Upgrade
          </Button>
        </div>
      )}

      <section aria-labelledby={`${id}-colour`} className="space-y-3 rounded-xl border bg-card p-5">
        <h2 id={`${id}-colour`} className="text-lg font-semibold">
          Brand colour
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`${id}-hex`}>Colour code</Label>
            <Input
              id={`${id}-hex`}
              value={colour}
              maxLength={7}
              disabled={!branding}
              aria-invalid={colourState.error ? true : undefined}
              aria-describedby={`${id}-guidance`}
              onChange={(e) => {
                setColour(e.target.value.trim());
                setColourState({});
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-swatch`}>Pick a colour</Label>
            <input
              id={`${id}-swatch`}
              type="color"
              value={colourValid ? colour : me.brand.color}
              disabled={!branding}
              onChange={(e) => {
                setColour(e.target.value.toUpperCase());
                setColourState({});
              }}
              className="block h-11 w-20 cursor-pointer rounded-md border border-input bg-card p-1 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        </div>
        <p id={`${id}-guidance`} className="text-sm">
          {colourValid ? contrastGuidance(colour) : 'Enter a colour as # and six letters or digits, for example #1E7A5F.'}
        </p>
        <FieldError message={colourState.error} />
        <div className="flex items-center gap-3">
          <Button onClick={saveColour} disabled={!branding || updateMe.isPending || colour.toUpperCase() === me.brand.color.toUpperCase()}>
            Save colour
          </Button>
          {colourState.saved && <p className="text-sm" role="status">Saved.</p>}
        </div>
      </section>

      <LogoSection me={me} branding={branding} onPlanLimit={setPlanLimit} onChanged={() => void queryClient.invalidateQueries({ queryKey: meKey })} />

      {me.plan === 'free' && (
        <p className="text-sm text-muted-foreground">
          Reports on your plan end with a quiet “Made with {env.appName}” line. Paid plans remove it.
        </p>
      )}

      <UpgradeDialog details={planLimit} plan={me.plan} onClose={() => setPlanLimit(null)} />
    </div>
  );
}

function LogoSection({
  me,
  branding,
  onPlanLimit,
  onChanged,
}: {
  me: Me;
  branding: boolean;
  onPlanLimit: (d: PlanLimitDetails) => void;
  onChanged: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => () => controller.current?.abort(), []);

  const upload = async (file: File) => {
    const problem = checkLogoFile(file);
    if (problem) return setMessage({ tone: 'error', text: problem });
    setMessage(null);
    const abort = new AbortController();
    controller.current = abort;
    setProgress(0);
    try {
      await uploadLogo(file, { signal: abort.signal, onProgress: setProgress });
      setMessage({ tone: 'success', text: 'Your logo is saved.' });
      onChanged();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return setMessage({ tone: 'error', text: 'Upload cancelled. Your previous logo is unchanged.' });
      if (isApiError(error) && error.planLimit) return onPlanLimit(error.planLimit);
      // 415, 413 and 422 explain exactly what is wrong with the image (type, size, dimensions).
      const specific = isApiError(error) && ['file_unsupported', 'file_too_large', 'validation_failed'].includes(error.code);
      setMessage({ tone: 'error', text: specific && isApiError(error) ? (error.serverMessage ?? error.message) : errorMessage(error) });
    } finally {
      controller.current = null;
      setProgress(null);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await deleteLogo();
      setConfirmRemove(false);
      setMessage({ tone: 'success', text: 'Your logo is removed.' });
      onChanged();
    } catch (error) {
      if (isApiError(error) && error.planLimit) {
        setConfirmRemove(false);
        return onPlanLimit(error.planLimit);
      }
      setMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-logo`} className="space-y-3 rounded-xl border bg-card p-5">
      <h2 id={`${id}-logo`} className="text-lg font-semibold">
        Logo
      </h2>
      <p className="text-sm text-muted-foreground">A PNG, JPEG or WebP image of 1 MB or less. SVG and GIF are not accepted.</p>
      {progress !== null ? (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span id={`${id}-progress`}>Uploading your logo</span>
            <span className="tabular" aria-hidden>
              {formatPercent(progress, 0)}
            </span>
          </div>
          <div
            role="progressbar"
            aria-labelledby={`${id}-progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-valuetext={formatPercent(progress, 0)}
            className="h-2.5 overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} />
          </div>
          <Button variant="outline" onClick={() => controller.current?.abort()}>
            Cancel upload
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!branding} onClick={() => inputRef.current?.click()}>
            <ImageUp aria-hidden />
            {me.brand.logo_url ? 'Replace the logo' : 'Upload a logo'}
          </Button>
          {me.brand.logo_url && (
            <Button variant="outline" className="text-destructive" disabled={!branding} onClick={() => setConfirmRemove(true)}>
              <Trash2 aria-hidden />
              Remove the logo
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
        </div>
      )}
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}

      <Dialog open={confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Remove your logo?</DialogTitle>
            <DialogDescription>Your reports will show no logo until you upload one again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={removing} onClick={() => void remove()}>
              {removing ? 'Removing…' : 'Remove the logo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
