import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { errorMessage, isApiError } from '@/api/client';
import type { Me } from '@/api/types';
import { useUpdateMe } from '@/auth/useMe';
import { FormMessage, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PLAN_LABELS } from '@/lib/errors';

// Same bounds as the API (1 to 120 characters); an empty box clears the value.
const nameField = z.string().trim().max(120, 'Use at most 120 characters.');
const profileSchema = z.object({ full_name: nameField, business_name: nameField });
type ProfileValues = z.infer<typeof profileSchema>;

const toValues = (me: Me): ProfileValues => ({ full_name: me.full_name ?? '', business_name: me.business_name ?? '' });

export function ProfileSection({ me }: { me: Me }) {
  const updateMe = useUpdateMe();
  const [saved, setSaved] = useState(false);
  const form = useForm<ProfileValues>({ resolver: zodResolver(profileSchema), defaultValues: toValues(me) });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (!isDirty) form.reset(toValues(me));
  }, [me, isDirty, form]);

  const onSubmit = form.handleSubmit((values) => {
    setSaved(false);
    updateMe.mutate(
      { full_name: values.full_name || null, business_name: values.business_name || null },
      {
        onSuccess: (next) => {
          form.reset(toValues(next));
          setSaved(true);
        },
        onError: (error) => {
          if (!isApiError(error)) return;
          for (const [path, message] of Object.entries(error.fieldErrors)) {
            if (path === 'full_name' || path === 'business_name') form.setError(path, { message });
          }
        },
      },
    );
  });

  const generalError =
    updateMe.isError && !(isApiError(updateMe.error) && Object.keys(updateMe.error.fieldErrors).length > 0)
      ? errorMessage(updateMe.error)
      : null;

  return (
    <section aria-labelledby="profile-heading" className="rounded-xl border bg-card p-5 sm:p-6">
      <h2 id="profile-heading" className="text-xl font-semibold">
        Profile
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Your business name appears on your reports.</p>

      <form onSubmit={onSubmit} noValidate className="mt-5 grid gap-4 sm:grid-cols-2">
        <TextField label="Full name" autoComplete="name" error={errors.full_name?.message} {...form.register('full_name')} />
        <TextField
          label="Business name"
          autoComplete="organization"
          error={errors.business_name?.message}
          {...form.register('business_name')}
        />
        <ReadOnlyField label="Email" value={me.email} hint="Your sign-in address. It cannot be changed here." />
        <ReadOnlyField label="Current plan" value={PLAN_LABELS[me.plan]} />

        <div className="space-y-3 sm:col-span-2">
          {generalError && <FormMessage>{generalError}</FormMessage>}
          {saved && !isDirty && <FormMessage tone="success">Profile saved.</FormMessage>}
          <Button type="submit" disabled={updateMe.isPending || !isDirty}>
            {updateMe.isPending ? 'Saving…' : 'Save profile'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ReadOnlyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const id = `ro-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        readOnly
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="h-11 w-full rounded-md border border-dashed bg-secondary px-3 text-base text-foreground md:text-sm"
      />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
