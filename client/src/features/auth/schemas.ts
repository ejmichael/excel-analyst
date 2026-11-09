import { z } from 'zod';

export const emailSchema = z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.'));

export const newPasswordSchema = z.string().min(8, 'Use at least 8 characters.').max(72, 'Use at most 72 characters.');

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
});

export const signUpSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
});

export const forgotSchema = z.object({ email: emailSchema });

export const resetSchema = z
  .object({ password: newPasswordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The two passwords do not match.' });
