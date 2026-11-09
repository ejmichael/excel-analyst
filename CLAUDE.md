# Analyst OS: Project Rules (read first, every session)

Working name: "Analyst" (set the display name with `APP_NAME` / `VITE_APP_NAME`; do not hard-code it).

## What this is
A web app where a small-business owner, freelancer or bookkeeper uploads a CSV or Excel file, asks questions in plain
English, and gets answers they can check: a table, a chart, two or three sentences of explanation, and a
"How this was calculated" panel. Answers can be pinned into a branded report, exported (PDF, XLSX, CSV), shared by link,
and saved as a template that re-runs on next month's file with month-on-month changes.
Prices are in ZAR. Users are in South Africa. See `docs/PRODUCT_BRIEF.md` for the why and `docs/ARCHITECTURE.md` for the how.

## Monorepo layout
```
analyze/                    <- the repo root; open both Claude Code chats here
  CLAUDE.md                 <- this file
  server/                   <- Express + TypeScript API        (SERVER chat owns this)
  client/                   <- React + Vite + TypeScript app   (CLIENT chat owns this)
  db/schema.sql             <- base schema (already written, run in the Supabase SQL editor)
  db/migrations/            <- additive SQL migrations (server chat writes these)
  docs/PRODUCT_BRIEF.md     <- what and why, scope, pricing hypotheses
  docs/ARCHITECTURE.md      <- how answers are produced and why the numbers can be trusted
  docs/API_CONTRACT.md      <- endpoint list, flows, business rules (SOURCE OF TRUTH)
  docs/api-types.ts         <- request/response types (SOURCE OF TRUTH)
  docs/LLM_PROMPTS.md       <- the prompts and JSON schemas for the Claude calls
  docs/STATUS.md            <- server marks endpoints "done"; client reads it
  docs/CONTRACT_CHANGES.md  <- proposed contract changes, awaiting the user's approval
  docs/KEYS_AND_SERVICES.md <- accounts, keys, env vars
  fixtures/                 <- SYNTHETIC test files with SA-style formats + expected.json (shared, read-only)
  scripts/make-fixtures.mjs <- regenerates the fixtures deterministically
  prompts/                  <- the kickoff prompts for each chat
```

## Stack
- **Supabase**: Postgres (metadata), Auth (JWTs), Storage (private buckets `datasets` and `branding`). No Africa region is listed in Supabase's documentation; pick the nearest (London or Frankfurt) and disclose it.
- **Server**: Node 20+, Express, TypeScript (strict), zod, `@anthropic-ai/sdk`, DuckDB (in-process, for the SQL sandbox),
  `csv-parse`, `exceljs`, `jschardet` (or similar) for encoding detection, `pino`.
- **Client**: React 18 + Vite + TypeScript, Tailwind + shadcn/ui, TanStack Query, React Router, Recharts.
- **Hosting**: Vercel (client), Render or Railway (server, at least 1 GB RAM because DuckDB runs in the process).
- Payments (slice S6 only): PayFast card subscriptions.

## Ownership rules (two chats work in parallel)
1. The SERVER chat edits only `server/`, `db/migrations/`, and `docs/STATUS.md`.
2. The CLIENT chat edits only `client/`, plus the **Client** column of the slices table in `docs/STATUS.md` (nothing else in that file).
3. Neither chat edits `docs/API_CONTRACT.md`, `docs/api-types.ts` or `docs/LLM_PROMPTS.md` unless the user explicitly says so.
   If you need a new endpoint, field, shape or prompt change: append a dated entry to `docs/CONTRACT_CHANGES.md`
   (what, why, proposed shape), STOP, and tell the user. Do not improvise.
4. Never invent endpoints, fields, enum values or error codes that are not in the contract.
5. Copy `docs/api-types.ts` verbatim into your project (`server/src/types/api.ts`, `client/src/api/types.ts`).
   If the two copies ever differ, the docs version wins.
