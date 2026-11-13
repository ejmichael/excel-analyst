# API contract (SOURCE OF TRUTH)

Base path `/api/v1`. JSON in and out unless stated. Shapes are in `docs/api-types.ts`.
Auth: `Authorization: Bearer <Supabase access token>`. Success: `{ "data": ... }`. Error: `{ "error": { "code", "message", "details?" } }`.
Every DELETE that succeeds returns `{ "data": { "deleted": true } }`.

## Status codes and error codes
| HTTP | code | When |
|---|---|---|
| 401 | `unauthorized` | missing or invalid token |
| 403 | `forbidden` | not allowed (rare; cross-user ids return 404 instead) |
| 403 | `consent_required` | terms and privacy notice not accepted yet |
| 404 | `not_found` | missing, or owned by someone else |
| 409 | `dataset_not_ready` | dataset is `profiling`, `failed` or `uploading` |
| 409 | `conflict` | e.g. deleting a block that is pinned in a report, deleting the default workspace |
| 410 | `dataset_expired` | the source file was removed by retention |
| 413 | `file_too_large` | above the hard 50 MB ceiling |
| 415 | `file_unsupported` | not a real CSV or XLSX (checked by content) |
| 402 | `plan_limit` | `details: PlanLimitDetails` |
| 422 | `validation_failed` | `details: ValidationFailedDetails` (`{ fields: [{ location, path, message }] }`; absent for malformed JSON or bodies over 100 KB) |
| 422 | `cannot_answer` | the question cannot be answered from this dataset; `message` says what is missing |
| 422 | `schema_mismatch` | template run; `details: SchemaMismatchDetails` |
| 429 | `rate_limited` | |
| 502 | `llm_failed` | model call failed or timed out; nothing was saved |
| 500 | `internal` | never leak internals |

## Endpoints

### System
| Method and path | Auth | Request | Response |
|---|---|---|---|
| GET `/health` | none | | `{ status: 'ok', time }` |
| POST `/internal/purge-expired` | header `x-cron-secret` | | `{ purged: number }` |

### Me
| Method and path | Request | Response | Notes |
|---|---|---|---|
| GET `/me` | | `Me` | Allowed before consent. Creates nothing; the profile exists via the DB trigger |
| PATCH `/me` | `UpdateMeRequest` | `Me` | Allowed before consent (that is how consent is given). `brand_color` needs `limits.branding` else 402 |
| POST `/me/logo` | multipart `file` (png, jpg or webp, max 1 MB) | `Brand` | Needs `limits.branding`. Stored in bucket `branding`. A damaged or incomplete image is 415 `file_unsupported` |
| DELETE `/me/logo` | | `Brand` | |
| DELETE `/me` | `DeleteMeRequest` | `Deleted` | Deletes the auth user, all rows and all storage objects. Allowed before consent |

### Workspaces
| Method and path | Request | Response | Notes |
|---|---|---|---|
| GET `/workspaces` | | `Workspace[]` | |
| POST `/workspaces` | `CreateWorkspaceRequest` | 201 `Workspace` | `max_workspaces` |
| PATCH `/workspaces/:id` | `UpdateWorkspaceRequest` | `Workspace` | |
| DELETE `/workspaces/:id` | | `Deleted` | 409 if `is_default`. Deletes its datasets (and files), reports, templates and runs |

### Datasets
| Method and path | Request | Response | Notes |
|---|---|---|---|
| POST `/datasets` | multipart: `file`, `workspace_id`, `name?` | 201 `Dataset` (`status: 'profiling'`) | Flow A. Limits: `max_datasets_per_month`, `max_file_mb`. `name` trimmed, 1 to 200 characters (422 otherwise). Profiling continues in the background |
| GET `/datasets?workspace_id=&limit=&offset=` | | `Paged<Dataset>` | `workspace_id` required; newest first |
| GET `/datasets/:id` | | `DatasetDetail` | Client polls this while `status === 'profiling'` (every 1.5 s, stop at `ready` or `failed`) |
| PATCH `/datasets/:id` | `UpdateDatasetRequest` | `DatasetDetail` | `name` trimmed, 1 to 200 characters; `columns[].display_name` trimmed, 1 to 120, or null (422 otherwise). Changing `semantic` to `email`, `phone`, `sa_id_number`, `person_name` or `address` sets `is_pii` true unless the request sets it |
| POST `/datasets/:id/reparse` | `ReparseRequest` | 202 `Dataset` (`status: 'profiling'`) | Re-runs steps b to h of ARCHITECTURE 2 on the stored raw file with the given options; resets `suggestions`. Only the options in the request are applied; any option not supplied is detected again from the file, not carried over from the previous parse (send the full set to keep earlier choices). Keeps `display_name`, `semantic`, `is_pii` and `vat_included` for columns whose `sql_name` is unchanged. Existing blocks are untouched |
| GET `/datasets/:id/preview?limit=50` | | `DatasetPreview` | `limit` max 200; reads the normalised file; needs `ready` |
| DELETE `/datasets/:id` | | `Deleted` | Deletes both files; blocks keep results |

