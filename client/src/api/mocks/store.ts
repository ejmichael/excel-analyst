import { newMockUser, type MockUser } from './data';

/**
 * In-memory mock "database" and session. Mirrored to sessionStorage (best effort) so a page reload in
 * mock mode keeps you signed in; it never touches Supabase or the network.
 */
interface MockState {
  users: Record<string, MockUser>; // by lower-case email
  sessionEmail: string | null;
}

const STORAGE_KEY = 'analyst.mock-state';

function load(): MockState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as MockState;
  } catch {
    // ignore: start empty
  }
  return { users: {}, sessionEmail: null };
}

let state: MockState = load();

function persist(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore: state stays in memory only
  }
}

export const mockStore = {
  findUser(email: string): MockUser | undefined {
    return state.users[email.trim().toLowerCase()];
  },
  createUser(email: string, password: string): MockUser {
    const user = newMockUser(email.trim().toLowerCase(), password);
    state.users[user.email] = user;
    persist();
    return user;
  },
  userByToken(token: string | null): MockUser | undefined {
    if (!token?.startsWith('mock-token:')) return undefined;
    const email = token.slice('mock-token:'.length);
    return state.sessionEmail === email ? state.users[email] : undefined;
  },
  tokenFor(user: MockUser): string {
    return `mock-token:${user.email}`;
  },
  get sessionEmail(): string | null {
    return state.sessionEmail;
  },
  setSession(email: string | null): void {
    state.sessionEmail = email;
    persist();
  },
  /** Call after mutating a user in place. */
  save(): void {
    persist();
  },
  reset(): void {
    state = { users: {}, sessionEmail: null };
    persist();
  },
};
