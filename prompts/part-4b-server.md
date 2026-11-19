# PART 4b (SERVER): One-click draft report ("Build my report") and prompt polish (slice S3b)

You are the **server engineer** for Analyst OS. Parts 1 to 4 are done and committed (accounts, upload, profiling, asking, checks, source rows, reports, branding). A second Claude Code chat builds `client/` in parallel against the same contract.
Work **only** in `server/`, `db/migrations/` and `docs/STATUS.md` (leave the Client column of its slices table to the client chat). You may also edit the contract files **only** as stated in "Contract" and "Part B" below.
This prompt covers **Part 4b only**: the auto-report, plus a small prompt polish batch. Do not build XLSX export, sharing, public pages, templates, runs or billing.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` and `docs/CONTRACT_CHANGES.md`: read the **2026-11-06 "Auto-report" entry** closely. It is APPROVED but not APPLIED, and this part applies it
2. `docs/ARCHITECTURE.md` section 3 (life of a question) and section 10 (failure modes); `docs/API_CONTRACT.md` Flow B, Flow C and the business rules for Plan limits and Rate limits
3. `docs/api-types.ts`: `Dataset.suggestions`, `Block`, `Report`, `ReportDetail`, `AskRequest`, `PlanLimitDetails`
4. `db/schema.sql`: `datasets`, `blocks`, `reports`, `report_blocks`, `usage_events`, `report_runs` (note: `report_runs.template_id` is NOT NULL, so use a new table), and the RLS section
5. Your own code from Parts 2 to 4: the ask pipeline (call it as a function; do not call your own HTTP endpoint), the report creation function, the profiling background job and its restart handling, `assertWithinLimit`, the usage helpers
Then reply with 6 bullets of what you understood (include: what counts against the monthly limits, what happens to a flagged block, when the run fails, and why the run must not read or log any row data). Then start.

## Pre-flight (stop and tell me exactly what is missing)
- Parts 1 to 4 are committed; `npm test` and `npm run test:integration` pass; S3 endpoints are `DONE`.
- The auto-report entry in `CONTRACT_CHANGES.md` exists and is marked APPROVED.

## Contract (do this first, as its own commit, so the client chat can start)
You may edit `docs/API_CONTRACT.md`, `docs/api-types.ts` (then re-copy to `server/src/types/api.ts`) and the entry in `docs/CONTRACT_CHANGES.md` for exactly this, using the shape in the entry (refine details where you must and say so in the entry, then mark it APPLIED):
- `POST /datasets/:id/auto-report` body `{ title?: string, period_label?: string }` (strict; title 1 to 120, period_label up to 60) returns 202 `AutoReportRun`.
- `GET /auto-reports/:id` returns `AutoReportRun`.
- `AutoReportRun = { id, dataset_id: ID | null, status: 'running' | 'done' | 'failed', blocks_done: number, blocks_total: number, report_id: ID | null, error_message: string | null, created_at }`. `blocks_done` counts questions finished (answered or skipped), `blocks_total` is the number of stored suggestions.
- Add rows under "Questions and blocks" and a short "Flow B2: build my report" to the contract, with the behaviour below. Add `AutoReportRun` to `api-types.ts`.
Commit this first (`Contract: auto-report`) and tell me, so the client chat can re-copy the types.

## Build exactly this

### Migration
A new table `auto_report_runs` (owner_id with cascade like the other tables, `dataset_id` nullable with `on delete set null`, `status`, `blocks_done`, `blocks_total`, `report_id` nullable with `on delete set null`, `error_message`, `title`, `period_label`, `created_at`, `finished_at`) with the same RLS style as `report_runs`. Tell me exactly what to run in the Supabase SQL editor and stop until I say "migration done".

### Endpoints
- `POST /api/v1/datasets/:id/auto-report`: order of checks: auth, consent, dataset is the caller's (404), `ready` (409 `dataset_not_ready`) and not expired (410 `dataset_expired`), the dataset has at least 3 stored suggestions (422 `validation_failed` with a clear message otherwise), no other auto-report for this dataset is `running` (409 `conflict`), then the **quota pre-check**: the remaining `max_questions_per_month` must cover every stored suggestion and the remaining `max_reports_per_month` must cover 1; otherwise 402 `plan_limit` with `PlanLimitDetails` for the limit that falls short (`limit`, `used` as for other limits, and `upgrade_to`). Nothing is asked if the pre-check fails. Insert the run (`running`) and respond 202, then start the background job.
- `GET /api/v1/auto-reports/:id`: the caller's run (cross-user 404), reads through the RLS client.

### The background job
- Ask the stored suggestions **in their order**, through the same ask pipeline function (source `'suggested'`), at most 2 at a time (the sandbox already limits concurrency; respect it). Each answered question writes its normal `question` usage event and its `llm` events exactly as a manual ask does.
- A suggestion that ends in `cannot_answer`, or whose model call fails, is **skipped** (not retried here). Update `blocks_done` after each question.
- Keep `flagged` blocks and put them in the report like any other; the report already shows them with their warning. Never drop or hide a flagged block, and never change a block's status.
- If fewer than 3 blocks were answered, the run `failed` with a user-safe `error_message` such as "We could only answer 2 of the 5 questions for this file. Try asking your own questions." The answered blocks stay in the dataset's history; no report is created.
- Otherwise create the report through your report creation function: title = the request's title or the dataset's name, `period_label` as given, blocks in suggestion order, `max_reports_per_month` checked again and the `report` usage event written after success (a failure here fails the run with a user-safe message). Set `report_id`, `status: 'done'`, `finished_at`.
- If the dataset is deleted while the run is going, stop and fail the run ("The file was deleted."). If the server restarts, mark any `running` run as `failed` with "Interrupted by a restart. Please try again." on boot (the same way profiling does it).
- Never log questions, SQL, rows or narratives; log ids, counts and timings only.

## Part B: prompt polish (approved by the user; you may edit `docs/LLM_PROMPTS.md` for exactly these, and the matching code and tests)
1. **Planner** system prompt, add: "Years and other calendar numbers such as a founded year or a year of purchase must be returned as text (for example CAST(year AS VARCHAR)) with value_format text, never as integer, so they are not shown with thousands separators. For decades return text such as '1990s'."
2. **Narrator** system prompt, add: "Never write any digit yourself, not even for a count of items: every number is a token. Never write the phrases 'this result', 'the file', 'each row' or 'the query'; say what the figures mean for the business instead." Extend the existing phrase check (it already catches row(s) and the query/result/data) to include "this result" and "each row".
3. Re-run the opt-in real-model check (`RUN_LLM_TESTS=1 npm run test:llm`) once, and show me: the flagged count (must be 0), how many questions still needed a narrator retry (before: every list-style answer), and one question that returns a year column, with the column's `value_format`.

## Tests (required)
- Mocked-LLM, integration where possible: happy path (5 answered, report created with 5 blocks in order, source `suggested`, `report` event written once, `question` events 5); one `cannot_answer` (4 blocks); two skipped (3 blocks, still done); three skipped (failed, no report, answered blocks remain); a flagged block is kept and stays flagged in the report; a failed model call counts as skipped; quota pre-check refusal for questions and for reports (402, nothing asked, no usage written); a second run while one is running (409); dataset not ready (409), expired (410), fewer than 3 suggestions (422); cross-user 404 on both endpoints; restart handling; dataset deleted mid-run; title default and `period_label`.
- The real-model run: one auto-report for each of fixtures 01, 02 and 03 (about $0.06 each). Print, per run: status, time taken, the titles and chart types of the blocks, whether any block was flagged, and the total cost. Hand-check at least three figures against values computed with a plain JavaScript loop over the fixture rows.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run test:integration`; fix everything.
2. Update `docs/STATUS.md`: mark the new endpoints `DONE` only after their tests pass; notes for the client (polling every 2 s, expected 15 to 40 s, what the statuses mean, the 402 and 409 cases); the measured cost and time of a full auto-report.
3. Commit in stages (1: contract, 2: migration and endpoints, 3: job and tests, 4: prompt polish and real-model run), so nothing is lost if the session stops. If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
4. Tell me: what you built; the commands to run and test; the measured time and cost per auto-report; the real-model results of Part B; anything you could not verify; and what I should try by hand.

## Do not
Invent endpoints, fields or error codes beyond the entry; edit contract files beyond what is stated here; touch `client/` or `fixtures/`; hide or alter a flagged block; ask more than the stored suggestions; bypass the plan limits; build export, sharing, templates or billing; put a secret in any committed file.