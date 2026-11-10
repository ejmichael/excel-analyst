# PART 2 (SERVER): Upload, read the file, profile it (slice S1)

You are the **server engineer** for Analyst OS. Part 1 (accounts, consent, workspaces) is done and committed. A second Claude Code chat is building `client/` in parallel against the same contract.
Work **only** in `server/`, `db/migrations/` and `docs/STATUS.md` (leave the Client column of its slices table to the client chat).
This prompt covers **Part 2 only**. Do not build questions, answers, DuckDB, reports or anything from later parts, even if you can see it in the docs.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` (including your own Part 1 notes) and `docs/CONTRACT_CHANGES.md` (note which entries are APPLIED)
2. `docs/ARCHITECTURE.md`: sections 2 (life of an upload), 5 (what the model sees), 6 (parsing South African files), 7 (storage, retention, deletion), 9 (cost) and 10 (failure modes)
3. `docs/API_CONTRACT.md`: the Datasets table, Flow A, and the business rules for Plan limits, Retention and Rate limits
4. `docs/api-types.ts` (compare it with `server/src/types/api.ts` and re-copy it verbatim if they differ) and `db/schema.sql` (`datasets`, `dataset_columns`, `usage_events`)
5. `docs/LLM_PROMPTS.md` section 1 (suggestions) and section 4 (cost control)
6. `fixtures/README.md` and `fixtures/expected.json`: four synthetic test files and the exact values your parser must reproduce
Then reply with 6 bullets of what you understood (include: what the model may and may not see, what counts as an upload against the monthly limit, and how the file type is checked). Then start.

## Pre-flight (stop and tell me exactly what is missing)
- `server/.env` has `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_PLANNER`, `ANTHROPIC_MODEL_FAST` and `CRON_SECRET` (a long random string) filled in. Part 2 only calls the fast model (suggestions); the planner model is used from Part 3.
- Storage buckets `datasets` and `branding` exist and are private (check with the service-role client).
- Node is 22.12 or newer; `npm test` and `npm run test:integration` from Part 1 still pass.

## Install (check each package is current and maintained; tell me if you substitute one)
`@anthropic-ai/sdk`, `csv-parse` (streaming), `exceljs` (read XLSX), `multer` with memory storage and a size limit (or `busboy`), `chardet` or `jschardet`, `iconv-lite` only if `TextDecoder('windows-1252')` is not enough. Do **not** install DuckDB yet.

## Build exactly this

### Endpoints (paths, shapes and codes exactly as the contract; nothing else)
- `POST /api/v1/datasets` (multipart: `file`, `workspace_id`, optional `name`). Order of checks: auth, consent, rate limit (10 uploads a minute per user), `workspace_id` is the caller's (404 otherwise), `max_datasets_per_month` (402), declared size against `max_file_mb` (402 `plan_limit`, `limit_key: 'max_file_mb'`) and against the 50 MB hard ceiling (413 `file_too_large`), then the **content** check: XLSX must be a real zip containing `xl/workbook.xml` (415 otherwise; legacy `.xls` is 415), CSV/TXT must be decodable text with no NUL bytes and a consistent delimiter (415 otherwise). Never trust the extension or the browser's MIME type. Store the raw file at `datasets/<owner_id>/<dataset_id>/raw.<ext>` (generated ids only; the original name is never used in a path, and is stored trimmed, with any path stripped and at most 200 characters). Insert the dataset (`status: 'profiling'`), write the `upload` usage event, return 201 `Dataset`, then start the background job. `name` defaults to the file name without its extension; 1 to 120 characters.
- `GET /api/v1/datasets?workspace_id=&limit=&offset=` (`Paged<Dataset>`, `workspace_id` required and must be the caller's, newest first).
- `GET /api/v1/datasets/:id` returns `DatasetDetail` (columns in position order). A dataset whose status is `expired` is still returned normally.
- `PATCH /api/v1/datasets/:id` (`UpdateDatasetRequest`): rename, and per-column `display_name`, `semantic`, `is_pii`, `vat_included`. Column ids that do not belong to this dataset are a 422. Changing `semantic` to `email`, `phone`, `sa_id_number`, `person_name` or `address` sets `is_pii` true unless the same request sets it. When `is_pii` changes, regenerate that column's `sample_values` (masked placeholders for PII; real values from the normalised file otherwise). A PII column's samples must never be returned unmasked.
- `POST /api/v1/datasets/:id/reparse` (`ReparseRequest`): 202 `Dataset` with `status: 'profiling'`. Re-runs the pipeline from the stored raw file with the given options (only the fields supplied override the detected ones), resets `suggestions`, keeps existing blocks (none yet) and **carries the user's column edits over by `sql_name`**. While already profiling: 409 `conflict`. If the file was removed by retention: 410 `dataset_expired`. A reparse does not count as an upload.
- `GET /api/v1/datasets/:id/preview?limit=50` (`DatasetPreview`; `limit` at most 200, default 50). Reads the normalised CSV, so the dataset must be `ready` (409 `dataset_not_ready`, 410 `dataset_expired`). The preview is the owner's own data and is not masked.
- `DELETE /api/v1/datasets/:id`: delete both storage objects and the row, return `{ deleted: true }`. Check how `blocks.dataset_id` is declared in the schema; blocks must survive with a null dataset id.
- `POST /api/v1/internal/purge-expired`: header `x-cron-secret` compared in constant time with `CRON_SECRET`; wrong or missing header is 401 (and the route is unavailable if the secret is unset). Delete the files of datasets whose `expires_at` has passed and whose status is `ready` or `failed`, set them to `expired`, return `{ purged: n }`.
- Fill in `services/files.ts: deleteWorkspaceFiles` so deleting a workspace also removes its datasets' storage objects.
- On boot, mark any dataset left in `profiling` as `failed` with "Interrupted by a restart. Please try again." (it can be reparsed).
- Every route needs auth and consent as in Part 1; someone else's id is always 404.

### The pipeline (`services/parsing/`, plain functions that are easy to unit-test)
Implement ARCHITECTURE section 6 **exactly**, plus these points:
- Encoding: UTF-8 with or without BOM, falling back to Windows-1252 when the bytes are not valid UTF-8. Strip the BOM.
- Delimiter, decimal and thousands separators, negatives (`-12.50`, `(12.50)`, `12.50-`, `12.50 DR`), currency markers, date order rule (any first part above 12 means day-first; any second part above 12 means month-first; otherwise day-first **and a warning**), header-row detection, footer and total rows, duplicate or empty headers, XLSX (cached formula values, serial dates, merged header cells, the sheet with the most numeric cells), `sql_name` rules (lower snake_case ASCII, unique, no leading digit, never a reserved word: keep a conservative list of SQL keywords in one file and test it).
- `parse_options.header_row` is the **1-based line or row number in the original file** (file `01` has its header on row 5).
- `preamble_lines` holds the non-empty text lines above the header (at most 10). `fixtures/expected.json` counts the lines above the header including blank ones, so assert the header row number, not the array length.
- Column types (`text`, `integer`, `decimal`, `date`, `datetime`, `boolean`) and meanings (`ColumnSemantic`): be **conservative**. Use name hints and value patterns; when unsure use `none`. Money columns that clearly hold rand amounts are `currency_zar`; leave `vat_included` null always (it is the user's to set).
- PII detection exactly as ARCHITECTURE section 5 (name patterns or value patterns). Err on the side of flagging.
- Stats per column: `null_count`, `distinct_count`, `min_value`, `max_value` (as strings), up to 5 `sample_values`.
- Write the normalised CSV exactly as ARCHITECTURE 2e (UTF-8, comma, `.` decimals, no thousands separators, ISO dates, `true/false`, empty string for null, header = `sql_name`s) to `normalised.csv`.
- Row limit: if the parsed row count exceeds the plan's `max_rows`, finish as `failed` with the user-safe message "Your plan allows N rows; this file has M." (count at most to 1 000 000, then say "more than 1 000 000"). No 402 for this, because the count is only known after parsing.
- Resource safety: stream CSV parsing; do not hold several full copies of a 50 MB file in memory; for XLSX, cap decompressed size and row count to defeat zip bombs; run at most 2 profiling jobs at a time (queue the rest in memory; they stay `profiling`); a job that runs longer than 120 seconds ends as `failed` with "This file took too long to read."
- Every failure ends as `status: 'failed'` with a short, user-safe `error_message`. **Never put file content, cell values or stack traces in an error message or a log line.**
- When profiling succeeds: set `row_count`, `excluded_rows`, `warnings`, `sheet_names`, `preamble_lines`, `parse_options` (the effective ones), `expires_at` = now + the owner's plan `retention_days`, `status: 'ready'`.

### Suggested questions (the only LLM call in this part)
- Follow `docs/LLM_PROMPTS.md` section 1 exactly: forced tool call `suggest_questions`, fast model from env, temperature 0.3, `max_tokens` 600, 40 s timeout, one retry on 429 or 5xx with backoff, output validated with zod. Prompts live in `server/src/llm/prompts/` as exported constants.
- The prompt contains only the dataset name, row count, column labels, types, meanings, min/max/distinct counts and up to 5 sample rows with **PII columns replaced by placeholders** (`[email]`, `[phone]`, `[id]`, `[name]`, `[address]`) and each cell truncated to 80 characters. Sample rows are wrapped in `<data>` tags. The model never receives the file.
- Write a `usage_events` row per call (`kind: 'llm'`, model, input and output tokens, `cost_usd`, `meta.purpose: 'suggest'`). Prices come from `server/src/config/prices.ts`, copied from Anthropic's current pricing page; **do not guess prices**. If you cannot read the page, stop and ask me for the numbers.
- If the call fails or returns something invalid, the dataset still ends `ready` with empty `suggestions` and an extra warning "We could not generate suggested questions."

## Tests (required)
- **Unit tests** for every parsing function and for the SQL-name sanitiser, the PII detectors (including the 13-digit ID Luhn and date check, both with passing and failing examples) and the masking function.
- **Fixture pipeline tests** that read `fixtures/expected.json` (do not copy its numbers into tests) and assert, for **all four files with no manual options**: encoding, delimiter, decimal separator, date order, header row, number of data rows, excluded rows, column names, PII columns, date range, and the sums of the money columns computed from the normalised CSV (to 2 decimals). File `04` must also produce the ambiguous-date warning, and re-running it with `date_format: 'mdy'` must change the parsed dates but not the sum.
- **Privacy test:** build the suggestions prompt for the webstore fixture and assert that the text contains the placeholders and contains none of the customer names, emails or phone numbers from the file.
- **Mocked-LLM tests:** success, invalid output, timeout and 429 retry. No test in the default run may call the real API.
- **Integration tests** (real Supabase, mocked LLM): upload each fixture through the API and poll to `ready`; detail and preview match expected values; PATCH a column's `is_pii` and `semantic`; reparse; a 6 MB file on `free` is 402 `max_file_mb`; a file over 50 MB is 413; a PNG renamed `.csv` and a renamed legacy `.xls` are 415; a CSV with more rows than the `free` limit ends `failed` with the row message; delete removes both storage objects; user B gets 404 on user A's dataset for every route; purge works with a dataset whose `expires_at` you set in the past; wrong cron secret is 401; deleting a workspace removes its dataset files; a profiling dataset is marked `failed` by the boot sweep. Clean up all test users and storage objects afterwards.
- **Real-API check (opt-in):** a test or script gated by `RUN_LLM_TESTS=1` that profiles the three non-ambiguous fixtures with the real key and prints each file's five suggested questions plus tokens and cost. Run it once and include the output in your report so I can judge whether the questions are useful.

## Finish
1. Update `server/README.md` with a `curl -F` upload example for every new endpoint and how to run the opt-in LLM check.
2. Update `docs/STATUS.md`: mark the Part 2 endpoints `DONE` only after their tests pass; set the Part 2 server cell; record your decisions (for example: the upload usage event is written when the upload is accepted and is not refunded if profiling fails) and anything the client needs under the server notes.
3. Run typecheck, `npm test` and `npm run test:integration`; fix everything.
4. Commit: `Part 2 (server): upload, parsing, profiling`.
5. Tell me: what you built; the commands to run it; the suggestion output and cost per file; what you could not verify; any ambiguity in the contract (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing); and what I should test by hand.

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts` or `docs/LLM_PROMPTS.md`; touch `client/` or `fixtures/`; add DuckDB, question answering or anything from later parts; log file contents; claim support for any named bank, card machine or accounting product.