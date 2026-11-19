# PART 4b (CLIENT): "Build my report" in one click (slice S3b)

You are the **client engineer** for Analyst OS. Parts 1 to 4 are done and committed (sign-in, upload, profile, asking, answer cards, report tray, reports, brand settings). A second Claude Code chat is building the auto-report endpoints in `server/` in parallel against the same contract.
Work **only** in `client/` (plus the Part 4b cell in the **Client** column of the slices table in `docs/STATUS.md`).
This prompt covers **Part 4b only**: the "Build my report" action, its progress, and the draft-report banner. Do not build PDF or print styles, export, sharing, templates or billing.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` (which auto-report endpoints are `DONE`, and the server's notes) and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: the auto-report rows and "Flow B2" (the server chat applies them as its first commit; if they are not there yet, stop and tell me)
3. `docs/api-types.ts`: compare with `client/src/api/types.ts` and re-copy verbatim. Read `AutoReportRun`, `Dataset.suggestions`, `ReportDetail`, `PlanLimitDetails`
4. `docs/PRODUCT_BRIEF.md` for tone; the landing page promise is "upload, glance, send": this part is what makes the "glance" step real
5. Your own code: the dataset page (suggested questions, header), the report page and its edit mode, the polling hook from Part 2, `UpgradeDialog`, the mocks, `lib/format.ts`
Then reply with 6 bullets of what you understood (include: what counts against the monthly limits, what a flagged answer looks like in the draft, what happens if fewer than 3 answers succeed, and which endpoints you may call for real versus mock). Then start.

## Look and feel
Same as earlier parts (warm off-white, ink, accent `#1E7A5F`, white cards with 1px borders and 16px radius, Space Grotesk headings, Inter body, tabular figures). Every control has a visible label, a focus ring and a 44px touch target; warnings in words, never colour alone; works at 390px.

## Build exactly this

### 1. "Build my report" on the dataset page
- When the dataset is `ready` and has at least 3 suggestions, show a **primary button "Build my report"** directly under the header, above the suggested questions, with one plain sentence: "Analyst answers the questions below and puts them in a draft report. You can change anything afterwards." and a quota line from `Me`: "Uses up to N of your M questions left this month and 1 report." (N = number of suggestions). If the quota is clearly too low, keep the button enabled and let the server's 402 open `UpgradeDialog`; do not duplicate the server's arithmetic beyond the displayed numbers from `Me`.
- Clicking opens a small dialog: optional title (placeholder = the dataset name, up to 120), optional period label (up to 60, placeholder "October 2026"), a "Start" button. Submit calls `POST /datasets/:id/auto-report`.
- Errors in words: 402 `plan_limit` opens `UpgradeDialog` for the key in `details`; 409 `conflict` says one is already running and shows its progress; 409 `dataset_not_ready`, 410 `dataset_expired` as in earlier parts; 422 says the file doesn't have enough suggestions yet and offers the Ask page.

### 2. Progress
- After 202, show a calm progress panel (on the dataset page, in place of the button) with a determinate bar from `blocks_done` of `blocks_total`, the text "Answering question 2 of 5", and `aria-live` announcements. Poll `GET /auto-reports/:id` every 2 seconds; stop at `done` or `failed`, when the page is left, or after 3 minutes (then say "This is taking longer than usual. You can leave this page; we will keep working." and poll more slowly).
- Remember the run per dataset in `sessionStorage` (inside try/catch, falling back to memory) so that coming back to the dataset page shows the same progress, or the result. Clear it when the user dismisses a finished result.
- **`done`:** go straight to `/reports/:report_id?draft=1`.
- **`failed`:** show `error_message` in a clear panel with two buttons: "Ask your own questions" (the Ask page) and "Try again". Say that answers already made are kept in the history.

### 3. The draft banner (on `/reports/:id?draft=1`, shown above the report header, dismissible, not shown again after dismissal for that report)
- Text: "This is a draft. Check it before you send it." Then, counted from the report's own blocks (counting statuses is allowed; computing figures is not): "N answers, M of them need a closer look" when any block has `status === 'flagged'`, with the sentence "Answers marked 'Check the numbers' failed a check." If none are flagged, "All checks passed on every answer." Never imply the report is final.
- Two actions: "Add your own question" (opens the report's edit mode with the add-answers picker, or the Ask page for this dataset: pick the simpler, and say which) and "Edit report" (turns on edit mode). Keep "Download", "Share" and "Save as template" as disabled "Coming soon" placeholders.
- Remove the `draft` query parameter when the banner is dismissed (replace, not push).

### 4. Reports list
- Reports created by the auto-report look like any other report. No new list UI.

### Mock mode and real mode
- Extend the mocks: `POST` with a scripted run that advances `blocks_done` every 2 seconds to done (about 10 seconds), and variants selected by the title ("fail" → failed with a message, "busy" → 409, "limit" → 402 for `max_questions_per_month`, "slow" → 3 minutes). A done run returns a report id that exists in the mock reports, built from existing mock blocks including one flagged block so the banner's flagged case is visible. Mocks must satisfy the types exactly.
- Use real endpoints **only when marked `DONE` in `docs/STATUS.md`**; otherwise stay on mocks and say so. When they are `DONE`, test the whole flow against the running server with fixtures 01 to 03.

## Tests (required)
- The button and quota line (shown only when `ready` and at least 3 suggestions), the dialog (lengths, defaults), error mapping (402, 409 both kinds, 410, 422), the progress panel (determinate bar from `blocks_done` and `blocks_total`, `aria-live`, polling stops at `done` and `failed` and on unmount, slows after 3 minutes), the sessionStorage resume and the memory fallback, redirect on `done`, the failed panel's two buttons.
- The draft banner (counts flagged correctly, the all-passed text, dismissal removes the query parameter, not shown again, text from the API rendered as text).
- No component computes a figure; the Part 3 and Part 4 "no arithmetic" tests still pass.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.
2. Walk through the flow yourself (mock mode, and real mode if the server is `DONE`) at 390px and at desktop width: upload a fixture, click Build my report, watch the progress, land on the draft report, read the banner, edit a heading, add one more answer, dismiss the banner; then trigger each error. With the real server, compare at least three figures in the draft report with `fixtures/expected.json` or a hand calculation, and report the time it took end to end.
3. Update the Part 4b cell in the **Client** column of `docs/STATUS.md` and nothing else in that file.
4. Commit in stages (1: button, dialog, progress; 2: draft banner; 3: tests and STATUS), only after the tests pass. If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
5. Tell me: what you built; the commands to run it; which mode you tested; what I should click by hand; the figures you compared and the end-to-end time; and anything in the contract that seemed wrong or missing (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing).

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or anything outside `client/` (except the one STATUS cell); put any secret in the client; render API text as HTML; calculate or estimate any figure on the client; hide or restyle away a failed check; present a draft as final; build PDF or print styles, export, sharing, templates or billing.