# PART W3 (SERVER): save the dashboard to a report

You are the **server engineer** for Analyst OS. Parts 1 to 5c, W1, W2 and W2b are done and committed. A second Claude Code chat works in `client/` (a styling part) at the same time; you never touch `client/`.
Work **only** in `server/`, `db/migrations/` and `docs/STATUS.md` (leave the Client column of its slices table to the client chat).
You may edit `docs/API_CONTRACT.md` and `docs/api-types.ts` **only** for the items in "Contract" below, and nothing else in them. Do not touch `docs/LLM_PROMPTS.md`: nothing here calls a model.

## What this part is
A user looks at a file's dashboard (with or without filters) and wants to send it to someone. Reports already have everything needed: the report page, Excel and CSV export, PDF by print, branding, share links and the public page. So "Save to a report" is the bridge: it turns the dashboard's widgets, **as they look under the current filters**, into answer blocks in a report (a new one, or an existing draft). Everything after that (open, edit, export Excel, print PDF, share a link) is the existing, tested report flow.

Rules that must hold (they are the product):
1. **Numbers come from queries.** Every saved block's figures are the result rows of the widget's SQL run now, by the server, in the sandbox, under the saved filters. The client sends only widget ids and filter values, never figures or SQL.
2. **Show the working.** Each saved block carries its SQL, its checks and a way to see the source rows, exactly like an answer block, and the filters in force are visible on it.
3. **No model call in this part.** No narrative is written by a model. The block's text is a fixed caption built by the server (below).

Not in this part: a dashboard-level share link, dashboard PDF or Excel (the report provides those), re-running a saved block on a new file (templates come later), customising the dashboard.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: Questions and blocks (the `Block` flow, `GET /blocks/:id/source-rows`), Reports and blocks-in-reports endpoints, limits (answers per report, monthly report limit), error codes, Flow C (pinning), the dashboard rows from W2
3. `docs/api-types.ts`: `Block`, `BlockCheck`, `ChartSpec`, `Report`, `ReportBlock` (or whatever pins a block into a report), `Dashboard`, `DashboardFilter`, `DashboardFilterValue`, `WidgetResult`
4. `docs/ARCHITECTURE.md` section 3 (what a block is) and section 4 (sandbox)
5. `db/schema.sql`: `blocks`, `reports`, `report_blocks`, `plan_limits`, `usage_events`, RLS
6. Your own code: how an ask creates and stores a block (including `source_filter_sql`, `checks`, `flagged`), how source rows are read, how a report gets blocks and its positions, the dashboard data endpoint and its filtered view
Then reply with 8 bullets of what you understood. Include: which fields a block needs and where each would come from for a widget; how the filters in force will be stored so the source-rows feature still shows exactly the rows the figures came from, and why a filter value must never be concatenated into SQL text; what the caption says and why it contains no model text; which monthly limits this consumes and which it does not; what another user's dataset, dashboard or report returns; and what happens when the report is full. Then start.

## Contract (do this first, as its own commit: `Contract: save dashboard to report`)
Propose the **smallest** change that works, in this shape (adjust names to match the existing contract style, and tell me anything you changed):
1. **Endpoint** `POST /datasets/:id/dashboard/save-to-report`, body:
```ts
export interface SaveDashboardToReportRequest {
  filters: DashboardFilterValue[]; // same rules as POST .../dashboard/data
  widget_ids: ID[]; // 1 to 30, in the order they should appear in the report
  report_id?: ID; // append to this draft report; omit to create a new report
  title?: string; // new report only; default "{dataset name}, dashboard"
}
```
   Returns `Report` (the existing shape; 201 for a new report, 200 when appended). Errors, using existing codes only: 404 (dataset, dashboard or report not the caller's or unknown), 409 `dataset_not_ready` / `dashboard_not_ready`, 410 `dataset_expired`, 422 `validation_failed` (bad filters, duplicate or unknown `widget_ids`, a widget that currently has an error, more than the report's answer limit), the existing plan-limit error when a new report would exceed `max_reports` (never for the blocks themselves), and the existing rate limit (use the same limit as `ask`, 20 per minute per user).
2. **Block origin.** If `Block` has a field that records where it came from (for example `source`), add the value `dashboard` to it. If it has no such field, add none and say so.
3. **Filters on a block.** If the contract has no way to record filters on a block, propose the **structured** form (a nullable `filters: DashboardFilterValue[]` on the block, shown to the client) rather than SQL text. Say which you chose and why. A block without filters behaves exactly as today.
4. A short paragraph under the endpoint with the rules below.
Commit this first and tell me, so the client chat can read it.

## Build exactly this

