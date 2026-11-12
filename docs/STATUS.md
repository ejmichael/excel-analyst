# Build status

Owned by the SERVER chat. The CLIENT chat reads it: build against real endpoints only when marked `DONE`; otherwise use mocks.
Mark `DONE` only after the endpoint has been run and tested. Values: `TODO`, `WIP`, `DONE`, `BLOCKED (reason)`.

## Slices
| Slice | Scope | Server | Client |
|---|---|---|---|
| S0 | Foundation, auth, consent, workspaces, me | DONE | DONE |
| S1 | Upload, parse, profile, preview | DONE | DONE (tested against the real server) |
| S2 | Ask, verify, source rows | DONE | TODO |
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
| S1 | POST `/datasets` | DONE |
| S1 | GET `/datasets` | DONE |
| S1 | GET `/datasets/:id` | DONE |
| S1 | PATCH `/datasets/:id` | DONE |
| S1 | POST `/datasets/:id/reparse` | DONE |
| S1 | GET `/datasets/:id/preview` | DONE |
| S1 | DELETE `/datasets/:id` | DONE |
| S1 | POST `/internal/purge-expired` | DONE |
| S2 | POST `/datasets/:id/ask` | DONE |
| S2 | GET `/datasets/:id/blocks` | DONE |
| S2 | GET `/blocks/:id` | DONE |
| S2 | GET `/blocks/:id/source-rows` | DONE |
| S2 | GET `/blocks/:id/export.csv` | DONE |
| S2 | POST `/blocks/:id/feedback` | DONE |
| S2 | DELETE `/blocks/:id` | DONE |
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
- Measured 2026-11-10 with the real models through OpenRouter: 12 questions over fixtures 01-03 (`RUN_LLM_TESTS=1 npm run test:llm`). The local runner records the same model, token and cost figures that `usage_events` stores.
- Planner (`anthropic/claude-sonnet-5.5`, tool choice "auto"): 13 calls (12 plans + 1 repair). Per call on average: 2 625 input and 516 output tokens, $0.010410, 3.7 s.
- Narrator (`anthropic/claude-haiku-5.5`, forced tool): 12 calls (11 answers + 1 retry). Per call on average: 1 855 input and 237 output tokens, $0.000304, 1.7 s.
- Average cost per question: $0.0116, about R0.21 at an assumed R18.00 per USD (not a live rate). The planner is about 90% of it.
- Ask latency (model calls plus sandbox, measured on a laptop): median 5.3 s, slowest 8.9 s. Add network time to the server in production.

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

- **S1 (2026-11-10). Upload.** Send `multipart/form-data` with `file`, `workspace_id` and optional `name` (1 to 120 characters; it defaults to the file name without its extension). The response is 201 `Dataset` with `status: 'profiling'`. Poll `GET /datasets/:id` every 1.5 s until `ready` or `failed`; fixture files take about 1 to 3 s.
- **Upload errors.**
  - 404: the workspace is not the caller's.
  - 402 `max_datasets_per_month`.
  - 413 `file_too_large`: over 50 MB, on **every** plan.
  - 402 `max_file_mb`: over the plan's size. `details.used` is the size in MB with 2 decimals.
  - 415 `file_unsupported`: not a CSV or .xlsx by content. The `message` is specific (old .xls, UTF-16 CSV, a zip that is not a workbook, no columns found); show it as written.
  - 422: a missing file or bad fields.
  - 429: more than 10 uploads a minute.
- **Too many rows** is not an error code. The dataset ends `failed` with `error_message` "Your plan allows 20 000 rows; this file has 20 001." (numbers grouped with plain spaces).
- **`failed` datasets** always carry a short, user-safe `error_message`. Offer "Try other options" (reparse). After a server restart: "Interrupted by a restart. Please try again."
- **Reparse.** It returns 202 with `status: 'profiling'`; poll again. Only the fields you send (non-null) override detection, so send the full set from the parse dialog. Column edits (`display_name`, `semantic`, `is_pii`, `vat_included`) carry over by `sql_name`. Errors:
  - 409 `conflict`: already profiling.
  - 410 `dataset_expired`: the file was removed by retention.
  - 422: `sheet_name` is not in `sheet_names`.