**Header row and preamble.** `parse_options.header_row` is the 1-based line number of the header in the file, so the lines skipped above it number `header_row - 1`, blank lines included. `preamble_lines` lists only the non-blank text lines above the header, so it can be shorter than `header_row - 1`. Example: fixture 01 has `header_row: 5` and three `preamble_lines` (the fourth skipped line is blank).

Every warning or error message that points the user to the parse dialog names it "Check how we read your file".

### Questions and blocks
| Method and path | Request | Response | Notes |
|---|---|---|---|
| POST `/datasets/:id/ask` | `AskRequest` | 201 `Block` | Flow B. Synchronous, up to about 30 s. Needs `ready` (409 `dataset_not_ready`, 410 `dataset_expired`). Limit `max_questions_per_month`. Rate limit 20 per minute per user |
| GET `/datasets/:id/blocks?limit=&offset=` | | `Paged<Block>` | newest first |
| GET `/blocks/:id` | | `Block` | |
| GET `/blocks/:id/source-rows?limit=50&offset=0&eq_column=&eq_value=` | | `SourceRows` | See "Source rows" below |
| GET `/blocks/:id/export.csv` | | file | UTF-8 with BOM, comma delimiter, header = column names. Counts as an `export` |
| POST `/blocks/:id/feedback` | `BlockFeedbackRequest` | `Ack` | Stored as a `feedback` usage event |
| DELETE `/blocks/:id` | | `Deleted` | 409 `conflict` if pinned in a report |

### Reports
| Method and path | Request | Response | Notes |
|---|---|---|---|
| GET `/reports?workspace_id=&limit=&offset=` | | `Paged<Report>` | `workspace_id` required |
| POST `/reports` | `CreateReportRequest` | 201 `ReportDetail` | Flow C. Limit `max_reports_per_month`. A missing or malformed `workspace_id` is 422 before the 404 and 402 checks. Every `block_id` must be the caller's; 1 to 30 distinct ids. `title` trimmed, 1 to 120 characters; `subtitle` up to 200; `period_label` up to 60 (optional text that is empty after trimming is stored as null; 422 otherwise). Workspace rule: an answer whose file still exists must come from a file in the report's workspace; an answer whose file was deleted is refused on create and kept on update only if already in that report. Otherwise 422 `validation_failed` with one `details.fields` entry per refused answer (`location: "body"`, the rule message, `path` = `block_ids.<i>` where `<i>` is its 0-based position in the request) |
| GET `/reports/:id` | | `ReportDetail` | `watermark` is true when the owner's plan is `free` |
| PATCH `/reports/:id` | `UpdateReportRequest` | `ReportDetail` | `blocks` replaces membership and order. Same lengths as POST; `notes` up to 2000; `blocks` 1 to 30 distinct, `heading_override` up to 120 or null; an empty body is 422. The workspace rule of POST applies to `blocks`, with `path` = `blocks.<i>.block_id` |
| DELETE `/reports/:id` | | `Deleted` | Also revokes (deletes) its share links |
| GET `/reports/:id/export.xlsx` | | file | See "Exports". Counts as an `export` |

### Sharing
| Method and path | Request | Response | Notes |
|---|---|---|---|
| GET `/reports/:id/share-links` | | `ShareLink[]` | |
| POST `/reports/:id/share-links` | `CreateShareLinkRequest` | 201 `ShareLink` | Needs `limits.share_links` |
| DELETE `/share-links/:id` | | `ShareLink` | Revokes (sets `revoked_at`); returns the updated link |
| GET `/public/reports/:token` | none | `PublicReport` | 404 if unknown, revoked or expired. Rate limit 60 per minute per IP. Increments `view_count`. Service-role read. Never returns the owner's email |

### Templates and runs
| Method and path | Request | Response | Notes |
|---|---|---|---|
| POST `/reports/:id/save-as-template` | `SaveTemplateRequest` | 201 `ReportTemplate` | Limit `max_templates`. All blocks must come from one existing dataset (422 otherwise; 409 if it was deleted) |
| GET `/templates?workspace_id=` | | `ReportTemplate[]` | |
| GET `/templates/:id` | | `ReportTemplate` | |
| PATCH `/templates/:id` | `{ name: string }` | `ReportTemplate` | |
| DELETE `/templates/:id` | | `Deleted` | Reports made from it keep `template_id = null` |
| POST `/templates/:id/run` | `RunTemplateRequest` | 202 `ReportRun` | Flow D. Limits: `max_reports_per_month`; dataset must be `ready` |
| GET `/runs/:id` | | `ReportRun` | Client polls every 2 s until `done` or `failed`; `report_id` is then set |
| GET `/templates/:id/runs` | | `ReportRun[]` | newest first |

