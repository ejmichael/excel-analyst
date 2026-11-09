# Architecture

## 1. Overview
```
Browser (React)
   |  Supabase Auth JWT            multipart upload / JSON
   v
Express API (server)  ---------------------------+
   |        |            |                        |
   |        |            +--> Anthropic API       +--> Supabase Storage (private bucket `datasets`)
   |        |                 (planner, narrator,       raw upload + normalised CSV
   |        |                  suggestions)
   |        +--> DuckDB (in-process, per request, read-only sandbox over the normalised CSV)
   +--> Supabase Postgres (metadata, blocks, reports, templates, usage) under RLS
```
There are no background workers or queues in the MVP. Profiling and template runs execute as in-process jobs
(a promise started after the response is sent); their state lives in the database and the client polls. On boot, the server
marks any dataset left in `profiling` and any run left in `running` as `failed` ("interrupted by a restart").

## 2. Life of an upload (slice S1)
1. `POST /datasets` (multipart). Check consent, plan limits (file size, datasets this month), file type by content, not only by extension.
2. Store the raw file at `datasets/<owner_id>/<dataset_id>/raw.<ext>`. Insert the dataset row with `status = profiling`. Respond 201.
3. Background job:
   a. Detect encoding (UTF-8, UTF-8 with BOM, Windows-1252 fallback), delimiter (`,` `;` tab `|`), and for XLSX pick the sheet.
   b. Find the header row (skip preamble lines; see section 6).
   c. Infer column types and meanings; detect decimal and thousands separators and the date order.
   d. Drop total/footer rows and empty rows; count them in `excluded_rows`.
   e. Write a **normalised CSV**: UTF-8, comma delimiter, `.` decimals, no thousands separators, ISO dates (`YYYY-MM-DD`,
      `YYYY-MM-DDTHH:MM:SS`), booleans `true/false`, empty string for null, header = `sql_name`s. Store as `normalised.csv`.
   f. Compute per-column stats, flag PII columns, store `dataset_columns`, `warnings`, `row_count`.
   g. One Haiku call generates five suggested questions from the schema and masked samples.
   h. Set `status = ready` and `expires_at = now + plan retention`.
   Any failure sets `status = failed` with a short, user-safe `error_message`.

## 3. Life of a question (slice S2): why the numbers can be trusted
`POST /datasets/:id/ask { question }` is synchronous and takes roughly 5 to 20 seconds.
1. **Plan (Sonnet, forced tool call `plan_analysis`).** Input: dataset schema (display names, `sql_name`, type, semantic, VAT flag),
   up to 5 masked sample rows, the user's question, optional chart hint. Output (validated by zod): `can_answer`, `title`,
   `sql` (DuckDB dialect, one SELECT over table `data`), `chart` spec, `source_filter_sql` (the WHERE predicate that selects
   the source rows, or null), `reconcile` (optional), `narrative_instructions`. If `can_answer` is false, return 422 `cannot_answer`.
2. **Validate the SQL** with the sandbox rules in section 4. If it fails to parse or run, **one** repair call sends back the DuckDB
   error message (not data) and asks for a corrected query. If the repair fails, return 422 `cannot_answer`.
3. **Execute** in the sandbox. Keep at most 500 result rows in the database (`row_count` = true count, `truncated` = true if cut).
4. **Reconcile (optional).** If `reconcile` is present, the server runs `reconcile.total_sql` on the full table and compares it with
   the sum (or count) of the matching result column over **all** result rows (run the main SQL again without the 500-row cap
   for this check). Tolerance: absolute difference below 0.005. Record a `total_reconciles` check with expected and actual.
5. **Narrate (Haiku, forced tool call `write_narrative`).** Input: question, title, result column names and formats, the first 50
   result rows with PII columns masked, row_count. Output: `narrative_template` (two to four sentences) and up to three `follow_ups`.
   Numbers in the template must be tokens like `{{r0.revenue}}`, `{{rows}}`. No arithmetic, no percentages written by the model.
   Derived values (percent change, share of total, difference) are computed **in the SQL** as their own columns.
6. **Render tokens** on the server using the chart's `value_format` (ZAR, integer, percent, date, number, text) and `en-ZA`
   formatting. Unknown tokens, or a token pointing to a missing row or column, fail the `numbers_from_data` check.
   Free-standing numbers in the prose (any run of two or more digits that is not a token, and not a four-digit year from 1990 to 2099)
   also fail it. On failure, retry the narrator once; if it still fails, store the block with `status = flagged` and a visible warning.
