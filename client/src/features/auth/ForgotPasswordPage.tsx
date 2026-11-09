import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { authErrorMessage } from '@/auth/backend';
import { useSession } from '@/auth/SessionProvider';
import { FormMessage, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { AuthLayout, TextLink } from './AuthLayout';
import { forgotSchema } from './schemas';

export function ForgotPasswordPage() {
  const { backend } = useSession();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(forgotSchema), defaultValues: { email: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setFormError(null);
    try {
      await backend.sendPasswordReset(email);
      setSentTo(email);
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  });

  return (
    <AuthLayout
      title="Reset your password"
      intro={sentTo ? undefined : 'Enter the email you signed up with and we will send you a link to choose a new password.'}
      footer={<TextLink to="/sign-in">Back to sign in</TextLink>}
    >
      {sentTo ? (
        <FormMessage tone="success">
          If an account exists for {sentTo}, we have sent it a link to reset the password. The link works once.
        </FormMessage>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <FormMessage>{formError}</FormMessage>
          <TextField label="Email" type="email" autoComplete="email" error={errors.email?.message} {...form.register('email')} />
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send the reset link'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
