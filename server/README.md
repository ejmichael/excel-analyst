# Analyst OS: server

Express + TypeScript API for Analyst OS. The contract is `docs/API_CONTRACT.md` and `docs/api-types.ts` (copied verbatim to `src/types/api.ts`). All routes live under `/api/v1`.

Part 1 (slice S0) covers health, `GET/PATCH /me`, and workspaces. Part 2 (slice S1) adds uploads, parsing and profiling, preview, retention, and the first LLM call (suggested questions).

## Setup

Requirements: Node 20 or newer, and a Supabase project with `db/schema.sql` already run and two private buckets (`datasets`, `branding`).

```bash
cd server
cp .env.example .env     # then fill it in (see below)
npm install
```

### Environment

| Variable | Required now | Notes |
|---|---|---|
| `PORT` | no (default `4000`) | |
| `NODE_ENV` | no (default `development`) | `development`, `test` or `production`. In `production` the app trusts one proxy hop for client IPs |
| `APP_NAME` | yes | display name |
| `CLIENT_URL` | yes | the only origin CORS allows, e.g. `http://localhost:5173` |
| `SUPABASE_URL` | yes | |
| `SUPABASE_ANON_KEY` | yes | the legacy anon JWT **or** the new publishable key (`sb_publishable_...`) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | the legacy service_role JWT **or** the new secret key (`sb_secret_...`). **Secret: server only, never logged** |
| `STORAGE_BUCKET_DATASETS`, `STORAGE_BUCKET_BRANDING` | no | defaults `datasets`, `branding` |
| `LLM_PROVIDER` | yes | `openrouter` or `anthropic` |
| `OPENROUTER_API_KEY` | when `LLM_PROVIDER=openrouter` | **Secret** |
| `ANTHROPIC_API_KEY` | when `LLM_PROVIDER=anthropic` | **Secret** |
| `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_PLANNER` | yes | model ids for the chosen provider (OpenRouter ids look like `anthropic/claude-haiku-5.5`). The fast model must accept a forced tool call; Claude Sonnet 5.5 does not (see `docs/CONTRACT_CHANGES.md`) |
| `CRON_SECRET` | for retention | long random string; while empty, `/internal/purge-expired` answers 404 |
| `MAX_UPLOAD_MB` | no (default `50`) | hard ceiling, at most 50 |
| PayFast | not yet | slice S6 |
| `LOG_LEVEL` | no | pino level, default `info` (`silent` under tests) |

The server refuses to start and lists the missing or invalid variable names if the environment is wrong. Values are never printed.

## Run

```bash
npm run dev          # tsx watch, http://localhost:4000
npm run build        # tsc to dist/
npm start            # node dist/index.js
```

## Tests

```bash
npm run typecheck
npm test                    # unit tests, no network
npm run test:integration    # real Supabase project from server/.env; the LLM is mocked
RUN_LLM_TESTS=1 npm run test:llm   # opt-in: real model, prints suggestions, tokens and cost
```

No test in `npm test` or `npm run test:integration` calls the real LLM. `test:llm` profiles the three non-ambiguous fixtures locally, sends each suggestions prompt to the configured provider, and prints the five questions with tokens and cost (about $0.0003 per file with Haiku 5.5). It writes nothing to the database. On Windows PowerShell: `$env:RUN_LLM_TESTS=1; npm run test:llm`.

Part 2's integration tests create four users (plans set directly in the database), upload the fixtures, and remove every storage object under each test user's folder before deleting the users. The retention test calls the real purge, so it also purges any other expired dataset in the same project.

The integration tests create two users named `test+<random>@example.com` with the admin API, sign in with the anon/publishable key, and delete both users in `afterAll`. Deleting a user cascades to its profile and workspaces. The tests change one test user's plan to `practice` directly in the database to exercise workspace creation.

## How the server talks to Supabase

- **Reads** use `supabaseForUser(token)`: the anon/publishable key plus the user's JWT, so RLS applies.
- **Writes** use `supabaseAdmin()` (service role), always filtered by `owner_id = req.auth.userId`. The schema gives users no write policies, so plans, consent and limits cannot be changed through Supabase's REST API with a user token.
- **Auth:** `Authorization: Bearer <access token>` is verified with `supabaseAdmin().auth.getUser(token)`.

## Getting a test token

Create a user. Either sign up in the client, or use the dashboard: Authentication > Users > Add user, with "Auto confirm" ticked. Then exchange the password for an access token. The token expires after an hour by default.

```bash
SUPABASE_URL=https://<project>.supabase.co
ANON=<SUPABASE_ANON_KEY>   # publishable key; never the secret key

TOKEN=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

API=http://localhost:4000/api/v1
```

## Endpoints (Part 1)

Every success is `{ "data": ... }`. Every error is `{ "error": { "code", "message", "details?" } }`.

```bash
# Health (no auth)
curl -s $API/health
# {"data":{"status":"ok","time":"2026-11-09T20:36:40.568Z"}}

# Me (allowed before consent)
curl -s $API/me -H "Authorization: Bearer $TOKEN"

# Accept the terms and privacy notice (sets popia_consent_at once; repeating is harmless)
curl -s -X PATCH $API/me -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"accept_terms":true}'

# Update names (trimmed, 1 to 120 characters, or null to clear)
curl -s -X PATCH $API/me -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Thandi Nkosi","business_name":"Nkosi Bakery"}'

# Brand colour (402 plan_limit on free)
curl -s -X PATCH $API/me -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"brand_color":"#AA3300"}'

# List workspaces (default first, then oldest first). 403 consent_required before consent
curl -s $API/workspaces -H "Authorization: Bearer $TOKEN"

# Create a workspace (201; 402 plan_limit when max_workspaces is reached)
curl -s -X POST $API/workspaces -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Client: Spaza"}'

# Rename (404 if it is not yours)
curl -s -X PATCH $API/workspaces/<id> -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Renamed"}'

# Delete (409 conflict for the default workspace; 404 if it is not yours)
curl -s -X DELETE $API/workspaces/<id> -H "Authorization: Bearer $TOKEN"
```

