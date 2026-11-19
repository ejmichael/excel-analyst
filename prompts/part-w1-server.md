# PART W1 (SERVER): rows for the Data tab and a data quality score

You are the **server engineer** for Analyst OS. Parts 1 to 5 are done and committed. A second Claude Code chat works in `client/` at the same time (it never touches your files, and you never touch `client/`).
Work **only** in `server/`, `db/migrations/` and `docs/STATUS.md` (leave the Client column of its slices table to the client chat).
You may edit `docs/API_CONTRACT.md` and `docs/api-types.ts` **only** for the two items in "Contract" below, and nothing else in them. Do not touch `docs/LLM_PROMPTS.md`.

Why this part exists: each uploaded file is getting its own workspace with tabs (Dashboard, Data, Quality, Insights, Ask, Reports). This part gives the **Data** tab a way to page, sort and search the file's rows, and gives the **Quality** tab a score with a list of issues. Both are **deterministic: no AI call, no cost, no new prompt**. The dashboard, cleaning and everything else come in later parts; do not build any of them.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: the Datasets table (`GET /datasets/:id/preview`, `GET /datasets/:id`), the error codes, "Limits" and Flow A
3. `docs/api-types.ts`: `DatasetColumn`, `DatasetDetail`, `DatasetPreview`, `ColumnDataType`, `ColumnSemantic`
4. `docs/ARCHITECTURE.md`: section 2 (life of an upload), section 4 (the SQL sandbox: how DuckDB is opened, memory and time limits), section 5 (what the model sees)
5. `db/schema.sql`: `datasets`, `dataset_columns`
6. Your own code: the preview route, the profiling job, how the normalised file is stored and opened in DuckDB, how column `sql_name`s are produced
Then reply with 7 bullets of what you understood. Include: what the preview currently returns for PII columns (check your code), what must never be built from user input into SQL (identifiers and the search text), why quality is computed by the server and not by the model, how a dataset that is not `ready` or has expired is handled, and what another user's dataset id returns. Then start.