- **`parse_options`** holds the effective options. `header_row` is the 1-based row in the original file. `date_format` is `ymd` for files with ISO dates only, and `null` when the file has no dates. `delimiter` is null for XLSX, `sheet_name` null for CSV.
- **`warnings`** are short sentences to show as written. They cover the ambiguous date order, renamed headers, rows with extra values, excluded total/empty rows, which sheet was used, and "We could not generate suggested questions."
- **Masking.** PII columns always come back with placeholder `sample_values` (`[email]`, `[phone]`, `[id]`, `[name]`, `[address]`) and with `min_value`/`max_value` set to `null`. Setting `is_pii: false` returns real samples in the PATCH response.
- **PATCH rules.**
  - A column id from another dataset is 422 with `path: "columns.N.id"`.
  - Setting `semantic` to email, phone, sa_id_number, person_name or address also sets `is_pii`, unless the same request sends `is_pii`.
  - An empty body is 422.
- **Preview** returns typed values: numbers as numbers, booleans as booleans, dates as `YYYY-MM-DD` strings, datetimes as `YYYY-MM-DDTHH:MM:SS` (SAST wall-clock), and `null` for empty cells. It is the owner's data and is not masked. It needs `ready`, else 409 `dataset_not_ready`; an expired dataset is 410.
- **`expired` datasets** are still returned by GET (columns intact). Preview and reparse are 410.

- **Contract changes applied 2026-11-10 (approved by the user).** Re-copy `docs/api-types.ts` to `client/src/api/types.ts`.
  - `Dataset.error_details: PlanLimitDetails | null`. On a too-many-rows failure it is `{ limit_key: "max_rows", limit, used, upgrade_to }`, where `used` is the data-row count (1 000 001 past the counting cap) and `upgrade_to` is the cheapest plan that allows it. Use it for the upgrade dialog instead of parsing `error_message`. It is null in every other case, and reparse resets it.
  - Dataset `name` (upload and PATCH) is trimmed, 1 to 200 characters. Column `display_name` is trimmed, 1 to 120, or null. Anything else is 422 with `path` `name` or `columns.N.display_name`.
  - `ValidationFailedDetails` is now in `api-types.ts`. Same shape as before, no behaviour change.
  - Reparse keeps `display_name`, `semantic`, `is_pii` and `vat_included` for columns whose `sql_name` is unchanged; this is now tested. Column **ids change** after a reparse, so re-read them from the detail before editing again.
- **Hostile workbooks** end as 415 at upload when the zip directory alone shows the problem (too many parts, too large once unzipped). Otherwise the dataset ends `failed` with a specific `error_message`, for example "This workbook has too many rows or cells to read." or the document-type-declaration message.

- **Auth outages are not 401 (2026-11-10).** 401 `unauthorized` now means only that Supabase rejected the token (expired, invalid, user gone). If Supabase Auth cannot be reached, the API retries once and then answers 500 `internal` ("We could not check your sign-in right now. Please try again.") or 429 `rate_limited` with `Retry-After`. **Do not sign the user out on a 500 or 429**; only on 401, after one session refresh.
- **`max_file_mb` units** are now in the contract: `limit` and `used` are megabytes (1 048 576 bytes) rounded up to 2 decimals.