## Endpoints (Part 2): datasets

Uploads are `multipart/form-data` with `file`, `workspace_id` and an optional `name`. The type is decided from the file's bytes, not its name.

```bash
WS=<workspace id>

# Upload (201, status "profiling"; profiling continues in the background)
curl -s -X POST $API/datasets -H "Authorization: Bearer $TOKEN"   -F "workspace_id=$WS" -F "name=October card sales" -F "file=@../fixtures/01_card_sales_semicolon_win1252.csv"

# List a workspace's datasets, newest first
curl -s "$API/datasets?workspace_id=$WS&limit=20&offset=0" -H "Authorization: Bearer $TOKEN"

# Detail (poll every 1.5 s while status is "profiling")
curl -s $API/datasets/<id> -H "Authorization: Bearer $TOKEN"

# Rename, and edit columns (display_name, semantic, is_pii, vat_included)
curl -s -X PATCH $API/datasets/<id> -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"   -d '{"name":"Card sales","columns":[{"id":"<column id>","semantic":"currency_zar","vat_included":true}]}'

# Re-read with other options (202; only the fields you send override detection)
curl -s -X POST $API/datasets/<id>/reparse -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"   -d '{"date_format":"mdy"}'

# Preview the normalised rows (needs status "ready"; limit at most 200)
curl -s "$API/datasets/<id>/preview?limit=20" -H "Authorization: Bearer $TOKEN"

# Delete (both stored files and the row; answers keep their results)
curl -s -X DELETE $API/datasets/<id> -H "Authorization: Bearer $TOKEN"

# Retention job (cron). Wrong or missing secret: 401
curl -s -X POST $API/internal/purge-expired -H "x-cron-secret: $CRON_SECRET"
```

## How a file is read

`src/services/parsing/` is plain functions, unit-tested one by one:
- `content.ts` checks the type from the bytes.
- `encoding.ts` (UTF-8, else Windows-1252) and `delimiter.ts` read CSV text.
- `xlsx.ts` and `zip.ts` are a small streaming XLSX reader.
- `layout.ts` finds the header row and the footer/total rows.
- `numbers.ts` and `dates.ts` parse South African amounts and dates.
- `infer.ts` decides column types and meanings; `pii.ts` does PII detection and masking; `headers.ts` and `reservedWords.ts` make the `sql_name`s.
- `pipeline.ts` ties these together: two streaming passes, then the normalised CSV and the stats.

`services/profiling.ts` runs at most two jobs at a time (the rest wait in memory, still `profiling`), and stops a job after 120 seconds. On boot it marks datasets left `profiling` as `failed`. `llm/client.ts` is the provider-neutral forced tool call.

## Behaviour worth knowing

- **Consent:** every route except `/health`, `GET /me` and `PATCH /me` returns 403 `consent_required` until consent is given.
- **Validation:** bodies, queries and params are parsed with strict zod schemas, so unknown fields are rejected. Failures are 422 `validation_failed` with `details: { fields: [{ location: 'body' | 'query' | 'params', path, message }] }`. Malformed JSON and bodies over 100 KB are also 422 `validation_failed`.
- **Ids:** a malformed route id is 404 (it cannot match a row), the same as an id owned by someone else.
- **Rate limits:** 300 requests per minute per user after auth. Before auth, 300 per minute per IP, counting only requests that did not authenticate. Exceeding either returns 429 `rate_limited` with `Retry-After`. Both counters are in memory, per process.
- **Logging:** pino with method, path, status, timing and user id. No bodies, query strings, tokens, emails or keys.
- **Plan limits:** `services/limits.ts` (`assertWithinLimit`) covers every `LimitKey`. Deleting a workspace removes its datasets' files (`services/files.ts`).
- **Uploads:** 10 per minute per user. A file over 50 MB is 413 on every plan, and a file over the plan's `max_file_mb` is 402. An upload counts against `max_datasets_per_month` once it is accepted, even if profiling fails later; a reparse does not count.
- **Privacy:** the model sees only column labels, types, meanings, stats and 5 sample rows. PII columns are placeholders (`[email]`, `[phone]`, `[id]`, `[name]`, `[address]`) with no min or max, and each cell is cut to 80 characters inside `<data>` tags. OpenRouter requests send `provider.data_collection: "deny"`. Error messages and logs never contain cell values.
- **LLM cost:** one `usage_events` row (`kind: llm`) per call, failures included. OpenRouter cost comes from its response; otherwise from `src/config/prices.ts`, never guessed.

## Layout

```
src/
  index.ts  app.ts
  config/env.ts            zod-validated env (lazy)
  config/prices.ts         USD per million tokens (fallback when the provider reports no cost)
  lib/                     supabase clients, storage, AppError, logger, response helpers
  llm/                     provider-neutral client; prompts/ holds the prompts from docs/LLM_PROMPTS.md
  middleware/              auth, consent, validate, error, rateLimit
  routes/                  health, me, workspaces, datasets, internal
  services/                limits, usage, dates (SAST), files, datasets, profiling, suggestions, parsing/
  types/api.ts             verbatim copy of docs/api-types.ts
test/unit/                 no network
test/integration/          real Supabase, mocked LLM
test/llm/                  opt-in, real model (RUN_LLM_TESTS=1)
```