**A. Saving.** For each requested widget, in the requested order:
1. Validate the filters exactly as the dashboard data endpoint does (whitelisted columns from the dashboard's own filters, bound parameters, dates re-formatted by the server, at most 50 values).
2. Run the widget's stored SQL against the filtered view, through the sandbox, with the same 10 s limit and row cap as the dashboard data endpoint. A widget whose run fails, or that returns an error, makes the whole request 422 (nothing is saved) and names the widget ids.
3. Create a **block** in the dataset from the widget: `title`, `chart` (`ChartSpec`), `sql`, result columns and rows (capped as for any block), `row_count`, `truncated`, `checks` (only `sql_read_only` and `result_not_truncated`; a truncated result shows its failed check, never a silent pass), origin `dashboard`, and the filters recorded in whichever form you chose in the contract. **Source rows must show exactly the rows the figures came from**: the source-rows endpoint for these blocks must apply the stored filters the same safe way (bound parameters on the filtered view). If the existing source-rows code needs text SQL, extend it to take the structured filters instead of building SQL text from values.
4. The block's explanation is a fixed caption built by the server from the dataset name and the filters in force, using column labels and values as plain text: no model, no digits you computed, for example `From "Booking app". Filtered to: Niche is Hair Salon, Spa & Nail Salon.` (or `From "Booking app". No filters.`). A date filter reads `Dates from 2026-10-05 to 2026-10-11`. It must pass whatever display and check rules reports apply to a block's text; if a rule such as `numbers_from_data` cannot apply to a block with no narrative tokens, handle that explicitly (do not fake a pass) and tell me how.
5. Pin the blocks into the report in order: create a new report (default title above, `period_label` empty, the owner's branding as for any new report) or append to the given **draft** report (a report that is not shared or that the existing rules allow to edit; follow the existing append behaviour and its answer limit).
The whole save is **one transaction**: if anything fails, no block and no report is left behind.

**B. Limits and cost.** No model call. Blocks created this way do **not** count toward `max_questions_per_month` (they are not questions). A new report counts toward the report limit exactly as a report made any other way. Log one `usage_events` row per save (not `llm`; use the existing non-model kind that fits, or `purpose: 'dashboard_save'` in `meta`).

**C. Safety.** No figure or SQL ever comes from the request. The widget's SQL is the one stored with the dashboard. Other users' datasets, dashboards and reports are 404.

## Tests (required)
- Contract paragraph and types present; the request shape validates; unknown fields are rejected.
- Saving all widgets with no filters: blocks created in order, each block's rows equal the dashboard data endpoint's rows for the same request, checks correct, origin `dashboard`, the caption reads "No filters", the report has the blocks in order.
- Saving with filters: block rows equal the filtered dashboard rows (hand-check at least 3 figures against a plain JavaScript loop over the fixture rows); the filters are on the block; the **source rows** for a filtered block return only matching rows and their count equals the filtered row count; the caption lists the filters with the file's own labels and values; a value such as `x' OR '1'='1` or `'); DROP TABLE data; --` is shown as plain text and runs nothing.
- Appending to an existing draft report puts the new blocks after the existing ones; appending beyond the answer limit is 422 and saves nothing; appending to another user's report, a missing report, a shared or non-editable report (whatever the existing rule is) is refused the same way a normal pin is.
- Failure atomicity: a widget that errors makes the whole save fail with nothing created (check the tables); a failure while pinning leaves no report and no blocks.
- A new report over the monthly report limit is refused; blocks do not consume `max_questions_per_month`.
- Another user's dataset, a dataset with no dashboard, a dashboard still planning, an expired dataset, duplicate or unknown widget ids, bad filters, 0 or 31 widgets: each gives the right error.
- A saved report works with the existing features without code changes: its Excel export (check the sheets and values), CSV export of one block, and the share-link snapshot all work; show me the Excel sheet names and one sheet's contents.
- Existing report, block and sandbox tests pass untouched.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run test:integration`; fix everything.
2. Update `docs/STATUS.md`: mark the endpoint `DONE` only after its tests pass; add a note for the client (the request and response shape, which errors to expect, that blocks made this way have origin `dashboard` and carry their filters, that the caption is fixed text, that no model is called, and that the report's own Excel, print and share features apply).
3. Commit in stages (1: contract, 2: saving and source rows, 3: limits, tests and STATUS). If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
4. Tell me: what you built; the contract choices you made and why; the commands to run and test; the Excel result for a dashboard report; anything you could not verify; and what I should try by hand (open a file's dashboard, apply a filter, `POST` the save with two widget ids, open the report, check a figure, open its source rows, export it to Excel).

## Do not
Touch `client/` or `fixtures/`; edit the contract files beyond the items above; call any model; accept figures, SQL or captions from the request; build SQL text from filter values or request strings; add other endpoints, fields or error codes (only what the contract section lists); change the Ask pipeline, the planner, the sandbox, or how reports render, export or share; log row values or results; put a secret in any committed file.