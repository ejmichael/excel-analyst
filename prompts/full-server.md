# SERVER CHAT: Analyst OS API (FULL REFERENCE, all slices)
> Reference only. Do not paste this whole file into a chat; paste the prompt for the current part (`prompts/part-N-server.md`).

You are the server engineer for **Analyst OS**, a web app where South African small-business owners upload a CSV or Excel file, ask
questions in plain English and get answers they can check. A second Claude Code chat is building `client/` in parallel against the
SAME API contract. Your job is to implement that contract exactly, one slice at a time.

## Read first, in this order
1. `CLAUDE.md` (rules, the three product rules, conventions, ownership)
2. `docs/ARCHITECTURE.md` (how an upload and a question work; the SQL sandbox; privacy; parsing)
3. `docs/API_CONTRACT.md` (routes, flows, business rules)
4. `docs/api-types.ts` (exact request/response shapes)
5. `docs/LLM_PROMPTS.md` (prompts and tool schemas for the three Claude calls)
6. `db/schema.sql` (database; RLS included) and `docs/KEYS_AND_SERVICES.md` (env vars)
7. `fixtures/README.md` and `fixtures/expected.json` (synthetic test files with South African formatting and the expected parse results)
Then confirm in 6 bullets what you understood (include the three product rules), and start slice S0.

## You own
`server/`, `db/migrations/`, `docs/STATUS.md`. Nothing else. If the contract needs to change, follow rule 3 in CLAUDE.md
(write it in `docs/CONTRACT_CHANGES.md`, stop, tell the user).

## Stack
Node 20+, Express, TypeScript (strict), `zod`, `@supabase/supabase-js`, `@anthropic-ai/sdk`, DuckDB (verify the current Node package,
at the time of writing `@duckdb/node-api`), `csv-parse`, `exceljs`, `multer` (memory storage with a size limit) or `busboy`, `jschardet`
or `chardet`, `helmet`, `cors`, `express-rate-limit`, `pino` + `pino-http`, `dotenv`, `vitest` + `supertest`. Dev runner `tsx watch`, build `tsc`.
Port from `PORT` (default 4000). All routes under `/api/v1`. Check each package is current and maintained before adding it; tell the user if you substitute one.

## Suggested structure
```
server/
  src/
    index.ts  app.ts
    config/env.ts  config/prices.ts           # zod env; per-million-token prices (copy from the provider's pricing page)
    lib/supabase.ts                           # supabaseAdmin (service role) + supabaseForUser(token) (anon key + user JWT, for READS)
    lib/storage.ts                            # private bucket helpers, signed URLs
    middleware/                               # auth.ts, requireConsent.ts, validate.ts, error.ts, rateLimit.ts
    routes/                                   # health, me, workspaces, datasets, blocks, reports, share, templates, billing, internal, public
    services/limits.ts  usage.ts  dates.ts    # plan limits, usage events, SAST helpers
    services/parsing/                         # encoding, delimiter, header row, numbers, dates, xlsx, normalise, profile, pii
    services/sandbox/                         # duckdb loader, validator, executor, reconcile
    services/analysis/                        # plan.ts, narrate.ts, tokens.ts, checks.ts, ask.ts
    services/reports.ts  exports.ts  templates.ts  billing/payfast.ts
    llm/client.ts  llm/prompts/               # Anthropic client, forced tool calls, zod-validated outputs, cost logging
    types/api.ts                              # verbatim copy of docs/api-types.ts
  scripts/                                    # ask-cli.ts, seed-demo.ts
  tests/
  .env.example  package.json  tsconfig.json
```

## Architecture rules
- **Auth:** read the Bearer token, verify with `supabaseAdmin.auth.getUser(token)`, attach `req.auth = { userId, token }`. Then load the profile and enforce consent.
- **Reads vs writes:** READS use `supabaseForUser(token)` so RLS protects tenants even if a route has a bug. WRITES use `supabaseAdmin` (the schema grants users no write policies on purpose, so plan limits and usage cannot be bypassed through the Supabase REST API) and **every write and every service-role read is filtered by `owner_id = req.auth.userId`**. Cross-user ids return 404.
- **Validation:** zod for every body, query and param, strict. 422 `validation_failed` with field errors in `details`.
- **Errors:** one error middleware producing the exact `ApiError` shape. No stack traces, no raw Supabase or Anthropic errors, no file content in messages.
- **Responses:** always `{ data }`, except file downloads and the PayFast ITN.
- **Limits:** one `assertWithinLimit(userId, key)` helper used by every route that the contract lists a limit for. Write the usage event only after success.
- **Jobs:** profiling and template runs are in-process async jobs. Mark stale `profiling` datasets and `running` runs as `failed` at boot.
- **Logging:** pino. Never log file contents, rows, SQL results, prompts, tokens or keys.

## Slices (the client chat uses the same numbering)

### S0: Foundation
Scaffold, env validation (fail fast), `app.ts`/`index.ts`, helmet, CORS (only `CLIENT_URL`), JSON limit 100 KB, pino-http, error middleware, rate-limit helper,
auth middleware, consent middleware, `supabase.ts`, `limits.ts`, `usage.ts`, `dates.ts` (SAST month start). Routes: `GET /health`, `GET /me`, `PATCH /me` (names, brand_color, accept_terms),
workspaces (list, create, rename, delete). Scripts: `dev`, `build`, `start`, `test`.
Done when: `/health` works, `/me` is 401 without a token, a new Supabase user gets a profile and default workspace from the DB trigger, `PATCH /me { accept_terms: true }` sets consent, and a user on `free` cannot create a second workspace (402 with the right `details`). Tell the user to run `db/schema.sql` first.

