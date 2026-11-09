/**
 * Route guard rules as a pure function, so they can be tested without rendering:
 * no session -> /sign-in; session but no consent -> /consent; consented -> the app.
 */
export type Area = 'app' | 'consent' | 'public';

export interface AccessState {
  session: 'loading' | 'none' | 'present';
  /** From Me.consent_accepted. 'loading' while GET /me is in flight. */
  consent: 'loading' | 'accepted' | 'missing';
}

export type AccessDecision = { kind: 'wait' } | { kind: 'allow' } | { kind: 'redirect'; to: string };

const wait: AccessDecision = { kind: 'wait' };
const allow: AccessDecision = { kind: 'allow' };
const to = (path: string): AccessDecision => ({ kind: 'redirect', to: path });

export function decideAccess(area: Area, state: AccessState): AccessDecision {
  if (state.session === 'loading') return wait;

  if (area === 'public') return state.session === 'present' ? to('/') : allow;

  if (state.session === 'none') return to('/sign-in');
  if (state.consent === 'loading') return wait;

  if (area === 'consent') return state.consent === 'accepted' ? to('/') : allow;
  return state.consent === 'accepted' ? allow : to('/consent');
}
