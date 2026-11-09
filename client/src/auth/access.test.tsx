import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { configureApiClient } from '@/api/client';
import { mockAuthBackend } from '@/api/mocks/auth';
import { mockTransport, setMockLatency } from '@/api/mocks/handlers';
import { mockStore } from '@/api/mocks/store';
import { routes } from '@/routes';
import { decideAccess } from './access';
import { SessionProvider } from './SessionProvider';

describe('decideAccess', () => {
  it('sends a visitor without a session to /sign-in', () => {
    expect(decideAccess('app', { session: 'none', consent: 'loading' })).toEqual({ kind: 'redirect', to: '/sign-in' });
    expect(decideAccess('consent', { session: 'none', consent: 'loading' })).toEqual({ kind: 'redirect', to: '/sign-in' });
  });

  it('sends a signed-in user without consent to /consent', () => {
    expect(decideAccess('app', { session: 'present', consent: 'missing' })).toEqual({ kind: 'redirect', to: '/consent' });
    expect(decideAccess('consent', { session: 'present', consent: 'missing' })).toEqual({ kind: 'allow' });
  });

  it('lets a consented user into the app and away from /consent', () => {
    expect(decideAccess('app', { session: 'present', consent: 'accepted' })).toEqual({ kind: 'allow' });
    expect(decideAccess('consent', { session: 'present', consent: 'accepted' })).toEqual({ kind: 'redirect', to: '/' });
  });

  it('waits while the session or Me is loading', () => {
    expect(decideAccess('app', { session: 'loading', consent: 'loading' })).toEqual({ kind: 'wait' });
    expect(decideAccess('app', { session: 'present', consent: 'loading' })).toEqual({ kind: 'wait' });
  });

  it('keeps signed-in users off the signed-out pages', () => {
    expect(decideAccess('public', { session: 'present', consent: 'loading' })).toEqual({ kind: 'redirect', to: '/' });
    expect(decideAccess('public', { session: 'none', consent: 'loading' })).toEqual({ kind: 'allow' });
  });
});

describe('route guards (rendered, mock mode)', () => {
  beforeEach(() => {
    setMockLatency(0);
    mockStore.reset();
    configureApiClient({ transport: mockTransport });
  });

  function renderAt(path: string) {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider backend={mockAuthBackend}>
          <RouterProvider router={router} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    return router;
  }

  it('unauthenticated: /settings goes to /sign-in', async () => {
    const router = renderAt('/settings');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('unconsented: /settings goes to /consent', async () => {
    await mockAuthBackend.signIn('owner@example.co.za', 'password123');
    const router = renderAt('/settings');
    expect(await screen.findByRole('heading', { name: 'Before you start' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/consent');
  });

  it('consented: /settings opens, and /consent sends you back into the app', async () => {
    await mockAuthBackend.signIn('owner@example.co.za', 'password123');
    const user = mockStore.findUser('owner@example.co.za');
    if (!user) throw new Error('mock user missing');
    user.popia_consent_at = '2026-11-02T09:00:00+02:00';

    const router = renderAt('/consent');
    expect(await screen.findByRole('heading', { name: 'Datasets' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/datasets');

    await router.navigate('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });
});
