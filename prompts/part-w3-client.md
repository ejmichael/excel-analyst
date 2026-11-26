# PART W3 (CLIENT): save the dashboard to a report

You are the **client engineer** for Analyst OS. Parts 1 to 5c, W1, W2, W2b, W2c and the server side of W3 are done and committed. The server chat is idle; nothing else is editing files now.
Work **only** in `client/` and the Client column of `docs/STATUS.md`. Do not touch `server/`, `db/`, `fixtures/`, or any contract file (`docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md`). If the contract is missing something you need, stop and tell me; do not work around it. Use types from `api-types.ts` only, never hand-copied shapes.

## What this part is
On a file's Dashboard, the user filters the charts, then wants to send them to someone. Reports already have everything for that: open, edit, Excel, CSV, print to PDF, branding, share links. So this part adds one thing: a **"Save to a report"** action on the Dashboard that turns the widgets, under the filters now applied, into answers in a report (a new one, or an existing one). After saving, the user opens the report, where Excel, PDF and Share already work.

Rules that must hold (they are the product):
1. **Numbers come from queries.** The client sends only widget ids and the filter values. It never sends figures, SQL or captions; the server runs each widget's stored SQL again and writes the caption.
2. **Show the working.** A saved answer shows its SQL, its checks, its source rows and the filters in force, like any answer.
3. **No model call** happens in this part, and the UI must not suggest one.