## Contract (do this first, as its own commit: `Contract: data rows paging and dataset quality`)
1. **`GET /datasets/:id/preview` gets four optional query parameters** (backwards compatible; with none of them the response is exactly what it is today):
   - `offset` (integer, 0 or more, default 0)
   - `sort` (a column's `sql_name`; unknown name is 422) and `dir` (`asc` or `desc`, default `asc`; `dir` without `sort` is ignored)
   - `q` (text, at most 100 characters): keep only rows where any **text** column contains it, case-insensitive. Empty or missing means no filter.
   - `limit` stays at most 200.
   Add one field to `DatasetPreview`: `matched_rows: number` (rows matching `q`; equals `total_rows` when there is no `q`). `total_rows` stays the whole file. Add a sentence to the table row. Nulls sort last in both directions.
2. **New endpoint `GET /datasets/:id/quality`** returns `DatasetQuality`. Needs the dataset `ready` (409 `dataset_not_ready`, 410 `dataset_expired`, 404 for unknown or another user's). Add these types to `api-types.ts` exactly:
```ts
export type QualityPartKey = 'missing' | 'duplicates' | 'types' | 'odd_values' | 'consistency';
export type QualitySeverity = 'high' | 'medium' | 'low';
export type QualityBand = 'very_clean' | 'good' | 'needs_attention' | 'needs_cleaning';
export type QualityIssueKind =
  | 'missing_values' | 'duplicate_rows' | 'mixed_types' | 'extreme_values'
  | 'impossible_dates' | 'inconsistent_case' | 'stray_whitespace' | 'mixed_url_scheme';

export interface QualityPart {
  key: QualityPartKey;
  score: number; // 0 to 100, integer
  note: string; // short plain English, for example "1 empty cell" or "none found"
}

export interface QualityIssue {
  id: string; // stable: `${kind}:${column ?? '_'}`
  kind: QualityIssueKind;
  severity: QualitySeverity;
  column: string | null; // the column's sql_name, null for whole-row issues
  title: string; // plain English
  detail: string; // one or two sentences
  affected_rows: number;
  examples: string[]; // at most 3 values from the file; empty for PII columns
}

export interface DatasetQuality {
  dataset_id: ID;
  score: number; // 0 to 100, integer
  band: QualityBand;
  parts: QualityPart[]; // always all five, in the order of QualityPartKey
  issues: QualityIssue[]; // most severe first, then most rows affected
  rows_checked: number; // equals the row count unless the file was sampled (see below)
  computed_at: ISODateTime;
}
```
   Add a row to the Datasets table and one short paragraph under it that states the score rules (below). No new error codes.
Commit this first and tell me, so the client chat can read it.

## Build exactly this

**A. Preview paging, sorting and search.** Build the DuckDB query from a **whitelist**: `sort` must equal one of the dataset's own `sql_name`s and is quoted from your own column list, never from the request string; `q` is a **bound parameter** (escape `%` and `_`), never concatenated; `offset` and `limit` are validated integers. The search covers text columns only (none: `matched_rows` is 0 when `q` is set). Behaviour for PII columns stays exactly as it is today (the owner sees their own data; nothing new is exposed and nothing is sent to a model).

**B. The quality score.** All checks are fixed SQL that **you** write (never model-written), run in DuckDB against the normalised file with the same read-only, resource-limited setup as the sandbox, with a 10 second time limit. Cap at the first 200,000 rows if the file is larger and say so in `rows_checked`. Checks:
- `missing_values`: per column, rows where the value is null or an empty string. Issue when at least 1 row is affected; severity high at 30% or more of the rows, medium at 5% or more, otherwise low. A column that is empty in every row is high.
- `duplicate_rows`: rows identical across every column (count the extra copies, not the first). Severity medium from 1% of rows, otherwise low.
- `mixed_types`: in a column the profiler typed as text, at least 90% of the non-empty values parse as a number (or a date) but some do not. Affected rows are the ones that do not.
- `extreme_values`: in integer or decimal columns, values further than 3 times the interquartile range beyond the quartiles; only when the column has at least 20 non-null values. Severity low.
- `impossible_dates`: in date or datetime columns, dates before 1990-01-01 or more than 366 days after today (Africa/Johannesburg). Severity medium.
- `inconsistent_case`: in a text column with at most 200 distinct values and `semantic` not email, phone, sa_id_number, person_name, address or free_text: values that are equal after trimming, lowercasing and collapsing spaces but written differently (for example "ops manager" and "Ops Manager"). Affected rows are all rows of the minority spellings. Severity low.
- `stray_whitespace`: values with leading or trailing spaces. Severity low.
- `mixed_url_scheme`: in a column where at least 80% of non-empty values start with `http://` or `https://`, both schemes occur. Affected rows are the `http://` ones. Severity medium.
Do not detect column-name problems (run-together words); that needs judgement and belongs to the later cleaning part.

**Score rules (write them into STATUS.md and the contract paragraph):** each part's score starts at 100 and loses points by its own affected share, so one problem never zeroes everything: `missing` loses 3 points per 1% of all cells empty; `duplicates` loses 3 per 1% of rows; `types` and `odd_values` (extreme values and impossible dates together) lose 2 per 1% of rows affected; `consistency` (case, whitespace and URL scheme together) loses 1 per 1% of rows affected (these are style problems, so 9 of 25 rows written differently should leave the part around 60, not at 0). Each part is floored at 0 and rounded to an integer. The overall score is the weighted average, rounded: missing 30, duplicates 20, types 20, odd_values 15, consistency 15. Bands: 90 or more `very_clean`, 75 to 89 `good`, 50 to 74 `needs_attention`, below 50 `needs_cleaning`. A file with no issues scores exactly 100. The same file always gives the same score. Parts with no issues have the note "none found". If you think any constant is wrong after testing on the fixtures, tell me what you would change and why instead of silently tuning it.

**C. Caching.** Compute on the first `GET /datasets/:id/quality` and store the result in a new nullable `jsonb` column on `datasets` (new migration file in `db/migrations/`). Clear it when the dataset is reparsed or its columns are patched in a way that changes types or PII flags. Tell me exactly what to run in the Supabase SQL editor and **stop until I say "migration done"**. Key everything by dataset id and do not assume a dataset has only one version: a later part will create cleaned copies as new datasets.

## Tests (required)
- Preview: default call unchanged; `offset` and `limit` page correctly and consistently; `sort` ascending and descending with nulls last; `sort` with an unknown name is 422; a `sort` value containing quotes or SQL is 422 and nothing runs; `q` finds matches case-insensitively, `matched_rows` counts them, `q` containing `%`, `_`, quotes and `'; DROP TABLE data; --` is treated as plain text; `q` too long is 422; PII columns behave exactly as before; another user's dataset is 404.
- Quality: build a small dirty file **inside the test** (do not edit `fixtures/`) with known counts: some empty cells, 3 exact duplicate rows, a text column with 95% numbers and a few non-numbers, one extreme value, one impossible date, "Ops Manager" in two spellings, values with trailing spaces, and a URL column mixing http and https. Assert the exact `affected_rows` of every issue, the part scores, the overall score, the band, and that `examples` is empty for a PII column and at most 3 elsewhere. A file with none of these scores exactly 100 with all parts "none found". Run it on fixtures 01, 02 and 03 and show me the score and issues for each (a real person should be able to say whether the issues are right).
- Cache: second call does not recompute (assert with a spy); reparse clears it; another user's dataset is 404; not `ready` is 409; expired is 410; sampling: a file over 200,000 rows reports `rows_checked: 200000` (use a generated file, keep the test fast).
- Time: a 200,000-row file finishes inside the limit on your machine; report the time.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run test:integration`; fix everything.
2. Update `docs/STATUS.md`: mark the preview changes and `GET /datasets/:id/quality` `DONE` only after their tests pass. Add a note for the client: the new parameters, `matched_rows`, the quality shape, that there are no fix actions yet, and that the quality score is computed the first time it is asked for.
3. Commit in stages (1: contract, 2: preview, 3: quality and migration, 4: tests and STATUS). If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
4. Tell me: what you built; the commands to run and test; the scores and issues for fixtures 01 to 03; the timing on 200,000 rows; anything you could not verify; and what I should try by hand (upload one of my own files, open the preview URL with `sort`, `dir`, `q` and `offset`, then the quality URL, and check the issues against the file).

## Do not
Touch `client/` or `fixtures/`; edit the contract files beyond the two items; call any model; add fix, clean or rewrite actions; add other endpoints, fields or error codes; build SQL from request strings; log row values or examples; change the answer pipeline, checks or sandbox; put a secret in any committed file.