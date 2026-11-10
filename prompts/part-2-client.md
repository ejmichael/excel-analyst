# PART 2 (CLIENT): Upload and understand your file (slice S1)

You are the **client engineer** for Analyst OS. Part 1 (sign-in, consent, shell, workspaces) is done and committed. A second Claude Code chat is building `server/` in parallel against the same contract.
Work **only** in `client/` (plus the Part 2 cell in the **Client** column of the slices table in `docs/STATUS.md`).
This prompt covers **Part 2 only**. Do not build asking questions, charts, reports or anything from later parts, even if you can see it in the docs.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` (which Part 2 endpoints are `DONE`, and the server's notes) and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: the Datasets table, Flow A, the error table, and the business rules for Plan limits and Retention
3. `docs/api-types.ts`: compare it with `client/src/api/types.ts` and re-copy it verbatim if they differ (the validation-error entry may have been applied)
4. `docs/PRODUCT_BRIEF.md` for tone, and `fixtures/README.md` (the four synthetic files you will use to test)
Then reply with 6 bullets of what you understood (include: the three product rules, what the AI is and is not allowed to see, and which endpoints you may call for real versus mock). Then start.

## Step 0: housekeeping (do this first, in its own commit)
1. **Upgrade the client to React 19** (and the matching types, Testing Library and React Router versions as needed). The previous part stayed on React 18 and hand-converted shadcn components to `forwardRef`; undo that workaround by using the current generated shadcn components as they are. Keep everything else working: `npm run typecheck`, `npm test` and `npm run build` must pass, and Part 1's flows must still work in both modes. Commit: `Client: upgrade to React 19`.
2. Re-copy `docs/api-types.ts` to `client/src/api/types.ts` if it changed.

## Look and feel
Same as Part 1: warm off-white `#F6F5F0`, ink `#16231F`, accent `#1E7A5F`, white cards with 1px `#D9D8CE` borders and 16px radius, Space Grotesk headings, Inter body, tabular figures for numbers. Calm and trustworthy. Every control has a visible label, a focus ring and a touch target of at least 44px. Warnings and errors are written in words, never colour alone. Everything in this part must work at phone width (390px) except that wide tables scroll sideways inside their own box.

## Build exactly this

### Datasets list (`/datasets`)
- Lists the active workspace's datasets (`GET /datasets?workspace_id=`), newest first, paged with "Load more". Each row: name, original file name, status badge (Reading file, Ready, Could not read, Expired, with text and an icon, not colour alone), row count, uploaded date, and "We delete the file on 2 December 2026" when `expires_at` is set. Clicking opens the dataset page. Empty state: a clear upload prompt and one sentence on what to upload.
- Switching workspace reloads the list. Datasets that are still `profiling` refresh themselves every 3 seconds while visible.

### Upload
- A drag-and-drop zone plus a real "Choose a file" button (a visible `<button>` that opens the file input; keyboard accessible). Accept `.csv`, `.txt` and `.xlsx`; reject others with a written message before sending.
- Before sending, compare the file size with `Me.limits.max_file_mb`; if it is too big, open the `UpgradeDialog` for `max_file_mb` without uploading. The server stays authoritative: map 402, 413, 415 and 429 to clear messages. Also handle 402 `max_datasets_per_month`.
- Upload progress comes from `XMLHttpRequest` upload events (plain `fetch` has none): a progress bar with a text percentage, and a Cancel button that aborts the request. Send `file`, `workspace_id` and optional `name` as multipart.
- Under the zone, one plain sentence: "Your file is stored privately and deleted automatically after your plan's retention period. The AI sees column names and a few sample rows with personal details hidden, never your whole file." Keep it accurate; do not add any compliance or certification claims.
- On success (201), go to the dataset page.

