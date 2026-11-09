# PART 1 (SERVER): Foundation, accounts, workspaces

You are the **server engineer** for Analyst OS (slice S0). A second Claude Code chat is building `client/` in parallel against the same API contract.
This repo's root is the folder you were started in (`analyze/`). You work **only** in `server/`, `db/migrations/` and `docs/STATUS.md` (leave the Client column of its slices table to the client chat).
This prompt covers **Part 1 only**. Do not start anything from later parts, even if you can see it in the docs.

## Read first (only these, in this order)
1. `CLAUDE.md` (rules, conventions, security rules, ownership)
2. `docs/API_CONTRACT.md`: the status/error table, the System, Me and Workspaces tables, and the business rules for Consent, Plan limits, Rate limits, CORS
3. `docs/api-types.ts` (copy it verbatim to `server/src/types/api.ts`)
4. `db/schema.sql`: `plan_limits`, `profiles`, `workspaces`, `report_templates`, `subscriptions`, `usage_events`, the `owner_usage_month` view and the RLS section
5. `docs/KEYS_AND_SERVICES.md` (env vars) and `server/.env.example`
Then reply with 6 bullets saying what you understood (include: who may write to which tables, the 404-not-403 rule, and what "allowed before consent" means). Then start.

## Pre-flight (do this before writing code; stop and tell me exactly what is missing)
- `server/.env` exists and has values for `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLIENT_URL`, `PORT`, `NODE_ENV`, `APP_NAME`. (Anthropic, PayFast, cron and storage values may be empty for now; do not make them required yet.)
- `db/schema.sql` has been run: using the service-role client, `plan_limits` must return 4 rows (`free`, `solo`, `practice`, `practice_plus`).
- Node is 20 or newer; the folder is a git repo (if not, tell me; do not run `git init` yourself).

## Build exactly this
**Scaffold** `server/`: TypeScript strict, Express, `zod`, `@supabase/supabase-js`, `helmet`, `cors`, `express-rate-limit`, `pino` + `pino-http`, `dotenv`; dev tools `tsx`, `typescript`, `vitest`, `supertest`. Scripts: `dev` (tsx watch), `build`, `start`, `typecheck`, `test` (unit, no network), `test:integration` (needs the real Supabase project). Check each package is current and maintained before adding it. Do not install DuckDB, Anthropic, exceljs, multer or anything else; later parts add them.

**Structure** (create only what this part needs):
```
server/src/
  index.ts  app.ts
  config/env.ts            zod-validated env, fail fast with a readable message
  lib/supabase.ts          supabaseAdmin (service role) and supabaseForUser(token) (anon key + user JWT, for reads)
  lib/errors.ts            AppError(code, status, message, details?) using only ErrorCode values from api-types
  middleware/auth.ts       Bearer token -> supabaseAdmin.auth.getUser(token) -> req.auth = { userId, token }
  middleware/consent.ts    403 consent_required unless profiles.popia_consent_at is set
  middleware/validate.ts   zod parse of body/query/params, strict (unknown fields rejected), 422 validation_failed with field errors in details
  middleware/error.ts      one handler producing the exact ApiError shape; also a JSON 404 for unknown routes
  middleware/rateLimit.ts  300 per minute per user (fall back to IP before auth); returns 429 rate_limited with Retry-After
  routes/health.ts  routes/me.ts  routes/workspaces.ts
  services/limits.ts       assertWithinLimit(userId, key) for every LimitKey in api-types (see below)
  services/usage.ts        usage for the current SAST month
  services/dates.ts        monthStartSast() -> 'YYYY-MM-DD' (Africa/Johannesburg, no DST)
  services/files.ts        deleteWorkspaceFiles(ownerId, workspaceId): an empty stub for now, called when a workspace is deleted. Part 2 fills it in. Note it in STATUS.md
  types/api.ts             verbatim copy of docs/api-types.ts
```

