import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { configureApiClient } from '@/api/client';
import { useSession } from './SessionProvider';
import { meKey } from './useMe';

/** Wires apiFetch's global reactions to the router: 401 signs out, consent_required goes to /consent. */
export function ApiEventBridge() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { signOut } = useSession();

  useEffect(() => {
    configureApiClient({
      onUnauthorized: () => {
        void signOut().finally(() => navigate('/sign-in', { replace: true }));
      },
      onConsentRequired: () => {
        void queryClient.invalidateQueries({ queryKey: meKey });
        navigate('/consent', { replace: true });
      },
    });
  }, [navigate, queryClient, signOut]);

  return null;
}