- **S2 (2026-11-10). Ask.**
  - `POST /datasets/:id/ask` is synchronous and usually takes 4 to 9 s; allow up to about 30 s. Show progress generically.
  - The checks run in order: 404 (not the caller's dataset), 410 `dataset_expired`, 409 `dataset_not_ready`, 402 `plan_limit` (`max_questions_per_month`).
  - 422 `cannot_answer`: show the `message` inline under the question box; it says what is missing.
  - 502 `llm_failed`: nothing was saved and no question was counted; offer "Try again".
  - 429 `rate_limited` comes either from the per-user limit (20 asks a minute) or from the server being busy. At most 2 questions are computed at once per server; a third waits up to 20 s and then gets 429. Both send `Retry-After`.
  - If the client disconnects mid-ask, the server still finishes and saves the block, so it appears in history.
- **Blocks.** A `flagged` block is a normal 201 answer. Show it with the amber banner and the failed check labels (plain English, for example "Total of net does not match your file"). `has_source_rows` is false when the planner used every row (no filter); hide the "Show source rows" button then.
- **Source rows.** Send `eq_column` and `eq_value` together or not at all (otherwise 422). `eq_column` must be a dataset `sql_name`. `eq_value` is a string that is cast to the column type, for example `2026-10-01` for dates and `true`/`false` for booleans; a value of the wrong type is 422 with `path: "eq_value"`. Rows are typed like the preview and are not masked. `limit` is at most 200.
- **CSV export.** UTF-8 with BOM, comma-separated, CRLF line endings, file name `<title-slug>-<YYYY-MM-DD>.csv`. Text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading apostrophe (`'=SUM(...)`) so spreadsheets never run them as formulas. Numeric cells stay plain numbers, including negatives. Download with fetch and the token, then save the blob.
- **Delete** is 409 `conflict` while the block is pinned in a report.

## Known issues and decisions
- **2026-11-09 (S0): oversized and malformed JSON.** These answer 422 `validation_failed`. 413 `file_too_large` is reserved for uploads in the contract, and no other code fits.
- **2026-11-09 (S0): malformed ids.** A malformed UUID in a route id answers 404 `not_found` instead of 422, because it can never match a row.
- **2026-11-09 (S0): concurrent workspace creates.** `assertWithinLimit` checks a count and then the insert happens. Two simultaneous `POST /workspaces` calls could both pass on the last free slot. This is acceptable for the MVP; a DB-side check can be added if it matters.
- **2026-11-09 (S0): rate-limit counters are in memory**, per server process. They reset on restart and are not shared across instances. Fine for one instance.
- **2026-11-09 (S0), done in S1: `deleteWorkspaceFiles`** now removes every raw and normalised file of the workspace's datasets before the workspace row (and, by cascade, the dataset rows) is deleted.
- **Open for S5: which event counts against `max_reports_per_month` for template runs.** The limit currently counts `usage_events.kind = 'report'` only. Flow D says template runs count against `max_reports_per_month`, so a run must also write a `report` event, or the counter must include `report_run`. Decide in S5; it does not affect S0.
- **2026-11-10 (S1): upload counting.** The `upload` usage event is written when the upload is accepted (201). It is not refunded if profiling later fails (including the too-many-rows case). Reparse does not count.
- **2026-11-10 (S1): check order.** The order is workspace (404), monthly datasets (402), then size. Above the 50 MB ceiling the answer is 413 on every plan, even where `max_file_mb` is lower, because no upgrade can help. 402 `max_file_mb` is only for files a bigger plan would accept. The prompt listed 402 before 413; this changes only the >50 MB case.
- **2026-11-10 (S1): LLM provider.** At the user's request, `server/src/llm/client.ts` supports `LLM_PROVIDER=openrouter|anthropic` with the same forced tool call. Development uses OpenRouter with `ANTHROPIC_MODEL_FAST=anthropic/claude-haiku-5.5`. Claude Sonnet 5.5 rejects forced tool calls on every provider, which matters for the S2 planner; see `docs/CONTRACT_CHANGES.md` (2026-11-09), status PROPOSED. Neither 5.5 model accepts `temperature`: OpenRouter drops it silently, and the Anthropic provider never sends it. OpenRouter requests use `provider.data_collection: "deny"`.
- **2026-11-10 (S1): LLM cost.** OpenRouter's `usage.cost` is in USD; it matched tokens x the listed price exactly in a test call. The fallback table is `server/src/config/prices.ts`, read 2026-11-09 from OpenRouter's models API and Anthropic's pricing. A model missing from the table logs `cost_usd: null`, never a guess.
- **2026-11-10 (S1): XLSX reader.** `exceljs`'s streaming reader needs `xl/workbook.xml` before the sheets in the zip, and it spills sheets to temp files on disk when they come before the shared strings (which is how Excel writes them). The server therefore reads XLSX with its own small streaming reader (`server/src/services/parsing/xlsx.ts`: central-directory zip reader + `saxes`). Nothing touches disk, and decompressed bytes are capped at 500 MB in total. `exceljs` is now a dev dependency, used only to build test workbooks. Formulas are never evaluated (the cached values are used). Merged cells are repeated in the top 100 rows only (where headers live).
- **2026-11-10 (S1): reparse carry-over.** Reparse carries the previous `display_name`, `semantic`, `is_pii` and `vat_included` by `sql_name`, whether the user set them or detection did. There is no field recording which values were edited. Effect: a detected meaning sticks across reparses unless the user changes it.
- **2026-11-10 (S1): failed datasets get `expires_at`** (now + retention), so the retention job also removes their raw files.
- **2026-11-10 (S1): jobs and the boot sweep are in-process.** At most 2 profiling jobs run at a time, and the rest wait in memory. On restart, `profiling` datasets become `failed`. With more than one server instance, a booting instance would also fail the other instance's running jobs. This is fine for one instance; revisit before scaling out.
- **2026-11-10 (S1): zip-bomb guard.** Declared uncompressed sizes are capped at 500 MB, and actual inflated bytes are counted per entry against the same cap. XLSX is also capped at 500 columns and 2 000 000 rows, and every job at 120 s.
- **2026-11-10 (S1): CSV with a single column** is 415 ("We could not find separate columns"), because the content check requires a consistent delimiter.
- **2026-11-10 (S1): migration `db/migrations/20261110_01_dataset_error_details_and_name_length.sql`** adds `datasets.error_details jsonb` and widens the `datasets.name` check to 1 to 200. The user ran it on the dev project on 2026-11-10. It must be run on every other environment.
- **2026-11-10 (S1): XLSX limits** (`XLSX_LIMITS` in `server/src/services/parsing/xlsx.ts`). Each is a clear, user-safe failure, never a crash.
  - Zip directory: at most 10 000 entries and 500 MB total declared uncompressed size. Both are checked at upload (415) and again when reading.
  - Actual inflated bytes, counted while reading, so a zip that lies about its sizes is still stopped: a sheet XML part at most 500 MB, `sharedStrings.xml` at most 64 MB, other XML parts (workbook, rels, styles) at most 10 MB.
  - Shared-string table: at most 2 000 000 entries.
  - Sheet shape: at most 500 columns, row numbers up to 2 000 000, and 25 000 000 cells per pass over a sheet.
  - XML: any DOCTYPE is refused, so there is no entity expansion and no external entities. `saxes` never fetches external resources anyway.
  - Plan rows: the first pass only counts and keeps per-column counters. It counts data rows up to 1 000 000 so the message can state M. The pass that holds memory (normalised CSV and distinct-value sets) runs only when the row count is within the plan's `max_rows`. Rows held back as possible "Total" footers are capped at 1 000.
  - Every job stops at 120 s.
- **2026-11-10: tool choice per model** (approved contract change, option (b)). `server/src/config/models.ts` lists what each model accepts. Haiku 5.5 is forced (suggestions, narrator). Sonnet 5.5, Opus 5.5 and Fable 5.1 get the single tool with `tool_choice: "auto"`, plus "Always answer by calling the <tool> tool." appended to the system prompt. In auto mode, a reply without the tool call is retried once, then the call fails (S2 routes map that to 502 `llm_failed`). Output is always zod-validated. An unlisted model that answers with the specific "tool_choice ... not supported" 400 is switched to auto at once and remembered for the life of the process. Tokens and cost are summed over retries. Both paths were checked against the real models through OpenRouter on 2026-11-10.
- **2026-11-10: temperature.** It is never sent to Claude Sonnet 5.5, Haiku 5.5, Opus 5.5 or Fable 5.1, on either provider. Values were removed from `LLM_PROMPTS.md` ("only where the model supports it"). Suggestions no longer pass one.
- **2026-11-10: Anthropic provider thinking.** Forced calls send `thinking: disabled` (a forced call cannot run with thinking on). Auto-mode calls keep the model's default thinking. Not yet run against the Anthropic API directly (no key in `.env`); revisit `max_tokens` for the planner in S2 if thinking uses the budget.
- **2026-11-10: auth check errors.** Before this change, any error from `supabase.auth.getUser` became 401, so a brief Supabase outage looked like an expired session. This is the most likely cause of the one failed integration run: a fresh token got 401 from our own API. Supabase did not rate-limit 300 token checks in 9 s when probed, so the cause was a transient failure, not a rate limit. Now 400/401/403/404 mean 401; network errors, 5xx and 429 are retried once and then answer 500 or 429. An alternative for later is verifying the ES256 JWT locally with `auth.getClaims` (the project issues ES256 tokens): no network call per request, but tokens stay valid until they expire even after sign-out or user deletion. Not done; it needs a decision.
- **2026-11-10: integration test infrastructure.** Integration files already ran one at a time (`fileParallelism: false`); they now use `vitest.integration.config.ts`.
  - Setup steps are named and retried once on transient errors (429, 5xx, network). A final failure prints "Integration setup failed at <step>: <name, status, code, message>", with JWTs, Supabase keys and bearer tokens redacted.
  - Users are created one at a time. Cleanup in `afterAll` (which Vitest runs even when `beforeAll` throws; checked) waits for in-flight creations, also finds users whose create response was lost (emails are recorded first), and deletes each user and their files independently.
  - Before each run, `globalSetup` deletes server test users (`test+<12 hex>@example.com` only) older than 1 hour. `npm run test:cleanup` deletes them all now.
  - Leftovers: a run that fails in setup or in tests leaves 0 (checked by forcing a sign-in failure twice). Leftovers happen only if the process is killed before `afterAll`, or Supabase is down during cleanup: at most 2 (Part 1 file) + 4 (datasets file) = 6 per run. The next run's sweep removes them after an hour. The client chat's `test+client-*@example.com` users are never touched.
- **2026-11-10 (S2): DuckDB `@duckdb/node-api` 1.5.6-r.2.** 2.0.0-r.1 (a new major, three weeks old) was available; 1.5.6 was chosen because the sandbox depends on exact setting names and parser output. Settings used: `enable_external_access=false` and `lock_configuration=true` after loading; at creation, `autoinstall_known_extensions`, `autoload_known_extensions`, `allow_community_extensions`, `allow_unsigned_extensions` and `allow_persistent_secrets` all false, plus `max_temp_directory_size=0B` (no spilling user data to disk), `memory_limit=512MB` and `threads=2`.
- **2026-11-10 (S2): memory on the host.** 2 concurrent sandboxes at 512 MB each can use about 1 GB on top of Node. KEYS_AND_SERVICES asks for a 1 GB instance. Use 2 GB, or lower `SANDBOX_LIMITS.memoryLimit` or `maxConcurrent` in `server/src/services/sandbox/sandbox.ts` before going live.
- **2026-11-10 (S2): types in the sandbox.** Decimal columns load as DOUBLE (the planner rounds money with ROUND(x, 2); reconcile allows 0.005) and integer columns as BIGINT.
- **2026-11-10 (S2): validation.** Validation has two layers: a lexical scan outside literals and quoted identifiers (no comments, semicolons or dollar quotes, and none of ARCHITECTURE 4's words plus a few more), then a walk of DuckDB's own parse tree (one SELECT; tables only `data` or a CTE; no table functions; no denied or qualified functions). The planner's `source_filter_sql` is validated at ask time too, so a bad filter is repaired then instead of failing when the user opens source rows.
- **2026-11-10 (S2): repair and narrator retry turns.** Both send the previous tool input back as a plain-text assistant turn (JSON) followed by the user line from LLM_PROMPTS, so they work the same on OpenRouter and Anthropic. DuckDB error text has quoted literals and the SQL echo removed before it goes to the repair call, because DuckDB errors can quote cell values.
- **2026-11-10 (S2): narrative rendering.** A NULL cell behind a token renders as "(no value)" and counts as resolved.
- **2026-11-10 (S2): result masking for the narrator.** A result column is masked when its name is a PII column's sql_name, when the name itself looks personal, or when any of the first 50 values matches the email, SA mobile or SA ID detectors.
- **2026-11-10 (S2): the stored `blocks.model`** is the planner model id.