### S1: Upload, parse, profile
`POST /datasets`, `GET /datasets`, `GET /datasets/:id`, `PATCH /datasets/:id`, `POST /datasets/:id/reparse`, `GET /datasets/:id/preview`, `DELETE /datasets/:id`, and `POST /internal/purge-expired`.
Implement the pipeline in ARCHITECTURE sections 2 and 6 and the PII rules in section 5. The suggestions call (LLM_PROMPTS 1) runs at the end of profiling; if it fails, profiling still succeeds with empty suggestions.
Write tests that run the pipeline over every file in `fixtures/` and assert the values in `fixtures/expected.json` (header row, delimiter, decimal separator, date order, row count, excluded rows, sums of the money columns, PII flags).
Done when: all fixtures profile correctly with no manual options, a wrong guess can be fixed through `/reparse`, a 6 MB file on `free` is refused with 402 `max_file_mb`, and deleting a dataset removes both files.

### S2: Ask, verify, source rows
`POST /datasets/:id/ask`, `GET /datasets/:id/blocks`, `GET /blocks/:id`, `GET /blocks/:id/source-rows`, `GET /blocks/:id/export.csv`, `POST /blocks/:id/feedback`, `DELETE /blocks/:id`.
Implement the sandbox (ARCHITECTURE 4), planner, repair, narrator, token renderer, checks and reconcile exactly as specified (ARCHITECTURE 3, LLM_PROMPTS, API_CONTRACT business rules). Log every LLM call to `usage_events`.
Write `scripts/ask-cli.ts <fixture> "<question>"` that profiles a fixture locally and prints the block, so the logic can be tested without the client.
**Required tests:** all the sandbox escape attempts listed in ARCHITECTURE 4 (none may read a file, change state or crash the server; the runaway query must time out); token rendering and the free-standing-number check; reconcile pass and fail; PII masking in prompts (assert the prompt text built for a PII column contains the placeholder and not the value); a mocked-LLM test for the whole ask flow.
Done when: for each fixture you can ask at least three questions through `ask-cli` and get blocks whose figures match a hand-computed value, `total_reconciles` passes for a grouped sum, and the escape tests pass. Report the average cost and token counts per question from `usage_events`.

### S3: Reports and branding
`GET/POST /reports`, `GET/PATCH/DELETE /reports/:id`, `POST/DELETE /me/logo`, brand in `Me` and `ReportDetail` (signed logo URL), `watermark` flag. Enforce `max_reports_per_month`, `branding`.
Done when: a report can be created from pinned blocks, reordered with PATCH, shows the owner's logo and colour on a paid plan, `watermark` is true on `free`, and deleting a pinned block is refused with 409.

### S4: Export and share
`GET /reports/:id/export.xlsx` (exceljs, spec in API_CONTRACT "Exports"), share links (create, list, revoke), `GET /public/reports/:token` with the redaction rules, rate limits.
Done when: the XLSX opens in Excel and LibreOffice with real numbers and dates (not text), a revoked or expired link returns 404, and `show_working: false` really strips SQL and checks from the JSON.

### S5: Templates and re-runs
Templates (save-as-template, list, get, rename, delete), `POST /templates/:id/run`, `GET /runs/:id`, `GET /templates/:id/runs`, comparison logic, `schema_mismatch` handling (Flow D).
Done when: a report from the October fixture saved as a template re-runs on a November variant file (create one by editing a copy of a fixture in a test) and returns month-on-month `comparison`, and a file with a renamed column fails with `schema_mismatch` listing it.

### S6: Plans, billing, hardening, handover
- Billing endpoints (Flow E) with PayFast sandbox; ITN verification exactly as listed (signature, IP range, server validation, amount, idempotency). Check PayFast's current documentation first; ask the user for sandbox credentials.
- `DELETE /me` (full erasure including storage), `GET /billing/plans`, `POST /billing/cancel`.
- Tests: tenant isolation (two users; user A gets 404 on B's dataset, block, report, template, share link), plan-limit enforcement for every limit in the contract, ITN rejection of a bad signature and a wrong amount, the public-report redaction, retention purge.
- `scripts/seed-demo.ts`: one demo user on `solo`, the three fixtures uploaded, a handful of blocks asked, one report and one template. Idempotent or clearly resets.
- `server/README.md`: setup, env, run, test, curl examples per slice, Render notes (build/start commands, env vars, at least 1 GB RAM, health check `/api/v1/health`).
- Run the **final contract check** (registered routes vs the contract tables) and report mismatches. Update `docs/STATUS.md` fully.

## Working agreement
- After each slice: run it, test it, update `docs/STATUS.md` (mark `DONE` only after testing), commit, then tell the user: what changed, how to test it, and anything the client chat needs to know (add it to "Server notes for the client" in STATUS.md).
- If the contract is ambiguous or wrong, STOP and write it in `docs/CONTRACT_CHANGES.md`. Do not guess.
- Keep it simple. No extra features, no premature abstractions, no new services. Do not claim support for any named bank, card machine or accounting product.
