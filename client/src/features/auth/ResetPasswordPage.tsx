import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router';
import { authErrorMessage } from '@/auth/backend';
import { useSession } from '@/auth/SessionProvider';
import { FullPageLoading } from '@/components/PageStatus';
import { FormMessage, PasswordField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { AuthLayout, TextLink } from './AuthLayout';
import { resetSchema } from './schemas';

/** Supabase's recovery email links here with a one-time session; we then set the new password. */
export function ResetPasswordPage() {
  const { status, session, backend } = useSession();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(resetSchema), defaultValues: { password: '', confirm: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ password }) => {
    setFormError(null);
    try {
      await backend.updatePassword(password);
      navigate('/', { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  });

  if (status === 'loading') return <FullPageLoading />;

  if (!session) {
    return (
      <AuthLayout title="This link has expired" footer={<TextLink to="/sign-in">Back to sign in</TextLink>}>
        <div className="space-y-4">
          <p>Password reset links work once and expire after a while. Ask for a new one and use it straight away.</p>
          <Button asChild className="w-full">
            <Link to="/forgot-password">Send a new link</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" intro={<>For {session.email}.</>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <FormMessage>{formError}</FormMessage>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={errors.password?.message}
          {...form.register('password')}
        />
        <PasswordField
          label="Repeat the new password"
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...form.register('confirm')}
        />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save the new password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
