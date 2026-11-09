import { Navigate, Outlet, useLocation } from 'react-router';
import { errorMessage } from '@/api/client';
import { FullPageError, FullPageLoading } from '@/components/PageStatus';
import { decideAccess, type AccessState, type Area } from './access';
import { useSession } from './SessionProvider';
import { useMe } from './useMe';

function useAccessState(): { state: AccessState; meError: unknown; retry: () => void } {
  const { status, session } = useSession();
  const me = useMe();
  const sessionState: AccessState['session'] = status === 'loading' ? 'loading' : session ? 'present' : 'none';
  const consent: AccessState['consent'] = me.data ? (me.data.consent_accepted ? 'accepted' : 'missing') : 'loading';
  return { state: { session: sessionState, consent }, meError: me.isError ? me.error : null, retry: () => void me.refetch() };
}

function Guard({ area }: { area: Area }) {
  const location = useLocation();
  const { state, meError, retry } = useAccessState();

  // A 401 is handled globally (sign out, go to /sign-in); anything else gets a retry screen instead of a loop.
  if (area !== 'public' && state.session === 'present' && state.consent === 'loading' && meError) {
    return <FullPageError message={errorMessage(meError)} onRetry={retry} />;
  }

  const decision = decideAccess(area, state);
  if (decision.kind === 'wait') return <FullPageLoading />;
  if (decision.kind === 'redirect') {
    const from = (location.state as { from?: string } | null)?.from;
    const target = area === 'public' && from ? from : decision.to;
    const state = decision.to === '/sign-in' ? { from: location.pathname + location.search } : undefined;
    return <Navigate to={target} replace state={state} />;
  }
  return <Outlet />;
}

/** Signed in and consented. */
export function RequireApp() {
  return <Guard area="app" />;
}

/** Signed in, consent not yet given. */
export function RequireConsentPending() {
  return <Guard area="consent" />;
}

/** Signed out only (sign in, sign up, forgot password). */
export function PublicOnly() {
  return <Guard area="public" />;
}