6. `fixtures/` is read-only for both chats. Regenerate with `node scripts/make-fixtures.mjs` only if the user asks.

## The three product rules (these are the product; never trade them away)
1. **Numbers come from queries, never from the model.** Claude writes SQL; DuckDB runs it; the narrative may contain a
   number only as a token (`{{r0.revenue}}`) that the server replaces from the result rows. No arithmetic in prose.
2. **Show your working.** Every block carries its SQL, its checks (read-only, numbers resolved, totals reconcile,
   not truncated) and a way to see the source rows. A failed check shows a visible warning, never a silent pass.
3. **The model never receives the whole file.** It sees the schema, at most 5 masked sample rows, and the (capped, masked)
   result rows of the query it wrote. See `docs/ARCHITECTURE.md` section 5.

## Conventions (both sides)
- JSON keys are **snake_case**, identical to DB columns. No camelCase mapping layer.
- Success body is always `{ "data": ... }`. Errors are always `{ "error": { "code", "message", "details?" } }`.
  Only file downloads (`export.xlsx`, `export.csv`) and the PayFast ITN webhook are exceptions (see the contract).
- Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 with offset. IDs are UUID strings.
- Money is a plain number in ZAR with 2 decimals. Display with `Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' })`.
  Numbers display with `en-ZA` grouping and a decimal comma. VAT is 15%; never assume whether a column includes VAT
  (`vat_included` is `null` until the user says).
- "This month" and all date logic use **Africa/Johannesburg** (SAST, no DST). Weeks start Monday.
- TypeScript `strict: true`. No `any` without a comment explaining why.
- LLM model names come from env (`ANTHROPIC_MODEL_PLANNER`, `ANTHROPIC_MODEL_FAST`), never hard-coded in code paths.

## Security rules (non-negotiable)
- The Supabase **service-role key lives only in the server** `.env`. Never in the client, never in git, never logged.
  The Anthropic key is server-only too.
- `.env` files are gitignored. Only `.env.example` files are committed.
- A user must never see another user's data. A request for a row owned by someone else returns **404**, not 403.
- Validate every body, query and param with zod. Reject unknown fields. Max body size for JSON 100 KB.
- The SQL sandbox rules in `docs/ARCHITECTURE.md` section 4 are mandatory, including the escape-attempt tests.
- Never log file contents, sample rows, SQL results, tokens or keys. Log ids, sizes, timings and token counts only.
- Uploaded files go to a **private** bucket and are only reachable through the server.
- Rate-limit public endpoints (`/public/*`, billing webhook) and `ask` (per user).
- Personal information: the user must accept the terms and privacy notice (`popia_consent_at`) before any upload.

## Out of scope for the MVP (do not build; keep code modular)
Live connectors (Xero, Sage, Shopify API, bank feeds), joining several files, forecasting or ML models, scheduled refresh,
provider-specific parsers (they need real files first), PowerPoint export, WhatsApp delivery, team seats and comments,
a mobile app, Excel formula generation.

## How the two chats stay in sync: slices
Work is cut into numbered slices S0 to S6 (both prompts use the same numbering).
1. Server finishes slice N, tests it, marks the endpoints `DONE` in `docs/STATUS.md`, tells the user.
2. Client starts slice N only for endpoints marked `DONE` (otherwise it builds against typed mocks behind
   `VITE_USE_MOCKS=true` so it is never blocked).
3. At the end of each slice, say what to test manually and how.
4. Commit after every working slice with a clear message.
S0 to S4 is the sellable core. S5 (templates) and S6 (plans and billing) follow once real users upload files.

## Final contract check (slice S6)
- Server: list every registered route and compare with the endpoint tables in `docs/API_CONTRACT.md`.
- Client: list every API call in `client/src/api/` and compare with the same tables.
- Report any mismatch to the user. Do not "fix" it by editing the contract yourself.