### Dataset page (`/datasets/:id`)
- **While `profiling`:** poll `GET /datasets/:id` every 1.5 seconds; stop at `ready` or `failed`, when the page is left, or after 3 minutes (then say "This is taking longer than usual. You can leave this page; we will keep working." and keep a slower poll). Show a calm progress state with generic stages on a timer ("Reading your file", "Checking the columns", "Getting your questions ready"), since the API exposes no stage names. Announce changes with `aria-live`.
- **When `failed`:** show `error_message` in a clear panel with a "Try other options" button that opens the parse dialog. If the message is about the row limit, also offer the upgrade dialog.
- **When `expired`:** "The original file was deleted on <date>. Anything you saved from it is kept." No reparse.
- **When `ready`:** show, in this order:
  1. **Header:** the name (inline rename saved with `PATCH`), file name, size, "N rows", a note like "We left out 1 total row" when `excluded_rows` is above zero, the expiry sentence, and a Delete button with a confirm dialog that says the file will be removed.
  2. **Warnings:** if `warnings` is not empty, an amber panel listing each warning in words, with "Check how we read your file" as its button.
  3. **Suggested questions:** up to five cards with `question` and `why`. Asking arrives in the next part, so each card links to the placeholder route `/datasets/:id/ask?q=<question>` which shows "Asking opens in the next part" and echoes the question. If there are no suggestions, show nothing rather than an empty box.
  4. **Columns:** a table with the display name (editable), the original name, type, meaning (a select using plain-English labels for every `ColumnSemantic` value, with a one-line help text), a **Private** switch (`is_pii`) with the hint "Hidden from the AI", and for `currency_zar` columns a VAT select ("Not sure yet", "Includes VAT", "Excludes VAT", saving `null`, `true`, `false`). Edits are held locally and saved together with a "Save changes" button (disabled until something changed) that calls `PATCH /datasets/:id`; show field errors from `validation_failed` next to the field. Because changing a meaning to email, phone, ID, name or address turns Private on automatically on the server, refresh from the response.
  5. **Preview:** `GET /datasets/:id/preview?limit=50`, a table that scrolls sideways inside its box, with a sticky header and tabular figures. Say "Showing the first 50 of N rows".
- **The parse dialog** ("Check how we read your file"): shows what was detected (`parse_options`) in plain words, lists `preamble_lines` ("These lines above your table were skipped"), and lets the user change: the sheet (only for XLSX, from `sheet_names`), the header row number, the delimiter (CSV only: comma, semicolon, tab, pipe), the decimal separator (full stop or comma), and the date order ("Day first, 31/10/2026", "Month first, 10/31/2026", "Year first, 2026-10-31"). Submit calls `POST /datasets/:id/reparse` with only the options the user changed, then returns to the polling state. Make clear that column edits are kept where the column still exists.

### Mock mode and real mode
- Extend the mocks with datasets that behave like the contract: one that moves from `profiling` to `ready` after a few polls (use the shapes in `fixtures/expected.json` for a card-machine style file, a webstore style file with three Private columns, and a bank style file), one `failed` (row limit), one `expired`, and one with the ambiguous-date warning. Mocks must satisfy the types exactly and enforce the 402/413/415 cases.
- Use real endpoints **only when they are marked `DONE` in `docs/STATUS.md`**; otherwise stay on mocks and say so. When they are `DONE`, test the full flow against the running server with the four files in `fixtures/` (`01_card_sales_semicolon_win1252.csv`, `02_webstore_orders_utf8bom.csv`, `03_bank_statement_comma_quoted.csv`, `04_ambiguous_dates.csv`).

## Tests (required)
- Upload validation (extension, size against the limit), the XHR upload helper (progress, abort, error mapping for 402, 413, 415, 429), the polling hook (stops at `ready` and `failed`, stops on unmount, slows after 3 minutes), the columns form (dirty state, save payload contains only changed fields, field errors), the parse dialog (options per file type, only changed options sent), status badges (text present, not colour only), the datasets list states (empty, loading, error, populated).
- `lib/format.ts` still goes through `Intl` with `en-ZA`; do not format numbers or dates anywhere else.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.
2. Walk through the whole flow yourself (mock mode, and real mode if the server is `DONE`): upload each fixture, wait for ready, edit a column, change a meaning to a PII type and see Private turn on, open the parse dialog and re-read file 04 with month-first dates, rename, delete. Test at 390px.
3. Update the Part 2 cell in the **Client** column of `docs/STATUS.md` and nothing else in that file.
4. Commit: `Part 2 (client): datasets, upload, profile view`.
5. Tell me: what you built; the commands to run it; which mode you tested; what I should click by hand (including which fixture to use for what); and anything in the contract that seemed wrong or missing (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing).

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or anything outside `client/` (except the one STATUS cell); put any secret in the client; build the Ask view, charts or reports; show any number the API did not give you; claim support for any named bank, card machine or accounting product.