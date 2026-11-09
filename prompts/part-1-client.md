# PART 1 (CLIENT): Accounts, consent, app shell, workspaces

You are the **client engineer** for Analyst OS (slice S0). A second Claude Code chat is building `server/` in parallel against the same API contract.
This repo's root is the folder you were started in (`analyze/`). You work **only** in `client/`.
This prompt covers **Part 1 only**. Do not build upload, ask, reports, billing or anything from later parts, even if you can see it in the docs.

## Read first (only these, in this order)
1. `CLAUDE.md` (rules, conventions, ownership)
2. `docs/PRODUCT_BRIEF.md` (who it is for; keep it in mind for tone)
3. `docs/API_CONTRACT.md`: the status/error table, the Me and Workspaces tables, the Consent and Plan limits business rules
4. `docs/api-types.ts` (copy it verbatim to `client/src/api/types.ts`)
5. `docs/STATUS.md` (which endpoints are `DONE`) and `client/.env.example`
Then reply with 6 bullets saying what you understood (include: the three product rules, where consent is enforced, and that you must not call anything that is not in the contract). Then start.

## Look and feel
Match the landing page: warm off-white background `#F6F5F0`, ink `#16231F`, accent `#1E7A5F` (a theme token, so it can change), white cards with 1px `#D9D8CE` borders and 16px radius, **Space Grotesk** for headings, **Inter** for body, tabular figures for numbers. Light theme only. Calm and trustworthy, no gradients, no emoji, no animation libraries. Icons: `lucide-react`. Every control has a visible label, a visible focus ring and a touch target of at least 44px. Errors and warnings are always written in words, never colour alone. Works at phone width (390px) for every screen in this part.

## Pre-flight
- `client/.env` exists (copy `.env.example`): `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_NAME`, `VITE_USE_MOCKS`.
- If the Supabase values are empty, set `VITE_USE_MOCKS=true` and build in mock mode, and tell me at the end that real sign-in is untested.
- Node is 20 or newer.

## Build exactly this
**Scaffold** `client/`: Vite + React 18 + TypeScript (strict), Tailwind, shadcn/ui, React Router, TanStack Query, `@supabase/supabase-js` (auth only; all data goes through our API), `react-hook-form` + `zod`, `lucide-react`; dev tools `vitest` + Testing Library. Check each package is current. Do not install a chart library yet.

**Structure:**
```
client/src/
  main.tsx  App.tsx  routes.tsx
  api/types.ts            verbatim copy of docs/api-types.ts
  api/client.ts           apiFetch<T>: adds the Supabase access token, unwraps { data }, throws a typed ApiError; downloads come later
  api/me.ts  api/workspaces.ts     one function per endpoint, typed
  api/mocks/              typed mock data and handlers used when VITE_USE_MOCKS=true
  auth/                   session provider, route guards
  features/auth/  features/consent/  features/shell/  features/settings/  features/workspaces/
  components/ui/          shadcn components
  lib/format.ts           formatZar, formatNumber, formatPercent (fraction in, one decimal), formatDate ('2 November 2026'); all en-ZA
```

**Pages and routes:**
- Public: `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` (the page Supabase's recovery email links to; sets a new password with `supabase.auth.updateUser`), `/terms` and `/privacy` (clearly marked placeholder pages: "Terms of use, draft to be supplied"), and `*` (404 page).
- `/consent` (signed in, consent not yet given): explains in two sentences what is stored and that files are processed by an AI provider and hosted outside South Africa, a checkbox "I accept the Terms of use and the Privacy notice" (links open in a new tab), a primary button that calls `PATCH /me { accept_terms: true }`, then goes to the app. The button is disabled until the box is ticked.
- App shell (signed in and consented): left sidebar with **Datasets**, **Reports**, **Templates**, **Settings**; on a phone it collapses behind a menu button. Top bar: workspace switcher, plan badge (from `Me.plan`), user menu with Sign out. Datasets, Reports and Templates are simple placeholder pages ("Coming in the next part") so the navigation can be seen.
- `/settings`: **Profile** (full name, business name, read-only email, current plan) saved with `PATCH /me`; **Workspaces** (list, rename, create, delete non-default ones with a confirm dialog); the delete-account area and billing are NOT in this part.
- **Sign up:** email + password (minimum 8 characters, show/hide toggle). Supabase may require email confirmation: if sign-up returns no session, show a "Check your email to confirm your address" screen with a resend button; do not assume a session exists.
- **Route guard rules:** no session -> `/sign-in`; session but `Me.consent_accepted` false -> `/consent`; any API response with code `consent_required` -> `/consent`; any 401 -> sign out and go to `/sign-in`.
- **Workspaces:** the active workspace id is kept in React state and remembered in `localStorage` wrapped in try/catch (it is a per-viewer convenience; the app must work without it). Default to the workspace with `is_default`. If the stored id no longer exists, fall back to the default.
- **`plan_limit` (402):** a reusable `UpgradeDialog` that reads `PlanLimitDetails` and says in plain words what was hit (for example "Your Free plan includes 1 workspace. You are using 1."), names `upgrade_to` when present, and has a disabled "See plans" button with the note "Plans open soon." Used when creating a workspace on Free and when a brand colour is refused (the brand-colour control is not in this part, but the dialog must handle it).
- **Error handling:** every API error code in the contract is mapped to a readable message in one place (`api/client.ts` or `lib/errors.ts`). Forms show field errors from `validation_failed` `details` next to the field. A top-level error boundary shows a friendly screen with a reload button.
- **Mock mode** (`VITE_USE_MOCKS=true`): bypasses Supabase completely with a fake in-memory session so every screen can be seen with no keys and no server. Mocks must satisfy the types exactly and behave like the contract: consent gating, one default workspace, 402 on creating a second workspace on Free, 409 on deleting the default.
- **Real mode:** build against server endpoints **only when they are marked `DONE` in `docs/STATUS.md`**. If they are not yet done, keep using mock mode and say so. When they are, set `VITE_USE_MOCKS=false`, point `VITE_API_URL` at the server, and test the full flow against it.

## Tests (required)
- `lib/format.ts`: `formatZar(1234.5)` gives the en-ZA rand format (assert against `Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' })` output rather than a hard-coded string, because the space characters differ by runtime), `formatPercent(0.123)` is one decimal, dates read like `2 November 2026`.
- Route guard logic: unauthenticated, unconsented and consented cases go to the right place.
- `apiFetch`: unwraps `{ data }`, throws `ApiError` with `code` and `details`, maps `consent_required` and 401 as above.
- The upgrade dialog renders the right sentence for `max_workspaces` and for `branding`.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.
2. Walk through the whole flow yourself in mock mode (and in real mode if the server is `DONE`): sign up, confirm email (real mode), consent, land in the default workspace, edit profile, create a second workspace and see the upgrade dialog, rename a workspace, try to delete the default one, sign out and in again.
3. Update the Part 1 cell in the **Client** column of the slices table in `docs/STATUS.md`. Edit nothing else in that file (the server chat owns it).
4. Commit: `Part 1 (client): auth, consent, shell, workspaces`.
5. Tell me: what you built, the commands to run it, which mode you tested (mock or real), what I should click to test it by hand, and anything in the contract that seemed wrong or missing (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing).

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or anything outside `client/` (except the one STATUS cell above); put the Supabase service-role key or any secret in the client; build screens from later parts; claim anything on screen about POPIA compliance, security certifications or named integrations.