7. Save the block, log tokens and cost to `usage_events` (kind `question` plus the model and counts), return the block.

Checks stored on every block (`BlockCheck`): `sql_read_only`, `numbers_from_data`, `total_reconciles` (only if planned),
`result_not_truncated`. The UI shows a green tick or an amber warning for each; amber never hides the answer.

## 4. The SQL sandbox (mandatory)
Use DuckDB in-process (verify the current Node package name and API before installing; at the time of writing the maintained
client is `@duckdb/node-api`). If it cannot be installed on the host, SQLite via `better-sqlite3` is the fallback, but then
the planner prompt must be switched to the SQLite dialect (no `MEDIAN`, `STDDEV`, window-heavy features) and `LLM_PROMPTS.md`
changes through the contract-change process.

Setup per question (fresh in-memory database each time; a small LRU of loaded datasets is a later optimisation):
1. `new DuckDBInstance(':memory:')`, then `SET memory_limit = '512MB'; SET threads = 2;`.
2. Load the data: `CREATE TABLE data AS SELECT * FROM read_csv('<tmp path>', header = true, columns = { ...explicit types from dataset_columns... })`.
3. Lock down **after** loading: `SET enable_external_access = false; SET lock_configuration = true;`.
4. Run the user-facing SQL with a **10 second timeout** (interrupt the connection) and a **result cap of 5,000 rows** during execution.

Validation before execution (all of these, defence in depth):
- Exactly one statement. Use `SELECT json_serialize_sql(?)` (it only accepts SELECT statements) to confirm it parses as a single SELECT or WITH...SELECT.
- Reject, case-insensitively and outside string literals, any of: `read_csv`, `read_csv_auto`, `read_parquet`, `read_json`, `read_text`, `read_blob`,
  `glob`, `copy`, `attach`, `detach`, `install`, `load`, `pragma`, `set `, `export`, `import`, `call`, `create`, `drop`, `alter`, `insert`,
  `update`, `delete`, `information_schema`, `duckdb_`, `pg_`, `sqlite_`, `getenv`, `current_setting`.
- The only table is `data`. References to any other table name fail.
- A CTE or subquery over `data` is fine.

Required tests (server, slice S2 and again in S6): each of these must be rejected and must not read the server filesystem or change state:
`SELECT * FROM read_csv('/etc/passwd')`, `COPY data TO '/tmp/x.csv'`, `ATTACH '/tmp/x.db'`, `INSTALL httpfs`, `PRAGMA database_list`,
`SELECT 1; DROP TABLE data`, `SELECT * FROM information_schema.tables`, `SELECT getenv('SUPABASE_SERVICE_ROLE_KEY')`,
a query that never finishes (cross join of `data` with itself six times) which must time out at 10 seconds without crashing the server.

## 5. What the model sees (privacy by design)
| Call | Receives | Never receives |
|---|---|---|
| Suggestions (Haiku) | column names, types, semantics, stats (min/max/distinct), up to 5 sample rows with PII columns masked | full rows, PII values |
| Plan (Sonnet) | schema, up to 5 masked sample rows, the question | full rows, PII values |
| Narrate (Haiku) | the question, result column names, up to 50 result rows with PII columns masked | the raw file |
PII masking replaces a value with a fixed placeholder (`[email]`, `[phone]`, `[id]`, `[name]`, `[address]`) before it is placed in a prompt.
A column is PII if its name matches common patterns (name, surname, email, phone, mobile, cell, id number, address) **or** its values match:
email regex, South African mobile (`^(\+27|0)[6-8][0-9]{8}$`), a 13-digit string that passes the Luhn check and begins with a valid `YYMMDD`.
The user sees and can change `is_pii` per column. Result rows shown to the user are never masked.
The Anthropic API commercial terms bar training on API content and delete inputs and outputs within 30 days by default; verify the current
terms. Do **not** use the Batch API, the Files API or the code-execution tool (they are not eligible for zero data retention). Anthropic and
Supabase have no Africa region, so the privacy notice must disclose both as sub-processors and describe the cross-border transfer.

