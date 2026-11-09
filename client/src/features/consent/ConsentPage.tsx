import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { ExternalLink } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { useSession } from '@/auth/SessionProvider';
import { useUpdateMe } from '@/auth/useMe';
import { FormMessage } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { AuthLayout } from '@/features/auth/AuthLayout';

function NewTabLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 font-medium text-primary underline underline-offset-4"
    >
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function ConsentPage() {
  const checkboxId = useId();
  const navigate = useNavigate();
  const { signOut } = useSession();
  const updateMe = useUpdateMe();
  const [accepted, setAccepted] = useState(false);

  const submit = () => {
    updateMe.mutate({ accept_terms: true }, { onSuccess: () => navigate('/', { replace: true }) });
  };

  return (
    <AuthLayout title="Before you start">
      <div className="space-y-5">
        <div className="space-y-3">
          <p>
            We store your account details, the files you upload, and the answers and reports you make from them, so you
            can come back to them later.
          </p>
          <p>
            To answer your questions, parts of your files (the column names, a few masked sample rows and the results of
            each calculation) are processed by an AI provider, and the service is hosted outside South Africa.
          </p>
        </div>

        <div className="flex min-h-11 items-start gap-3 rounded-md border bg-background px-3 py-3">
          <Checkbox
            id={checkboxId}
            checked={accepted}
            onCheckedChange={(value) => setAccepted(value === true)}
            className="mt-0.5"
          />
          <label htmlFor={checkboxId} className="cursor-pointer leading-snug">
            I accept the <NewTabLink href="/terms">Terms of use</NewTabLink> and the{' '}
            <NewTabLink href="/privacy">Privacy notice</NewTabLink>
          </label>
        </div>

        {updateMe.isError && <FormMessage>{errorMessage(updateMe.error)}</FormMessage>}

        <div className="space-y-2">
          <Button className="w-full" disabled={!accepted || updateMe.isPending} onClick={submit}>
            {updateMe.isPending ? 'Saving…' : 'Accept and continue'}
          </Button>
          {!accepted && (
            <p className="text-center text-sm text-muted-foreground">Tick the box above to continue.</p>
          )}
        </div>

        <div className="text-center">
          <Button variant="link" onClick={() => void signOut().then(() => navigate('/sign-in', { replace: true }))}>
            Not now, sign out
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}
