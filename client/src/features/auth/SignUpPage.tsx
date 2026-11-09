import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router';
import { MailCheck } from 'lucide-react';
import { authErrorMessage } from '@/auth/backend';
import { useSession } from '@/auth/SessionProvider';
import { FormMessage, PasswordField, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { AuthLayout, TextLink } from './AuthLayout';
import { signUpSchema } from './schemas';

export function SignUpPage() {
  const { backend } = useSession();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(signUpSchema), defaultValues: { email: '', password: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setFormError(null);
    try {
      const session = await backend.signUp(email, password);
      // Supabase may require email confirmation, in which case there is no session yet.
      if (session) navigate('/', { replace: true });
      else setPendingEmail(email);
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  });

  if (pendingEmail) return <CheckEmail email={pendingEmail} />;

  return (
    <AuthLayout
      title="Create your account"
      intro="Upload a spreadsheet, ask questions in plain English, and get answers you can check."
      footer={
        <>
          Already have an account? <TextLink to="/sign-in">Sign in</TextLink>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <FormMessage>{formError}</FormMessage>
        <TextField label="Email" type="email" autoComplete="email" error={errors.email?.message} {...form.register('email')} />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Creating your account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}

function CheckEmail({ email }: { email: string }) {
  const { backend } = useSession();
  const [state, setState] = useState<{ status: 'idle' | 'sending' | 'sent' } | { status: 'error'; message: string }>({
    status: 'idle',
  });

  const resend = async () => {
    setState({ status: 'sending' });
    try {
      await backend.resendConfirmation(email);
      setState({ status: 'sent' });
    } catch (error) {
      setState({ status: 'error', message: authErrorMessage(error) });
    }
  };

  return (
    <AuthLayout title="Check your email to confirm your address">
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p>
            We sent a confirmation link to <strong className="break-all">{email}</strong>. Open it on this device to finish
            creating your account.
          </p>
        </div>
        {backend.isMock && (
          <FormMessage tone="info">Mock mode: the address counts as confirmed. Sign in to continue.</FormMessage>
        )}
        {state.status === 'sent' && <FormMessage tone="success">We sent the link again.</FormMessage>}
        {state.status === 'error' && <FormMessage>{state.message}</FormMessage>}
        <p className="text-sm text-muted-foreground">Nothing after a few minutes? Check your spam folder, or send it again.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={resend} disabled={state.status === 'sending'}>
            {state.status === 'sending' ? 'Sending…' : 'Resend the email'}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/sign-in">Go to sign in</Link>
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}
