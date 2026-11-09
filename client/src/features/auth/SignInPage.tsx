import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useLocation } from 'react-router';
import { authErrorMessage } from '@/auth/backend';
import { useSession } from '@/auth/SessionProvider';
import { FormMessage, PasswordField, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { AuthLayout, TextLink } from './AuthLayout';
import { signInSchema } from './schemas';

export function SignInPage() {
  const { backend } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);
  const notice = (location.state as { notice?: string } | null)?.notice;
  const form = useForm({ resolver: zodResolver(signInSchema), defaultValues: { email: '', password: '' } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setFormError(null);
    try {
      await backend.signIn(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/', { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  });

  return (
    <AuthLayout
      title="Sign in"
      footer={
        <>
          New here? <TextLink to="/sign-up">Create an account</TextLink>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        <FormMessage>{formError}</FormMessage>
        <TextField label="Email" type="email" autoComplete="email" error={errors.email?.message} {...form.register('email')} />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...form.register('password')}
        />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
        <div className="text-center text-sm">
          <TextLink to="/forgot-password">Forgot your password?</TextLink>
        </div>
      </form>
    </AuthLayout>
  );
}