### Billing (slice S6)
| Method and path | Request | Response | Notes |
|---|---|---|---|
| GET `/billing/plans` | none | `BillingPlan[]` | Reads `plan_limits`; public |
| GET `/billing/subscription` | | `Subscription \| null` | |
| POST `/billing/checkout` | `CheckoutRequest` | `CheckoutResponse` | Flow E. Builds the signed PayFast subscription form fields |
| POST `/billing/payfast/itn` | PayFast form-urlencoded | `200` empty body | NOT a JSON endpoint. Public. See Flow E |
| POST `/billing/cancel` | | `Subscription` | Cancels at PayFast using the stored token; plan returns to `free` at `next_billing_date` or immediately if none |

## Flows

### Flow A: upload and profile
1. Client: `POST /datasets` with the file. Show progress from the upload request itself.
2. Server: validates type by content and size, checks limits and consent, stores the raw file, inserts the dataset (`profiling`), responds 201.
3. Client polls `GET /datasets/:id` until `ready` or `failed`. While waiting, show the stages generically ("Reading your file", "Checking columns"). The API exposes no stage names.
4. On `ready`: show `warnings`, the column table, `suggestions`, and a preview (`GET /datasets/:id/preview`). On `failed`: show `error_message` and offer "Check how we read your file" (opens the parse dialog calling `/reparse`).
5. If the plan's `max_rows` is exceeded, the dataset ends `failed` with `error_message` "Your plan allows N rows; this file has M." and `error_details: PlanLimitDetails` (`limit_key: 'max_rows'`, `limit` = N, `used` = M, `upgrade_to` = the cheapest plan that allows M rows). No 402, because the row count is only known after parsing. `error_details` is null in every other case.

### Flow B: ask a question
1. `POST /datasets/:id/ask { question }` (or a suggestion; send `source: 'suggested'`).
2. Server runs plan, sandbox, reconcile, narrate (ARCHITECTURE 3) and returns the `Block`. If `status === 'flagged'`, at least one check failed; show it with an amber banner but still show the answer.
3. Client shows chart or table, narrative, follow-ups (clicking one asks it), and the "How this was calculated" panel (SQL, checks, source rows button).
4. "Pin to report" is a client-side selection of block ids until the user creates a report (Flow C).

### Flow C: report, export, share
1. `POST /reports` with ordered `block_ids`. Server returns `ReportDetail` including `brand` and `watermark`.
2. PDF: the client report page has a print stylesheet (A4, page breaks between blocks, no app chrome) and a "Download PDF" button that calls `window.print()`. There is no server-side PDF in the MVP.
3. Excel: `GET /reports/:id/export.xlsx` (download via fetch with the token, then save the blob).
4. Share: `POST /reports/:id/share-links` returns a `url`; the public page `/r/:token` (client route, no login) calls `GET /public/reports/:token`.

### Flow D: template and monthly re-run
1. After a report exists, `POST /reports/:id/save-as-template`.
2. Next month: upload the new file (Flow A), then `POST /templates/:id/run { dataset_id, period_label }`.
3. Server checks `expected_columns` against the new dataset's `dataset_columns` by `sql_name` (types compatible if equal, or integer vs decimal). Otherwise 422 `schema_mismatch` with `details`; the client then offers to open the parse dialog or map columns (mapping is a later feature; show the mismatch clearly).
4. A run executes every `TemplateBlockDef` in order: sandbox, reconcile, narrate, checks, and stores blocks with `source: 'template'`. It creates a report (`template_id` set, title = template name, `period_label`) and a `report_runs` row.
5. Comparison: the server computes `summary_metrics` from `TemplateMetricDef`s and compares them with the most recent earlier `done` run of the same template. The result is `ReportDetail.comparison` (null on the first run).

