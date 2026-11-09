import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { configureApiClient } from '@/api/client';
import { mockAuthBackend } from '@/api/mocks/auth';
import { mockTransport } from '@/api/mocks/handlers';
import { env } from '@/env';
import type { AuthBackend, AuthSession } from './backend';
import { supabaseBackend } from './supabaseBackend';

export const defaultBackend: AuthBackend = env.useMocks ? mockAuthBackend : supabaseBackend;
if (env.useMocks) configureApiClient({ transport: mockTransport });

interface SessionContextValue {
  status: 'loading' | 'ready';
  session: AuthSession | null;
  backend: AuthBackend;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children, backend = defaultBackend }: { children: ReactNode; backend?: AuthBackend }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    // The token is read fresh on every request so Supabase's refreshes are picked up.
    configureApiClient({
      getAccessToken: async () => (await backend.getSession())?.access_token ?? null,
      refreshAccessToken: async () => (await backend.refreshSession())?.access_token ?? null,
    });
    let active = true;
    void backend.getSession().then((initial) => {
      if (!active) return;
      setSession(initial);
      setStatus('ready');
    });
    const unsubscribe = backend.onChange((next, event) => {
      setSession(next);
      setStatus('ready');
      if (event === 'SIGNED_OUT') queryClient.clear();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [backend, queryClient]);

  const signOut = useCallback(async () => {
    await backend.signOut();
    setSession(null);
    queryClient.clear();
  }, [backend, queryClient]);

  const value = useMemo(() => ({ status, session, backend, signOut }), [status, session, backend, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
