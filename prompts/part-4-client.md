# PART 4 (CLIENT): Build a report and set your brand (slice S3)

You are the **client engineer** for Analyst OS. Parts 1 to 3 (sign-in, workspaces, upload, profile, asking, answer cards) are done and committed. A second Claude Code chat is building the report and branding endpoints in `server/` in parallel against the same contract.
Work **only** in `client/` (plus the Part 4 cell in the **Client** column of the slices table in `docs/STATUS.md`).
This prompt covers **Part 4 only**: adding answers to a report, the reports list, the report page, and brand settings. Do not build PDF or print styles, XLSX export, sharing or public pages, templates, comparison, the auto-report button or billing, even if you can see them in the docs.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` (which S3 endpoints are `DONE` and the server's notes) and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: the Reports table, the Me table (logo rows), Flow C steps 1 and 2, and the business rules for Plan limits
3. `docs/api-types.ts`: compare with `client/src/api/types.ts` and re-copy verbatim if they differ. Read `Report`, `ReportBlock`, `ReportDetail`, `CreateReportRequest`, `UpdateReportRequest`, `Brand`, `Me`, `UpdateMeRequest`
4. `docs/PRODUCT_BRIEF.md` for tone
5. Your own Part 3 code: the answer card and its actions row, `lib/format.ts`, `chartData.ts`, the API client, the mocks, `UpgradeDialog`, the app shell and navigation
Then reply with 6 bullets of what you understood (include: how many answers a report may hold, why an answer from another workspace is refused, what `watermark` and `brand` mean, which plans may set a colour or logo, and which endpoints you may call for real versus mock). Then start.

## Look and feel
Same as earlier parts: warm off-white `#F6F5F0`, ink `#16231F`, accent `#1E7A5F`, white cards with 1px `#D9D8CE` borders and 16px radius, Space Grotesk headings, Inter body, tabular figures. Every control has a visible label, a focus ring and a touch target of at least 44px. Warnings and errors in words, never colour alone. Everything works at 390px; wide tables scroll sideways inside their own box. The **user's brand colour and logo apply only inside the report's own header area and accents**, never to the app chrome.

## Build exactly this

### 1. Add answers to a report (the report tray)
- On every answer card (Part 3), turn the reserved "Add to report" slot into a real button. Clicking it adds the answer to the **report tray** for the active workspace; clicking again removes it. The button text and state say which ("Add to report" / "Added to report. Remove").
- A **tray** at the bottom of the screen (a bar on phone width, a side panel on desktop) is visible whenever it holds at least one answer: "N answers selected", a list of their titles with remove buttons and up and down buttons to reorder, and a "Create report" button. Maximum 30; at 30 the add button is disabled with the reason in words.
- The tray is per workspace and survives navigation and reloads: keep it in `sessionStorage` inside try/catch (it must work with storage unavailable, held in memory then). Switching workspace shows that workspace's tray. Answers that can no longer be fetched are dropped with a short message.
- "Create report" opens a dialog: title (required, 1 to 120, default "<dataset name> report"), subtitle (optional, up to 200), period label (optional, up to 60, placeholder "October 2026"), a clear line "N answers", and a note under the button showing "N of M reports used this month" from `Me`. Submit calls `POST /reports`; on success clear the tray and go to the report page. Map errors in words: 402 `plan_limit` on `max_reports_per_month` opens `UpgradeDialog`; 422 for the workspace rule shows the server's message ("an answer in your tray belongs to another client's workspace" or similar) and names which answers to remove if the server says; 404 shows "One of these answers no longer exists" and drops it.

### 2. Reports list (`/reports`)
- Lists the active workspace's reports (`GET /reports?workspace_id=`) newest first with "Load more": title, subtitle or period, number of answers, created date. Clicking opens the report. Empty state: one sentence explaining how to make a report ("Ask a question, then choose Add to report") and a link to the datasets page. Reloads when the workspace changes. Add "Reports" to the main navigation (and the phone menu).

