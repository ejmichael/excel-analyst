# Keys and services you need

## Do these in order (about 1 hour; the first four are enough to start building)
1. **GitHub**: create a private repo `analyst-os`, push this folder.
2. **Supabase**: create a project. Supabase's documentation lists no Africa region (London and Frankfurt are the nearest); pick the closest one it offers and verify the current region list. Expect roughly 150 to 200 ms round trips from Johannesburg (an estimate). Your privacy notice must disclose Supabase as a sub-processor and the cross-border storage.
   - SQL Editor: run `db/schema.sql`.
   - Storage: create two **private** buckets: `datasets` and `branding`. Add no public policies.
   - Authentication: keep Email enabled; set Site URL to `http://localhost:5173` now and add the production URL later.
   - Project Settings > API: copy the **Project URL**, the **anon (public) key** and the **service_role key**.
3. **Anthropic API key** (console.anthropic.com): create a key for this project only. Set a monthly spend limit. Confirm the model names you will use are current on the models page and put them in `ANTHROPIC_MODEL_PLANNER` (a stronger model, used for the SQL plan) and `ANTHROPIC_MODEL_FAST` (a cheaper one, used for suggestions and writing). Check the current per-million-token prices and copy them into `server/src/config/prices.ts`.
   - The API terms bar training on API content and delete inputs and outputs after 30 days by default (verify the current terms). Zero data retention is arranged through Anthropic sales and excludes the Batch API, Files API and code execution, which this app does not use.
4. **Local `.env` files**: copy `server/.env.example` and `client/.env.example` to `.env` and fill them in.
5. **Cron for retention**: a daily call to `POST /api/v1/internal/purge-expired` with header `x-cron-secret`. Use Render's cron job, Railway's cron, or any scheduler. Not needed to start.
6. **Hosting later**: Vercel for `client/`; Render or Railway for `server/` with **at least 1 GB RAM** (DuckDB runs inside the process; a free 512 MB instance will fail on larger files). Free tiers sleep when idle.
7. **PayFast (slice S6 only)**: create a PayFast sandbox account for test payments. For live billing, apply for a merchant account (this takes time, so start it early). Subscriptions are card-only. The research did not find PayFast's subscription fees, limits or terms: ask PayFast for them before you set prices. The ITN webhook needs a public HTTPS URL; use a tunnel (ngrok or cloudflared) while developing.
8. **Sentry (optional)**: error tracking for both apps. Configure it to drop request bodies.

## Environment variables

### server/.env
| Variable | Where it comes from | Notes |
|---|---|---|
| `PORT` | you | `4000` |
| `NODE_ENV` | you | `development` / `production` |
| `APP_NAME` | you | display name used in exports and emails |
| `CLIENT_URL` | you | `http://localhost:5173` locally; your Vercel URL in production. CORS and share-link URLs |
| `SUPABASE_URL` | Supabase API settings | |
| `SUPABASE_ANON_KEY` | same | public key, used with the user's token so RLS applies to reads |
| `SUPABASE_SERVICE_ROLE_KEY` | same | **SECRET. Server only. Bypasses RLS.** Never in the client, git or logs |
| `STORAGE_BUCKET_DATASETS` | you | `datasets` |
| `STORAGE_BUCKET_BRANDING` | you | `branding` |
| `ANTHROPIC_API_KEY` | Anthropic console | **SECRET** |
| `ANTHROPIC_MODEL_PLANNER` | Anthropic models page | model id for the SQL plan |
| `ANTHROPIC_MODEL_FAST` | same | model id for suggestions and narrative |
| `MAX_UPLOAD_MB` | you | hard ceiling, `50` |
| `CRON_SECRET` | you | any long random string; protects `/internal/*` |
| `PAYFAST_MERCHANT_ID` | PayFast (sandbox first) | slice S6 |
| `PAYFAST_MERCHANT_KEY` | PayFast | slice S6, **SECRET** |
| `PAYFAST_PASSPHRASE` | PayFast | slice S6, **SECRET** |
| `PAYFAST_SANDBOX` | you | `true` until you go live |
| `PAYFAST_NOTIFY_URL` | you | public HTTPS URL of `/api/v1/billing/payfast/itn` |
| `PAYFAST_RETURN_URL` / `PAYFAST_CANCEL_URL` | you | client pages |

### client/.env
| Variable | Where it comes from | Notes |
|---|---|---|
| `VITE_API_URL` | you | `http://localhost:4000` locally |
| `VITE_SUPABASE_URL` | Supabase | same as server `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Supabase | the anon key only. Never the service-role key |
| `VITE_APP_NAME` | you | display name |
| `VITE_USE_MOCKS` | you | `false` normally; `true` to build against mocks |

## Services overview
| Service | Needed when | Purpose | Cost to start |
|---|---|---|---|
| Supabase | Now | Postgres, Auth, Storage | Free tier is fine to build; free projects can pause when idle, so upgrade before real users rely on it |
| Anthropic API | Now (S2) | SQL planning, narrative, suggestions | Pay per use; my estimate is under R10 per user per month at 40 questions, to be replaced by measured numbers from `usage_events` |
| GitHub | Now | Code, deploys | Free |
| Vercel | At deploy | Client | Free hobby tier is fine early |
| Render or Railway | At deploy | Server (1 GB RAM minimum) | Paid instance for real users |
| PayFast | S6 | Card subscriptions | Merchant application; fees not verified |
| A domain you control | Before real users | App URL | Varies |
| Sentry | Optional | Errors | Free tier |
Prices and limits change. Check each provider's current pricing page before committing.

## POPIA and legal checklist (not legal advice; book a one-hour session with a POPIA-literate lawyer)
- Terms of use and a privacy notice live before the first real upload. The privacy notice must name: what you collect, why, how long you keep files (the plan's retention days), that files are processed by Anthropic (aggregates and masked samples only) and stored by Supabase outside South Africa, and how to delete everything.
- Sending personal information to a US-based AI API is a cross-border transfer under POPIA section 72; the usual route is a binding agreement (the provider's data processing terms) plus disclosure. Confirm with your lawyer.
- If bookkeepers upload their clients' data, you are probably an operator for them: have a written operator agreement they accept at sign-up (section 21).
- Register an Information Officer with the Information Regulator (registration is free; guidance conflicts on whether a sole proprietor must, so register).
- Keep the consent timestamp (`popia_consent_at`) and the terms version you showed.

## Security checklist
- `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` and PayFast keys only in `server/.env` and your host's secret settings. Rotate immediately if leaked.
- `.env` is gitignored; commit only `.env.example`.
- Buckets are private. No file is ever served by a public URL.
- Run the SQL sandbox escape tests and the tenant-isolation tests before any real user uploads anything.
- Never use real customer files, real claim files or real bank statements as test data. Use `fixtures/` (synthetic).
