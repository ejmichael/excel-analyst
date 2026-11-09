# Build status

Owned by the SERVER chat. The CLIENT chat reads it: build against real endpoints only when marked `DONE`; otherwise use mocks.
Mark `DONE` only after the endpoint has been run and tested. Values: `TODO`, `WIP`, `DONE`, `BLOCKED (reason)`.

## Slices
| Slice | Scope | Server | Client |
|---|---|---|---|
| S0 | Foundation, auth, consent, workspaces, me | DONE | DONE |
| S1 | Upload, parse, profile, preview | TODO | DONE (mocks; server S1 not DONE yet) |
| S2 | Ask, verify, source rows | TODO | TODO |
| S3 | Reports and branding | TODO | TODO |
| S4 | Export and share | TODO | TODO |
| S5 | Templates and re-runs | TODO | TODO |
| S6 | Plans, billing, hardening, handover | TODO | TODO |

## Endpoints (server)
| Slice | Endpoint | Status |
|---|---|---|
| S0 | GET `/health` | DONE |
| S0 | GET `/me` | DONE |
| S0 | PATCH `/me` | DONE |
| S0 | GET `/workspaces` | DONE |
| S0 | POST `/workspaces` | DONE |
| S0 | PATCH `/workspaces/:id` | DONE |
| S0 | DELETE `/workspaces/:id` | DONE |
| S1 | POST `/datasets` | TODO |
| S1 | GET `/datasets` | TODO |
| S1 | GET `/datasets/:id` | TODO |
| S1 | PATCH `/datasets/:id` | TODO |
| S1 | POST `/datasets/:id/reparse` | TODO |
| S1 | GET `/datasets/:id/preview` | TODO |
| S1 | DELETE `/datasets/:id` | TODO |
| S1 | POST `/internal/purge-expired` | TODO |
| S2 | POST `/datasets/:id/ask` | TODO |
| S2 | GET `/datasets/:id/blocks` | TODO |
| S2 | GET `/blocks/:id` | TODO |
| S2 | GET `/blocks/:id/source-rows` | TODO |
| S2 | GET `/blocks/:id/export.csv` | TODO |
| S2 | POST `/blocks/:id/feedback` | TODO |
| S2 | DELETE `/blocks/:id` | TODO |
| S3 | GET `/reports` | TODO |
| S3 | POST `/reports` | TODO |
| S3 | GET `/reports/:id` | TODO |
| S3 | PATCH `/reports/:id` | TODO |
| S3 | DELETE `/reports/:id` | TODO |
| S3 | POST `/me/logo` | TODO |
| S3 | DELETE `/me/logo` | TODO |
| S4 | GET `/reports/:id/export.xlsx` | TODO |
| S4 | GET `/reports/:id/share-links` | TODO |
| S4 | POST `/reports/:id/share-links` | TODO |
| S4 | DELETE `/share-links/:id` | TODO |
| S4 | GET `/public/reports/:token` | TODO |
| S5 | POST `/reports/:id/save-as-template` | TODO |
| S5 | GET `/templates` | TODO |
| S5 | GET `/templates/:id` | TODO |
| S5 | PATCH `/templates/:id` | TODO |
| S5 | DELETE `/templates/:id` | TODO |
| S5 | POST `/templates/:id/run` | TODO |
| S5 | GET `/runs/:id` | TODO |
| S5 | GET `/templates/:id/runs` | TODO |
| S6 | GET `/billing/plans` | TODO |
| S6 | GET `/billing/subscription` | TODO |
| S6 | POST `/billing/checkout` | TODO |
| S6 | POST `/billing/payfast/itn` | TODO |
| S6 | POST `/billing/cancel` | TODO |
| S6 | DELETE `/me` | TODO |

## Measured numbers (server fills in during S2)
- Average input and output tokens per question: _not measured yet_
- Average cost per question (USD, ZAR): _not measured yet_
- Median and slowest ask latency: _not measured yet_

## Server notes for the client
- **S0 (2026-11-09).** Base URL `http://localhost:4000/api/v1`. CORS allows only `CLIENT_URL` (default `http://localhost:5173`).
- **Supabase keys.** The project uses the new publishable/secret keys. `VITE_SUPABASE_ANON_KEY` takes the publishable key (`sb_publishable_...`); supabase-js treats it like the old anon key.
- **Bootstrap.** Call `GET /me` right after sign-in. The profile and the default workspace ("My workspace") already exist (DB trigger), so there is no "create profile" step. If `consent_accepted` is false, route to the consent screen. Every call other than `GET /me` and `PATCH /me` returns 403 `consent_required` until `PATCH /me { accept_terms: true }`.
- **`PATCH /me`** returns the full `Me`. An empty body is 422. `full_name` and `business_name` are trimmed, 1 to 120 characters, and `null` clears them. Sending `accept_terms: true` again is harmless (the first timestamp is kept); `accept_terms: false` is 422.
- **Brand colour.** On `free`, `brand_color` is 402 `plan_limit` with `{ limit_key: 'branding', limit: 0, used: 0, upgrade_to: 'solo' }`, and nothing in that request is saved, including other fields sent alongside it. `brand.logo_url` is always `null` until S3.
- **Workspaces.** The list is ordered default first, then oldest first. A second workspace on `free` is 402 with `{ limit_key: 'max_workspaces', limit: 1, used: 1, upgrade_to: 'practice' }` (`solo` also allows only 1). Deleting the default workspace is 409 `conflict`. Another user's id, or a malformed id, is 404.
- **422 `validation_failed`.** `details` is `{ fields: Array<{ location: 'body' | 'query' | 'params', path: string, message: string }> }`. `path` is the dotted field path (e.g. `name`), and empty for whole-object errors. Map it to form fields with `location === 'body'`. Unknown fields are always rejected. Malformed JSON and bodies over 100 KB are also 422 `validation_failed` (no `details`).
- **429 `rate_limited`** carries a `Retry-After` header in seconds. The limit is 300 per minute per user.
- **401 `unauthorized`.** Expired tokens get this too. Refresh the Supabase session and retry once before signing out.

## Known issues and decisions
- **2026-11-09 (S0): oversized and malformed JSON.** These answer 422 `validation_failed`. 413 `file_too_large` is reserved for uploads in the contract, and no other code fits.
- **2026-11-09 (S0): malformed ids.** A malformed UUID in a route id answers 404 `not_found` instead of 422, because it can never match a row.
- **2026-11-09 (S0): concurrent workspace creates.** `assertWithinLimit` checks a count and then the insert happens. Two simultaneous `POST /workspaces` calls could both pass on the last free slot. This is acceptable for the MVP; a DB-side check can be added if it matters.
- **2026-11-09 (S0): rate-limit counters are in memory**, per server process. They reset on restart and are not shared across instances. Fine for one instance.
- **2026-11-09 (S0): `deleteWorkspaceFiles(ownerId, workspaceId)`** (`server/src/services/files.ts`) is an empty stub. Part 2 must fill it in. It runs before the workspace row is deleted, because the cascade removes the dataset rows that hold the storage paths.
- **Open for S5: which event counts against `max_reports_per_month` for template runs.** The limit currently counts `usage_events.kind = 'report'` only. Flow D says template runs count against `max_reports_per_month`, so a run must also write a `report` event, or the counter must include `report_run`. Decide in S5; it does not affect S0.