**Endpoints** (exact paths, shapes and codes from the contract; nothing else):
- `GET /api/v1/health`: no auth, `{ data: { status: 'ok', time } }`.
- `GET /api/v1/me`: allowed before consent. Build `Me` from `profiles` + the `plan_limits` row for the user's plan + usage + subscription. `usage.month_start` = first day of the current SAST month; `uploads`, `questions`, `reports`, `report_runs`, `exports` from `owner_usage_month` (zeros when there is no row); `workspaces` and `templates` are current row counts. `brand`: `business_name`, `logo_url: null` for now (logos arrive in Part 4), `color` from `profiles.brand_color`. `consent_accepted` = `popia_consent_at is not null`. `subscription`: `null` when there is no row or its status is `none`.
- `PATCH /api/v1/me`: allowed before consent. Strict body = `UpdateMeRequest`. `full_name` and `business_name`: trimmed, 1 to 120 characters, or null. `brand_color`: `#RRGGBB`; if the plan's `branding` flag is false return 402 `plan_limit` with `PlanLimitDetails` (`upgrade_to` = the cheapest plan that allows it). `accept_terms: true` sets `popia_consent_at = now()` only if it is still null (calling it twice is harmless). An empty body is a 422. Returns the full updated `Me`.
- `GET /api/v1/workspaces`: caller's workspaces, default first, then oldest first.
- `POST /api/v1/workspaces`: `CreateWorkspaceRequest` (name 1 to 80, trimmed); enforce `max_workspaces` (402 `plan_limit` with correct `limit`, `used`, `upgrade_to`); 201.
- `PATCH /api/v1/workspaces/:id`: rename. Someone else's id is 404.
- `DELETE /api/v1/workspaces/:id`: 409 `conflict` if `is_default`; 404 if not the caller's; otherwise call `deleteWorkspaceFiles`, delete the row (database cascades do the rest) and return `{ deleted: true }`.
All responses are wrapped `{ data }` and errors use the contract's shape. Every route except `/health` needs auth; every route except `GET /me`, `PATCH /me` and `/health` needs consent.

**Rules for the data layer** (from `CLAUDE.md`, restated because they are easy to break):
- READS use `supabaseForUser(token)` so RLS protects tenants even if a route has a bug. WRITES use `supabaseAdmin`, and every write and every service-role read is filtered by `owner_id = req.auth.userId`. The schema deliberately gives users no write policies, so plan limits cannot be bypassed through Supabase's own REST API.
- Cross-user ids are 404, never 403.
- Never log tokens, keys, request bodies or emails. Log ids, status codes and timings (`pino-http` with `authorization` redacted).
- CORS allows only `CLIENT_URL`. JSON body limit 100 KB. `helmet` on.

**`assertWithinLimit(userId, key)`**: build it for all LimitKeys now, because later parts call it. Counted limits (`max_workspaces`, `max_templates`) compare the current row count with the limit; monthly limits (`max_datasets_per_month`, `max_questions_per_month`, `max_reports_per_month`) compare this SAST month's `usage_events` count; per-file limits (`max_rows`, `max_file_mb`) take a value to compare; feature flags (`branding`, `share_links`) throw when false with `limit: 0`. It throws the 402 `plan_limit` error with `PlanLimitDetails`. In this part only `max_workspaces` and `branding` are used; unit-test the rest with a mocked data source.

## Tests (required)
- Unit (`npm test`, no network): `monthStartSast` including around midnight at month boundaries (SAST is UTC+2: 22:30 UTC on the last day is already the 1st), error-shape mapping, zod strictness (unknown field rejected), `assertWithinLimit` for each kind of key, consent middleware.
- Integration (`npm run test:integration`, real Supabase): create two test users with `supabaseAdmin.auth.admin.createUser` (emails like `test+<random>@example.com`), sign in with the anon key to get tokens, and **always delete the users in `afterAll`** (the delete cascades to profiles and workspaces). Assert: `/health` works; `/me` without a token is 401; a new user has a profile and one default workspace; `/workspaces` before consent is 403 `consent_required` but `/me` works; `PATCH /me { accept_terms: true }` then `/workspaces` works; creating a second workspace on `free` is 402 with the right `details`; `PATCH /me { brand_color }` on `free` is 402; user B gets 404 on user A's workspace (rename and delete); deleting the default workspace is 409; unknown fields are 422; a user cannot change their own `plan` by calling Supabase's REST API with their own token (attempt a direct `update` with the user client and assert nothing changed).

## Finish
1. Write `server/README.md`: setup, env, run, tests, and a `curl` example for every endpoint (explain how to get a test token).
2. Update `docs/STATUS.md`: mark Part 1 endpoints `DONE` **only after** the tests pass; set the Part 1 server cell to `DONE`; add anything the client needs to know under "Backend notes for the frontend" (rename to your wording; keep the section).
3. Run `npm run typecheck`, `npm test` and `npm run test:integration`; fix everything.
4. Commit: `Part 1 (server): foundation, auth, consent, workspaces`.
5. Tell me: what you built, the exact commands to start the server and run the tests, anything you could not verify, any ambiguity in the contract (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing), and what I should check by hand.

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts` or `docs/LLM_PROMPTS.md`; touch `client/` or `fixtures/`; add features from later parts; put a secret in any committed file.
