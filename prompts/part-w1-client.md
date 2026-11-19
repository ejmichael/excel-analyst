# PART W1 (CLIENT): the file workspace (Data tab, Quality tab, Ask tab)

You are the **client engineer** for Analyst OS. Parts 1 to 5c are done and committed. A second Claude Code chat works in `server/` at the same time on the matching server part (it never touches your files, and you never touch `server/`).
Work **only** in `client/`, plus the Client column of the slices table in `docs/STATUS.md`. Do not edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or `docs/CONTRACT_CHANGES.md`. If you need anything the contract does not have, stop and tell me.
**Do not start until I tell you the server's contract commit (`Contract: data rows paging and dataset quality`) is on main.** Then copy `docs/api-types.ts` verbatim into the client as before. Until the server marks the endpoints `DONE` in `docs/STATUS.md`, build against typed mocks behind `VITE_USE_MOCKS=true` so you are never blocked.

## What this part is
Each uploaded file becomes a **workspace with tabs**. This part builds the shell and the first three tabs. The Dashboard and Insights tabs come in later parts, so they do **not** appear yet (drive the tab list from one array so adding them later is one line each). The default tab for now is **Ask**.

Tabs in this part, in this order: **Data, Quality, Ask, Reports** (with Dashboard first and Insights between Quality and Ask once they exist).

## Read first (only these, in this order)
1. `CLAUDE.md` and `docs/STATUS.md` (the W1 notes from the server, if any)
2. `docs/API_CONTRACT.md`: Datasets table (`GET /datasets/:id`, `/preview` with its new parameters, `/quality`, `/reparse`, `PATCH`), Questions and blocks, Flow A, Flow B, the error codes
3. `docs/api-types.ts`: `DatasetDetail`, `DatasetColumn`, `DatasetPreview` (note `matched_rows`), `DatasetQuality`, `QualityPart`, `QualityIssue`, `QualityBand`, `QualityIssueKind`
4. `prompts/part-5c-client.md`, **group C only** (the "Ask your own question" box). It was never committed; you build it now, inside the Ask tab.
5. Your own code: the current dataset page and everything on it (parse dialog, column table and editing, suggestions, answers list, "Build my report"), the router, the theme tokens, the table and chart components
Then reply with 7 bullets of what you understood. Include: which tabs exist now and which do not, what the default tab is, where each thing on today's dataset page moves to, what the Quality tab must not offer yet, which numbers the client may and may not compute, and how stale responses in the Data tab are handled. Then start.

## Look (match the first board of the design the user approved; keep every existing theme token as it is)
Keep the app's current palette: warm off-white page `#F6F5F0`, white cards with a 1px `#D9D8CE` border and 16px radius, ink `#16231F`, muted text `#56625C`, accent green `#1E7A5F`, Space Grotesk headings, Inter body, sentence-case labels, no all-caps eyebrows, no emoji. Do not add new colours except the three status colours below. Touch targets are at least 44px. Colour is never the only signal (every status also has a word).
- Header: back link "All files", the file name as the page heading, a status chip, then a muted line "25 rows, 8 columns, uploaded 19 Nov 2026". Under it a one-line bar **"How we read this file"**: sheet or delimiter, header row, date format and decimal separator in plain words, with a **Change** button that opens the existing parse dialog (calls `/reparse`).
- Tabs: a real `tablist` (roles, arrow-key movement, visible focus). The active tab has a 3px green underline. The **Quality** tab shows a small badge with the score once it has loaded (nothing while loading; never block the tab on it).
- Content sits in white cards. On narrow screens the tab row scrolls sideways and tables scroll inside their card.
- URL: `/datasets/:id/:tab` (`data`, `quality`, `ask`, `reports`). `/datasets/:id` redirects to the default tab. An unknown tab redirects to the default. The browser back button moves between tabs. Existing links to the dataset page keep working.

## Build exactly this

**1. Shell.** Header, "How we read this file" bar, tab row, routing as above. Polling while `status === 'profiling'` stays as it is today (the stages text, the failed state with "Try other options"). Tabs are shown only when the dataset is `ready`; while profiling show the progress state; if `expired` show the existing expired message and the tabs that still make sense (Reports).

**2. Data tab.**
- A table of the file's rows from `GET /datasets/:id/preview` with `limit=50`, paged with **Previous / Next** and "Showing 1 to 50 of 25,310 rows". With a search active, say "Showing 1 to 50 of 12 matching rows (25,310 in the file)" using `matched_rows` and `total_rows`.
- **Sorting:** the column header is a button that cycles ascending, descending, off. Set `aria-sort`. Show an arrow and the word in the accessible name ("Sorted ascending"). Sorting resets to page 1.
- **Search:** one box, debounced 300 ms, sent as `q`, resets to page 1, with a clear button. Text only: say "Searches text columns" under the box. If the file has no text columns, hide the box.
- **Stale responses:** keep the previous page on screen while the next loads (TanStack Query `placeholderData`), and ignore any response that is not for the current page, sort and search.
- Formatting: numbers right-aligned in `en-ZA`; columns whose `semantic` is `currency_zar` shown as rand; dates exactly as the server sends them; nulls as an empty cell with a muted "empty" label for screen readers; long text truncated to one line with the full value in a `title`. The first column is sticky while scrolling sideways. Column headers use `display_name` when set.
- A **Columns** card under or beside the table (collapsed by default on phones) holds the existing column table and its editing (names, meaning, personal-data flag, VAT). This is where it moves to from today's dataset page; keep its behaviour and tests.
- States: loading skeleton, error with Retry (409 "still being read", 410 "this file has expired"), and "No rows match" with a Clear search button.

