/** What the app needs from an auth provider. Supabase in real mode, an in-memory fake in mock mode. */
export interface AuthSession {
  access_token: string;
  email: string;
}

export type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY' | 'OTHER';

export interface AuthBackend {
  readonly isMock: boolean;
  getSession(): Promise<AuthSession | null>;
  /** Forces a token refresh; null if the session is gone. */
  refreshSession(): Promise<AuthSession | null>;
  onChange(listener: (session: AuthSession | null, event: AuthEvent) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  /** Returns null when the provider needs the address confirmed before a session exists. */
  signUp(email: string, password: string): Promise<AuthSession | null>;
  resendConfirmation(email: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  signOut(): Promise<void>;
}

/** An auth failure with a message that is safe and useful to show. */
export class AuthFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthFailure';
  }
}

export const GENERIC_AUTH_ERROR = 'Something went wrong. Please try again.';

export function authErrorMessage(error: unknown): string {
  return error instanceof AuthFailure ? error.message : GENERIC_AUTH_ERROR;
}