## 6. Parsing South African files
Make the generic parser handle these, with the fixtures in `fixtures/` as the test set:
- **Encoding:** UTF-8 with or without BOM; fall back to Windows-1252 when invalid UTF-8 is found.
- **Delimiter:** pick the candidate (`,` `;` tab `|`) with the most consistent column count across the first 50 rows.
- **Decimal and thousands:** treat `1 234,56` and `1.234,56` as decimal-comma; `1,234.56` as decimal-point. Thousands may be a space, NBSP (U+00A0), `,`, `.` or `'`.
  Strip currency markers (`R`, `ZAR`, `R `) and handle negatives as `-12.50`, `(12.50)`, `12.50-`, and `12.50 DR`.
- **Dates:** recognise `dd/mm/yyyy`, `dd-mm-yyyy`, `yyyy-mm-dd`, `dd Mon yyyy` and Excel date serials. For slash or dash dates with a two-digit
  first and second part: if any value has a first part above 12, the column is day-first; if any has a second part above 12, it is month-first;
  if no value disambiguates, use day-first (the South African norm) and add a warning.
- **Header row:** the first row followed by at least 5 rows with the same column count, containing mostly distinct non-numeric text cells. Rows above it are
  `preamble` and are ignored (but shown to the user in the parse dialog).
- **Footers and totals:** drop trailing rows whose first non-empty cell is `Total`, `Totals`, `Grand total`, `Sub total` (case-insensitive) and empty rows.
- **Excel:** use the cached value of formulas, convert date serials, unmerge merged header cells by repeating the value, default to the sheet with the most numeric cells.
- **Duplicate or empty headers:** rename (`Amount`, `Amount_2`, `Column_7`) and add a warning.
- **`sql_name`:** lower snake_case ASCII, unique, must not start with a digit, must not be a DuckDB reserved word (append `_col`).
Every guess that could be wrong becomes an entry in `warnings` and can be overridden through `POST /datasets/:id/reparse`.
Provider-specific layouts (card machines, point-of-sale, Shopify, bank exports) are **not** verified in the research; do not claim to support
any provider by name. The fixtures are synthetic and imitate only the formatting quirks.

## 7. Storage, retention and deletion
- Bucket `datasets` is private. Paths: `<owner_id>/<dataset_id>/raw.<ext>`, `<owner_id>/<dataset_id>/normalised.csv`, logos at `<owner_id>/logo.<ext>` in bucket `branding` (public read is not allowed; serve through signed URLs, 1 hour).
- `datasets.expires_at = created_at + retention_days` of the plan at upload time. `POST /internal/purge-expired` (cron, `x-cron-secret`) deletes the files of expired
  datasets and sets `status = expired`. Blocks and reports made from them are **kept** (they contain results, not the source file) until the user deletes them.
- `DELETE /datasets/:id` deletes both files and the dataset row; blocks keep their SQL and result rows (`dataset_id` becomes null). `DELETE /me` removes the account and everything the user owns, including storage.
- Share links never expose the dataset or the SQL working unless the report's share option says so (default: working hidden, results visible).

## 8. Limits (from the `plan_limits` table; enforced in the server, mirrored in the UI)
`max_rows`, `max_file_mb` (hard ceiling 50 MB regardless of plan), `max_datasets_per_month`, `max_questions_per_month`, `max_reports_per_month`,
`max_workspaces`, `max_templates`, feature flags `branding`, `share_links`, `white_label`. A violated limit returns 402 `plan_limit` with
`details { limit_key, limit, used, upgrade_to }`. Month boundaries use SAST.

## 9. Cost and observability
Every LLM call writes a `usage_events` row (`kind`, `model`, `input_tokens`, `output_tokens`, `cost_usd`). Cost is computed from a small price table in
`server/src/config/prices.ts` (copy the current per-million-token prices from the provider's pricing page; do not guess). Log token counts with pino, never prompt content.
Set a monthly spend limit in the Anthropic console.

## 10. Failure modes to handle on purpose
- File parses but looks wrong: warnings plus the parse dialog plus reparse.
- Question needs columns that do not exist: `cannot_answer` with a message naming the missing information.
- Planner returns SQL that runs but answers a different question: this cannot be fully prevented; the visible SQL, title and source rows are the mitigation, plus a one-click "this looks wrong" feedback button (stores the block id and a note in `usage_events.meta`).
- Server restarts mid-job: jobs are marked failed on boot; the user can re-run.
- Anthropic API errors or timeouts: 502 `llm_failed`, nothing is saved, the usage event is still logged.