### Flow E: subscribe with PayFast (card-only)
1. `GET /billing/plans` then `POST /billing/checkout { plan }`.
2. Server builds the PayFast subscription fields (merchant id and key, amount, `subscription_type = 1`, `frequency = 3` (monthly), `cycles = 0`, `custom_str1 = owner_id`, `custom_str2 = plan`, return, cancel and notify URLs) and the `signature` (MD5 over the URL-encoded fields in PayFast's documented order, with the passphrase). Verify the current PayFast documentation before coding; do not rely on this summary.
3. Client auto-submits a hidden form to `action_url` (sandbox or live per `PAYFAST_SANDBOX`).
4. PayFast calls `POST /billing/payfast/itn`. Server must: (a) respond 200 quickly, (b) verify the signature, (c) verify the request comes from PayFast's published IP ranges, (d) confirm the payment with PayFast's validation endpoint, (e) check the amount equals the expected plan price, (f) only then set `subscriptions` and `profiles.plan`. Handle `COMPLETE`, `FAILED`, `CANCELLED`. Idempotent on `pf_payment_id`.
5. Subscriptions are card payments only. Users without a card cannot subscribe in the MVP; say so on the pricing page. PayFast's subscription fees and terms were not verified in the research: confirm them before launch.

## Business rules

**Consent.** All authenticated routes except those marked "allowed before consent" return 403 `consent_required` until `popia_consent_at` is set. `PATCH /me { accept_terms: true }` sets it once.

**Plan limits.** `PlanLimits` come from the `plan_limits` row for `profiles.plan`. Counts: workspaces and templates are current row counts; the monthly counters (`uploads`, `questions`, `reports`) come from `usage_events` in the SAST month. Write the usage event only after the action succeeds. Feature flags that are off return 402 `plan_limit` with `limit: 0`. `upgrade_to` is the cheapest plan that allows it. For `max_file_mb`, `PlanLimitDetails.limit` and `.used` are megabytes (1 MB = 1 048 576 bytes) rounded up to 2 decimals.

**Narrative tokens.** `{{rows}}` = the true `row_count`. `{{r<i>.<column>}}` = the value in result row `i` (0-based, within the first 50 rows) and result column `<column>`. Formatting comes from `chart.value_format[<column>]`: `zar` as `R 1 234,56` via `Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' })`, `integer` and `number` with `en-ZA` grouping, `percent` as the stored fraction times 100 with one decimal and a `%` sign (the SQL must return a fraction, e.g. 0.123), `date` as `2 November 2026`, `text` as is. At most 40 tokens per narrative. Any token that does not resolve, or any free-standing number of two or more digits (other than a year 1990 to 2099), fails the `numbers_from_data` check.

**Checks.** `sql_read_only`: passed the sandbox validation. `numbers_from_data`: see above. `total_reconciles`: present only when the plan includes `reconcile`; `ok` when `abs(expected - actual) < 0.005`. `result_not_truncated`: `ok` unless `row_count > 500`; when false, the narrative must not claim to cover "all" rows (the narrator is told whether the result is truncated). `Block.status = 'flagged'` if any check has `ok: false`.

**Source rows.** `GET /blocks/:id/source-rows` returns the dataset rows behind the answer: `SELECT <all columns> FROM data WHERE (<source_filter_sql>) [AND "<eq_column>" = ?] LIMIT ? OFFSET ?` run through the same sandbox. `eq_column` must be one of the dataset's `sql_name`s and `eq_value` is bound as a parameter, cast to the column's type; send both or neither. Source rows may include PII and are shown to the owner only. 404 if `has_source_rows` is false, 410 if expired, 409 if the dataset is not `ready`.

**Exports.** XLSX: sheet "Summary" (business name, report title, subtitle, period, generated date in SAST, a one-line caution to check important figures against the source), then one sheet per block (sheet names unique, 31 characters max) holding the title, question, narrative, and the result table with number formats (ZAR as `"R" #,##0.00`, percent `0.0%`, dates as real Excel dates), then a sheet "Working" listing each block's SQL and checks. Header fill uses `brand.color` when `limits.branding`. File name `<slug>-<YYYY-MM-DD>.xlsx`. CSV as described under blocks. Both set `Content-Disposition: attachment` and are not wrapped in `{ data }`.

**Public reports.** `PublicReport` omits `sql` (empty string), `checks` (empty array) and sets `has_source_rows` false unless the link has `show_working`. Source-rows are never available on public links. A link is valid while `revoked_at` is null and (`expires_at` is null or in the future).

**Retention.** See ARCHITECTURE 7. `expires_at` is set when profiling finishes. Expired datasets keep their blocks and reports.

**Rate limits.** `ask` 20 per minute per user; upload 10 per minute per user; public routes 60 per minute per IP; everything else 300 per minute per user. Return 429 `rate_limited` with a `Retry-After` header.

**Pagination.** `limit` default 50, max 200; `offset` default 0. Responses use `Paged<T>`.

**CORS.** Only `CLIENT_URL`. Public report and ITN routes are the only ones callable without `Authorization`.
