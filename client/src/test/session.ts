import type { AuthBackend } from '@/auth/backend';

/** A signed-in session for component tests that read Me through SessionProvider. */
export const signedIn: AuthBackend = {
  isMock: true,
  getSession: async () => ({ access_token: 't', email: 'owner@example.co.za' }),
  refreshSession: async () => ({ access_token: 't', email: 'owner@example.co.za' }),
  onChange: () => () => {},
  signIn: async () => {},
  signUp: async () => null,
  resendConfirmation: async () => {},
  sendPasswordReset: async () => {},
  updatePassword: async () => {},
  signOut: async () => {},
};
