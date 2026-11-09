import { AuthFailure, type AuthBackend, type AuthEvent, type AuthSession } from '@/auth/backend';
import { mockStore } from './store';

/**
 * Fake auth for VITE_USE_MOCKS=true. Bypasses Supabase completely.
 * - Sign in: any email with a password of 8+ characters. An unknown email gets a new account.
 * - Sign up: creates the account and, like Supabase with confirmation on, returns no session.
 */
type Listener = (session: AuthSession | null, event: AuthEvent) => void;
const listeners = new Set<Listener>();

function current(): AuthSession | null {
  const email = mockStore.sessionEmail;
  const user = email ? mockStore.findUser(email) : undefined;
  return user ? { access_token: mockStore.tokenFor(user), email: user.email } : null;
}

function emit(event: AuthEvent): void {
  const session = current();
  listeners.forEach((listener) => listener(session, event));
}

export const mockAuthBackend: AuthBackend = {
  isMock: true,
  async getSession() {
    return current();
  },
  async refreshSession() {
    return current();
  },
  onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async signIn(email, password) {
    if (password.length < 8) throw new AuthFailure('That email and password do not match.');
    const user = mockStore.findUser(email) ?? mockStore.createUser(email, password);
    if (user.password !== password) throw new AuthFailure('That email and password do not match.');
    mockStore.setSession(user.email);
    emit('SIGNED_IN');
  },
  async signUp(email, password) {
    if (mockStore.findUser(email)) throw new AuthFailure('An account with this email already exists. Try signing in.');
    mockStore.createUser(email, password);
    return null;
  },
  async resendConfirmation() {},
  async sendPasswordReset() {},
  async updatePassword(password) {
    const email = mockStore.sessionEmail;
    const user = email ? mockStore.findUser(email) : undefined;
    if (!user) throw new AuthFailure('This link has expired. Request a new one.');
    user.password = password;
    mockStore.save();
  },
  async signOut() {
    mockStore.setSession(null);
    emit('SIGNED_OUT');
  },
};