**3. Quality tab** (`GET /datasets/:id/quality`; the first call can take a few seconds, so show a calm "Checking your file" state and never a spinner that blocks other tabs).
- **Score card:** a ring showing the score ("86", "out of 100"), a heading from the band, one sentence, and **no fix buttons**. Band wording: `very_clean` "Very clean"; `good` "Good, with a few things to tidy"; `needs_attention` "Needs attention"; `needs_cleaning` "Needs cleaning first". Sentence: "No issues found." when there are none, otherwise "N issues found. None change your totals but..." is **not allowed** (the client does not know that); use "N issues found." and, below it, "Fixes arrive in a later update." in muted text. Ring colour: green `#1E7A5F` for `very_clean` and `good`, amber `#B27A00` for `needs_attention`, red `#B4472B` for `needs_cleaning`; the band word is always shown.
- **"What the score is made of":** five rows in the order the server sends them, each a label, the server's `note`, the score and a bar. Labels: `missing` "Missing values", `duplicates` "Duplicate rows", `types` "Wrong types", `odd_values` "Odd values", `consistency` "Inconsistent writing".
- **Issues:** the server's order. Each shows a severity pill with the word (High, Medium, Low), the server's `title` and `detail`, the column's display name when `column` is set, "9 of 25 rows" from `affected_rows` and the file's row count, and up to 3 `examples` in quotes (none for personal-data columns, as the server sends). Each issue has a **See the rows** link that opens the Data tab with the search box filled from the first example when there is one and the issue's column is a text column; otherwise leave the link out.
- "No issues found" empty state with a short friendly line.
- Nothing here edits the file. Do not invent fixes or a "Fix all" button.

**4. Ask tab.** Everything about asking, from today's dataset page: the **"Ask your own question"** box (build it as group C of `prompts/part-5c-client.md` describes), the suggested questions (click one to ask it with `source: 'suggested'`, with the hint "Click a question to start" above them), and the list of answers for this file, newest first. Keep the existing answer card, the "How this was calculated" panel, pin-to-report and error handling exactly as they are. Do not change how answers look.

**5. Reports tab.** The existing **Build my report** button and its progress (as on today's page) and a link to the Reports page. Do not list reports here yet (the list cannot be filtered by file yet).

**6. Cleanup.** Remove the old single-page layout once everything has moved; no feature may disappear. Move or update the existing tests rather than deleting them.

## Tests (required)
- Routing: default redirect, each tab URL, unknown tab, back button, old dataset URL; tabs hidden while profiling and for failed datasets.
- Data: paging, sorting cycle and `aria-sort`, debounced search sends one request, clearing search, stale responses ignored, `matched_rows` wording, no text columns hides search, formatting (rand, `en-ZA` numbers, nulls), 409 and 410 states.
- Quality: all four bands (word and colour), the five rows in order, issue rows including examples (none for PII), "See the rows" shown only when it can work, the empty state, loading state, error state, no fix controls anywhere.
- Ask: suggestion click sends `source: 'suggested'`; the own-question box (as group C's tests described).
- Accessibility: `tablist` arrow keys, visible focus, sort buttons reachable by keyboard.
- Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.

## Verify in a real browser
With Playwright, load a real dataset and screenshot the Data and Quality tabs at 1360 px and 390 px wide (deviceScaleFactor 1), and the Quality tab with and without issues. Check: no horizontal page scroll at 390 px, sticky first column works, sort and search work against the real server (once the server part is `DONE`), the score matches what the server returns. Tell me the screenshot paths. If the server part is not `DONE` yet, say so and verify against the mocks.

## Finish
1. Update the Client column in `docs/STATUS.md` (W1 client `DONE` only after tests and the browser check pass).
2. Commit in stages (1: shell and routing, 2: Data tab, 3: Quality tab, 4: Ask and Reports tabs, 5: cleanup, tests and STATUS). If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
3. Tell me: what you built; where each old page element moved to; anything that differs from this prompt; what I should test by hand (open a file, sort and search the Data tab on a big file, read the Quality tab on one of my own files and check each issue against the file, ask a question from the Ask tab, open a report from the Reports tab).

## Do not
Touch `server/` or `fixtures/`; edit the contract files; compute any quality score, count or total in the client; add fix or clean buttons; build the Dashboard or Insights tabs; change the answer card, the report pages or the print layout; add new colours beyond the three status colours; log or store row values; commit anything outside `client/` and your STATUS column.