### 3. The report page (`/reports/:id`)
- **Header in the user's brand:** logo (if `brand.logo_url`; if the image fails to load, refetch `Me` or the report once to get a fresh signed URL, then give up quietly), business name, the report title as a heading, subtitle, period label and the created date. The brand colour is used for a header band or accent line; choose the text colour on it (black or white) with a small pure helper `readableTextOn(hex)` that picks the one with the better WCAG contrast ratio, and never show text below 4.5:1. If `brand.business_name` is null, show nothing there; do not invent a name.
- **Watermark:** when `watermark` is true, show a quiet footer line "Made with <APP_NAME>" (from `VITE_APP_NAME`) on the report page, and a sentence in the settings explaining that paid plans remove it. Do not call it a feature of the free plan unless the API says so.
- **Blocks:** every answer in order, rendered with the same chart, narrative and checks as Part 3 but without the "Ask next" buttons, the feedback and delete actions, or the "Add to report" button. Show the heading (the `heading_override` if set, otherwise the answer's title). A flagged answer keeps its amber "Some checks did not pass" panel in the report; never hide it. Keep "How this was calculated" available per block as a collapsed disclosure (the SQL, the checks, and, if `has_source_rows`, the source rows), because showing the working is part of the product.
- **Editing:** a clearly labelled "Edit report" mode (not always-on controls): rename the title, subtitle and period label inline, edit the notes (up to 2000, shown as plain text under the title), edit a block's heading, move a block up or down (buttons with labels; keyboard friendly), remove a block with a confirm, and "Add answers" which opens a picker listing answers from this workspace's datasets (use `GET /datasets/:id/blocks` per dataset the user chooses; show title, question and date; mark the ones already in the report; refuse beyond 30). Save sends one `PATCH /reports/:id` with only the changed fields and the full `blocks` list when membership or order changed. Keep local edits visible and disable Save until something changes. Map 404 and 422 messages in words; a 422 workspace-rule message names the answer.
- **Delete report:** a confirm dialog saying the answers themselves are kept. Returns to the list.
- Leave visible room for "Download", "Share" and "Save as template" actions in a header actions row **as disabled placeholders labelled "Coming soon"**; do not build them.
- A report whose source dataset was deleted or expired still renders fully (the answers hold their own results); if `has_source_rows` is false say why in words, as in Part 3.

### 4. Brand settings (`/settings/brand`, linked from the account menu or settings)
- Fields: business name (up to 120), brand colour (a hex input validated `#RRGGBB` plus a colour swatch input, with a text label, not colour alone), logo (upload and remove). Each section shows a live preview of the report header exactly as the report page draws it, using the same component.
- **Free plan:** the colour and logo controls are visible but disabled, with "Your plan doesn't include branding" and an "Upgrade" button opening `UpgradeDialog` for `branding`. The business name is allowed on every plan (it uses `PATCH /me { business_name }`). If the server answers 402 anyway, open the dialog.
- **Logo upload:** accept `.png`, `.jpg`, `.jpeg` and `.webp` only (SVG and GIF are refused with a written reason), at most 1 MB checked before sending, and show the server's message for 415, 413 and 422 in words. Upload with progress through the Part 2 XHR helper and a Cancel button; `DELETE /me/logo` has a confirm. After success, refetch `Me` so every screen sees the new logo.
- Show contrast guidance in words for the chosen colour ("White text is readable on this colour" or "Dark text is used on this colour") through the same helper as the report header.

### Mock mode and real mode
- Extend the mocks with the reports endpoints, `POST` and `DELETE /me/logo` and `PATCH /me` for colour, satisfying the types exactly: create, list with paging, detail with brand and watermark (on and off), patch (reorder, headings, add, remove), delete, the 402 for the report limit and for branding, the 422 workspace rule, 404, and a 415/413/422 for the logo. A mock logo must be a small generated image, not a remote URL.
- Use real endpoints **only when marked `DONE` in `docs/STATUS.md`**; otherwise stay on mocks and say so. When they are `DONE`, test the whole flow against the running server.

## Tests (required)
- Tray: add, remove, reorder, the 30 limit, per-workspace separation, sessionStorage failure falls back to memory, survives reload.
- Create-report dialog: validation and lengths, error mapping for 402, 422, 404 and the quota text.
- Report page: renders blocks in order with brand and watermark on and off, shows a flagged block's warning, edit mode sends only changed fields, reorder and remove, the add-answers picker (marks members, refuses beyond 30), delete confirm, logo refetch-once on image error, text from the API rendered as text (a title, heading, note and question containing `<script>` and `<img onerror>` must be inert).
- `readableTextOn` for a range of colours (pure black, white, mid greys, the accent, pure red, yellow) and that it never returns a pair below 4.5:1.
- Brand settings: free plan disabled state and upgrade dialog, hex validation, logo file type and size checks, upload progress and cancel, error mapping, live preview matches the report header component.
- No component computes a figure; the answer components reused here keep passing the Part 3 "no arithmetic" test.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.
2. Walk through the whole flow yourself (mock mode, and real mode if the server is `DONE`) at 390px and at desktop width: ask two or three questions on a fixture, add them to the tray, reorder, create a report, edit headings, reorder, add one more answer, delete a block from the report, set a brand colour and logo on a paid plan (set the plan with the service role if needed, and say how you did), see the free plan state, delete the report. Compare at least three figures shown in the report with `fixtures/expected.json` or a hand calculation.
3. Update the Part 4 cell in the **Client** column of `docs/STATUS.md` and nothing else in that file.
4. Commit in stages with clear messages (1: tray and create; 2: reports list and page; 3: brand settings; 4: tests and STATUS), so nothing is lost if the session stops. If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
5. Tell me: what you built; the commands to run it; which mode you tested; what I should click by hand; the figures you compared; and anything in the contract that seemed wrong or missing (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing).

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or anything outside `client/` (except the one STATUS cell); put any secret in the client; render API text as HTML; accept SVG logos; apply brand colours to the app chrome; calculate or estimate any figure on the client; hide a failed check; build PDF or print styles, export, sharing, templates, auto-report or billing.