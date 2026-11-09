import { createClient, type AuthError, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/env';
import { AuthFailure, type AuthBackend, type AuthSession } from './backend';

// Supabase is used for auth only. All data goes through our API.
// Created on first use so mock mode never needs (or touches) Supabase.
let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  client ??= createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

function toSession(session: Session | null): AuthSession | null {
  return session ? { access_token: session.access_token, email: session.user.email ?? '' } : null;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password do not match.',
  email_not_confirmed: 'Confirm your email address first. Check your inbox for the link.',
  user_already_exists: 'An account with this email already exists. Try signing in.',
  email_exists: 'An account with this email already exists. Try signing in.',
  weak_password: 'Choose a stronger password: at least 8 characters.',
  same_password: 'Choose a password that is different from your current one.',
  over_email_send_rate_limit: 'Too many emails sent. Wait a few minutes and try again.',
  over_request_rate_limit: 'Too many attempts. Wait a few minutes and try again.',
  session_not_found: 'This link has expired. Request a new one.',
  signup_disabled: 'New sign-ups are closed at the moment.',
};

function fail(error: AuthError): never {
  const message = (error.code && MESSAGES[error.code]) || 'Something went wrong. Please try again.';
  throw new AuthFailure(message);
}

const origin = () => window.location.origin;

export const supabaseBackend: AuthBackend = {
  isMock: false,
  async getSession() {
    const { data } = await sb().auth.getSession();
    return toSession(data.session);
  },
  async refreshSession() {
    const { data, error } = await sb().auth.refreshSession();
    return error ? null : toSession(data.session);
  },
  onChange(listener) {
    const { data } = sb().auth.onAuthStateChange((event, session) => {
      const mapped =
        event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'PASSWORD_RECOVERY' ? event : 'OTHER';
      listener(toSession(session), mapped);
    });
    return () => data.subscription.unsubscribe();
  },
  async signIn(email, password) {
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) fail(error);
  },
  async signUp(email, password) {
    const { data, error } = await sb().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${origin()}/` },
    });
    if (error) fail(error);
    return toSession(data.session);
  },
  async resendConfirmation(email) {
    const { error } = await sb().auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: `${origin()}/` },
    });
    if (error) fail(error);
  },
  async sendPasswordReset(email) {
    const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: `${origin()}/reset-password` });
    if (error) fail(error);
  },
  async updatePassword(password) {
    const { error } = await sb().auth.updateUser({ password });
    if (error) fail(error);
  },
  async signOut() {
    await sb().auth.signOut();
  },
};