Not in this part: a dashboard-level share link, dashboard PDF or Excel, re-running a saved report on a new file, customising the dashboard.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` (the W3 server note) and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: `POST /datasets/:id/dashboard/save-to-report` and its paragraph of rules, the reports list and report endpoints, `GET /blocks/:id/source-rows`, error codes, plan limits
3. `docs/api-types.ts`: `SaveDashboardToReportRequest`, `Block` (its `source` and `filters` fields), `Report`, `DashboardFilterValue`, `Dashboard`, `DashboardWidget`
4. Your own code: the Dashboard tab (filters bar, applied filter state, widget list and errors), the reports API hooks and list, the report page and how it renders a block, "Show the working", the source-rows view, the public report page, the toast and dialog components, the plan-limit error handling you already use for "new report"
5. `prompts/w2c-cool.png` for the current look

Then reply with 8 bullets of what you understood. Include: exactly what the request body contains and what the two success statuses mean; which errors the endpoint can return and what the dialog says for each; how you will know which reports can be appended to (is "has an open share link" on the report list response? if you cannot tell from the contract, say so, do not guess); which widgets are selectable; where the filters in the request come from (the applied filters, not the draft ones); how a saved answer shows its filters on the report page and on the public page; and what you will test. Then start.

## Build exactly this

**A. API layer (small).** One function and one mutation hook for the endpoint, typed from `api-types.ts`. After a success, invalidate the reports list and that report. The mutation must ignore a second click while pending.

**B. The "Save to a report" button and dialog.**
- A button **"Save to a report"** in the Dashboard header area next to the existing actions, using the existing button styles. It is disabled while the dashboard is planning, has failed, or has no working widgets, with the reason in its tooltip.
- It opens a dialog (use the existing Dialog component; focus is trapped, Esc closes, the first field is focused, the trigger regains focus on close). On a 390 px screen the dialog is full width and its body scrolls.
- **Where to**, two choices as radio cards:
  - **New report** (default): a title field, prefilled with `{file name}, dashboard`, required, trimmed, max 120 characters (use the existing report title limit if there is one).
  - **Add to an existing report**: a list of the user's reports **in this file's workspace**, newest first, with each report's title and last-edited date. A report that has an open share link is shown **disabled** with the line "Has an open share link. Turn it off, or save to a new report." (If the contract does not tell you which reports are shared, show them all enabled and rely on the server's 422 below; say so in your first reply.) If the user has no reports, this choice is disabled with "You have no reports for this file yet."
- **What to save**: a checklist of the dashboard's widgets, in dashboard order, each with its title and a small chart-type icon. All are ticked by default. A widget that currently shows an error is shown unticked and disabled with "This chart has an error." There are "Select all" and "Clear" controls and a counter ("8 of 9 charts"). At least 1 and at most 30 can be saved; the button explains why it is disabled.
- **Filters note**, read-only, above the buttons: the filters applied right now, in the file's own labels and values, for example `Filtered to: Niche is Hair Salon, Spa & Nail Salon`, or `No filters. All rows.` Add one line: "The charts are re-run on the file now, so the report shows these exact filters." Use the **applied** filters (the ones the charts on screen are using), not any unapplied draft in the filters bar. If a draft differs from the applied filters, say "Unapplied changes in the filters bar are not included."
- **Buttons**: "Save to report" (primary; its label shows "Saving…" and it is disabled while pending) and "Cancel". Keep the user's choices if an error happens.
- **On success** (201 or 200): close the dialog and show a toast: `Saved 8 charts to "{title}".` with an action **"Open report"** that goes to the report page. For 201 the text says "Created report". Do not navigate away on your own.
- **Errors**, each with a clear message and no raw codes, inside the dialog (not only a toast):
  - 422 with `path` `report_id` (the report has an open share link): "That report has an open share link, so it can't be changed. Turn the link off, or save to a new report." Disable that report in the list for the rest of this dialog session and refetch the reports list.
  - 422 naming widget ids (a chart now errors or no longer exists): untick and disable those widgets, refetch the dashboard, say which charts were left out and ask the user to save again.
  - 422 for the answers limit on the report: "That report can't hold this many more charts." with the numbers if the error carries them.
  - The existing plan-limit error for a new report: reuse your existing plan-limit message and link to Settings, exactly as for creating a report elsewhere.
  - 409 `dashboard_not_ready`, 410 `dataset_expired`, 404, 429 and network errors: use your existing wording for those errors elsewhere and a Retry for network errors and 429.

**C. Saved answers on the report page and public page.** The server saves the caption as the answer's text, so it renders as the answer already does. Add only:
- A small "From the dashboard" tag on answers whose `source` is `dashboard`, in the same tag style as other answer tags.
- In "Show the working", when `filters` is present and not empty, a "Filters" line listing them in plain words (column label, "is", the values; dates as "from ... to ..."). Use the file's column labels; if a label cannot be found, use the column name. Values are shown as plain text, never as HTML, never parsed.
- Source rows work as for any answer (the server filters them); the table shows its count line as it does now.
- Charts in reports keep their current look (the classic report colours and styling from W2c). Do **not** apply the app's fresh chart style in reports.
- The public report page shows the same tag and filters line; check it renders and nothing breaks.
- Dashboard answers do not appear in the Ask tab's history (the server leaves them out); check that the Ask tab still lists and behaves as before.

**D. Look and feel.** Use the W2c cool theme and tokens already in the code, the existing Dialog, radio, checkbox, toast and tag components. No new colours. Keyboard: every control reachable, Enter submits when valid, radio group and checklist have labels. Text is sentence case, plain words, no jargon.

## Tests (required)
- The button is disabled with a tooltip while planning, failed or with no working widgets, and enabled otherwise.
- The dialog opens with the right defaults (New report, title prefilled, all working widgets ticked, errored widgets disabled and unticked); focus is trapped; Esc and Cancel close; the trigger regains focus.
- Counter, Select all, Clear, and the 1 to 30 limit behave; the primary button is disabled with a reason when nothing is ticked or the title is empty.
- Request body for a new report: exactly `{ filters, widget_ids, title }` with the applied filters and the ticked ids in dashboard order, no `report_id`, no figures, no SQL. For an existing report: `report_id` and no `title`. Check this against the typed shape.
- Draft filters not yet applied are not sent, and the note says so.
- Double click sends one request.
- Success for 201 and 200: dialog closes, the toast text and the "Open report" action are right, the reports list and report are invalidated.
- Each error case above shows the right message inside the dialog and keeps the user's choices; the 422 `report_id` case disables that report; the 422 widget-ids case disables those widgets and refetches.
- A shared report is disabled in the list when the data says so; with no reports the existing-report choice is disabled.
- Report page: a dashboard answer shows the "From the dashboard" tag, its caption, its filters line in the working, its source rows; a value like `x' OR '1'='1` or `<b>hi</b>` appears as plain text.
- The public report page renders a dashboard answer with the tag and filters line.
- Ask history behaviour unchanged. W2c snapshot and contrast tests, report print and report colours unchanged.
- All existing tests still pass.

## Check in a real browser (the real server and fixture 02 now work; the migrations are applied)
At 1360×800 and 390×844, and say so if you could not run something:
1. Dashboard, apply a filter, open the dialog, save two charts to a **new** report; open the report; compare one figure with the dashboard under the same filter; open its source rows and compare the count; open "Show the working".
2. Save two more charts to that **same** report (the append path) and check the order.
3. Share that report, then try to append again: the report is disabled in the list; then revoke the share link and append works.
4. Export the report to Excel (check that it downloads) and open print preview: the report looks as it did before W2c.
5. Open the public page of a shared dashboard report and check the tag and filters line.
Screenshots of the dialog (new and existing choices, an error state) and the report page go in the scratchpad folder as before.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run build` in `client/`; fix everything. If the shared test wait you raised in W2c is not enough, say so; do not hide slow tests.
2. Update the Client column of `docs/STATUS.md` for the W3 row; mark `DONE` only after tests and the browser check pass.
3. Commit in stages: (1) API layer and hook, (2) dialog and button, (3) report page and public page display, tests and STATUS. If a commit is blocked, tell me the exact `git add` and `git commit` lines to run; do not leave files uncommitted without saying so. If you are interrupted I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
4. Tell me: what you built; anything that differs from this prompt and why; the commands to run; what the browser check showed, including what you could not check; and what I should try by hand (filter, save two charts to a new report, open it, check a figure and its source rows, export to Excel, print to PDF, share it, try to append while shared, revoke, append).

## Do not
Touch `server/`, `db/`, `fixtures/` or any contract file; send figures, SQL or captions to the server; build SQL or HTML from filter values; call or suggest a model; apply the fresh chart style or the cool theme to report pages; change the dashboard grid, the filters bar, the Ask tab or the report editor beyond what is listed; add endpoints, routes or dependencies; hide an error behind a toast only; put a secret in any committed file.