# Analyst OS: server

Express + TypeScript API for Analyst OS. The contract is `docs/API_CONTRACT.md` and `docs/api-types.ts` (copied verbatim to `src/types/api.ts`). All routes live under `/api/v1`.

Part 1 (slice S0) covers health, `GET/PATCH /me`, and workspaces.

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
| Anthropic, `CRON_SECRET`, PayFast | not yet | may stay empty until later parts |
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
npm run test:integration    # real Supabase project from server/.env
```

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

## Behaviour worth knowing

- **Consent:** every route except `/health`, `GET /me` and `PATCH /me` returns 403 `consent_required` until consent is given.
- **Validation:** bodies, queries and params are parsed with strict zod schemas, so unknown fields are rejected. Failures are 422 `validation_failed` with `details: { fields: [{ location: 'body' | 'query' | 'params', path, message }] }`. Malformed JSON and bodies over 100 KB are also 422 `validation_failed`.
- **Ids:** a malformed route id is 404 (it cannot match a row), the same as an id owned by someone else.
- **Rate limits:** 300 requests per minute per user after auth. Before auth, 300 per minute per IP, counting only requests that did not authenticate. Exceeding either returns 429 `rate_limited` with `Retry-After`. Both counters are in memory, per process.
- **Logging:** pino with method, path, status, timing and user id. No bodies, query strings, tokens, emails or keys.
- **Plan limits:** `services/limits.ts` (`assertWithinLimit`) covers every `LimitKey`. `services/files.ts` (`deleteWorkspaceFiles`) is a stub until Part 2.

## Layout

```
src/
  index.ts  app.ts
  config/env.ts            zod-validated env (lazy)
  lib/                     supabase clients, AppError, logger, response helpers
  middleware/              auth, consent, validate, error, rateLimit
  routes/                  health, me, workspaces
  services/                limits, usage, dates (SAST), files (stub)
  types/api.ts             verbatim copy of docs/api-types.ts
test/unit/                 no network
test/integration/          real Supabase
```
