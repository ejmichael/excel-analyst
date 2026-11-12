# PART 3 (CLIENT): Ask a question and check the answer (slice S2)

You are the **client engineer** for Analyst OS. Parts 1 and 2 (sign-in, consent, workspaces, upload, profile view) are done and committed. A second Claude Code chat is building the ask endpoints in `server/` in parallel against the same contract.
Work **only** in `client/` (plus the Part 3 cell in the **Client** column of the slices table in `docs/STATUS.md`).
This prompt covers **Part 3 only**: the Ask screen, answer cards with charts, "How this was calculated", source rows, answer history. Do not build reports, "add to report", exports other than the answer's CSV, sharing, templates or billing, even if you can see them in the docs.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` (which S2 endpoints are `DONE`, the measured timings and the server's notes) and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: the "Questions and blocks" table, Flow B, and the business rules for Narrative tokens, Checks, Source rows and Rate limits
3. `docs/api-types.ts`: compare with `client/src/api/types.ts` and re-copy verbatim if they differ. Read `Block`, `ChartSpec`, `ValueFormat`, `BlockCheck`, `AskRequest`, `SourceRows`
4. `docs/PRODUCT_BRIEF.md` for tone
5. Your own Part 2 code: `lib/format.ts`, the API client, the mocks, `UpgradeDialog`, the dataset page, and the suggested-question cards that link to `/datasets/:id/ask?q=`
Then reply with 6 bullets of what you understood (include: where every number on screen comes from, what you may and may not compute on the client, what a `flagged` block must look like, and which endpoints you may call for real versus mock). Then start.

## Look and feel
Same as Parts 1 and 2: warm off-white `#F6F5F0`, ink `#16231F`, accent `#1E7A5F`, white cards with 1px `#D9D8CE` borders and 16px radius, Space Grotesk headings, Inter body, tabular figures for numbers. Calm and trustworthy. Every control has a visible label, a focus ring and a touch target of at least 44px. Warnings and errors are written in words, never colour alone. Everything must work at phone width (390px); wide tables scroll sideways inside their own box.

## Build exactly this

### Install
Recharts (check the current version works with React 19; if it does not, tell me and stop). No other charting library.

### The Ask screen (`/datasets/:id/ask`, replacing the placeholder)
- Header: dataset name with a link back to the dataset page, and "N of M questions used this month" from `Me.usage.questions` and `Me.limits.max_questions_per_month` (refresh `Me` after each answer).
- A labelled question box (3 to 500 characters, with a live character count and a written error), an optional "Show it as" select (Let Analyst choose, Table, Bar chart, Line chart, Area chart, Pie chart, One big number; sent as `chart_hint`) and an "Ask" button. Enter submits, Shift+Enter makes a new line. Disabled while asking.
- Under the box, until the first answer, the dataset's stored suggestions as buttons (each asks with `source: 'suggested'`). If there are none, show nothing.
- Arriving with `?q=` (from a suggestion card on the dataset page): fill the box and ask once, with `source: 'suggested'` if the text equals a stored suggestion. Then remove `q` from the URL (replace, not push) so a reload does not ask again.
- While waiting (answers take about 5 to 30 seconds): a calm progress state with stages on a timer ("Reading your question", "Running the numbers", "Checking the result", "Writing it up"), announced with `aria-live`, and the sentence "You can leave this page; the answer will be in your history." After 45 seconds say it is taking longer than usual. Do not offer Cancel. If the request fails with a network error, reload the history, because the server saves the answer even if the connection drops.
- The newest answer appears at the top, above the history, and the page scrolls to it and moves focus to its heading.

### The answer card (a `Block`)
- Title, the question as asked, the narrative as plain text (render all text from the API as text, never as HTML), and the time.
- **The chart or table**, drawn from `Block.chart` with Recharts, using only `Block.rows` and `Block.columns`:
  - `table`: a real table with a sticky header, sideways scroll, tabular figures, and the column formats applied.
  - `bar` (vertical or horizontal per `orientation`, `stacked` honoured), `line`, `area`: `x` is the axis, `y` the values, `series` splits series (pivot rows by series value in a pure helper `chartData.ts`; a missing combination is a gap, not zero).
  - `pie`: parts of a whole, with the labels and values written next to or beneath it, not only in a legend.
  - `kpi`: one large formatted value with its label.
  - Every chart has a **"View as table"** toggle showing the same rows in a table, and an `aria-label` made of the title and the number of rows. Never rely on colour alone: use a palette of at most 6 colours that stay distinguishable for colour-blind people, defined once in one constants file, plus direct value labels where they fit and a legend with text. Long category labels use horizontal bars or are shortened with the full text available on focus or hover and in the table view. Axis ticks and tooltips use `lib/format.ts` with the column's `value_format`.
  - Formats: `zar` as `R 1 234,56`, `integer` and `number` with `en-ZA` grouping, `percent` where the API value is a fraction (multiply by 100 for display with one decimal and a `%` sign through `Intl`), `date` as `2 November 2026`, `text` as is. All of it through `lib/format.ts` and `Intl` with `en-ZA`; do not format anywhere else.
  - The chart shows at most the first 500 rows the API gives. If `truncated` is true, say in words: "Showing the first 500 of N rows."
- **Follow-ups:** up to three buttons from `follow_ups`; clicking one asks it (`source: 'user'`).
- **Status:** if `status === 'flagged'`, an amber panel above the chart in words: "Some checks did not pass, so check these numbers before you rely on them", listing each failed check's label and detail. It never hides the answer. A passing block shows a calm "All checks passed" line, not a celebration.
- **Actions:** "This looks wrong" (opens a small form with an optional note up to 500 characters; calls `POST /blocks/:id/feedback` with `kind: 'looks_wrong'`; confirms in words), "Download CSV" (fetch with the token, save the blob; the server counts it as an export), "Delete this answer" (confirm dialog; show a clear message on 409 `conflict`: "This answer is part of a report, so it can't be deleted"). Leave visible room for an "Add to report" action in the actions row but do not build it.

### "How this was calculated" (inside every answer card; a disclosure button, keyboard accessible, collapsed by default on history items, **expanded by default on the newest answer**)
1. A plain sentence: "Analyst wrote a query, ran it on your file, and the numbers below come from that result. The AI did not calculate them."
2. **The query:** `Block.sql` in a read-only monospace block that wraps or scrolls sideways, with a "Copy" button.
3. **Checks:** a list of every `BlockCheck` with an icon and the words "Passed" or "Did not pass", the `label`, and the `detail` if any. For `total_reconciles` show `expected` and `actual` formatted with the matching column's format when it is known, otherwise as plain `en-ZA` numbers.
4. **The rows behind this answer:** only if `has_source_rows`. A button "Show the rows this is based on" calls `GET /blocks/:id/source-rows?limit=50&offset=0` and shows a table with a sticky header and sideways scroll, "Showing 1 to 50 of N", and "Load more" paging. These rows can contain personal details; show a short note: "These are rows from your file. Only you can see this." If `has_source_rows` is false, say why in words ("The original file was deleted" when the dataset is gone or expired, otherwise "This answer uses every row"). Do not build click-to-filter; the `eq_column` parameters stay unused in this part.

### Answer history (below the newest answer)
- `GET /datasets/:id/blocks?limit=20&offset=` newest first with "Load more". Each item is a collapsed row (title, question, date, a "Check the numbers" label if flagged) that expands to the full answer card; only draw a chart when its item is expanded. Empty state: one sentence inviting a first question.
- Reloads when the dataset changes. A block from an expired dataset still shows (with its source-rows explanation).

### Errors (all written out in words)
- 422 `cannot_answer`: show `message` in a panel "Analyst can't answer that from this file", with the suggestions again and a tip to rephrase. Keep the question in the box.
- 402 `plan_limit` for `max_questions_per_month`: open `UpgradeDialog`. 409 `dataset_not_ready`: link to the dataset page. 410 `dataset_expired`: "The original file was deleted on <date>. You can still read your earlier answers." 429: "You're asking quickly; wait N seconds" if `Retry-After` is available, otherwise "wait a moment". 502 `llm_failed`: "We couldn't get an answer just now. Nothing was used from your allowance. Try again." Validation errors show beside the question box.
- Never show a stack trace, SQL error text from the server, or an empty chart.

### Mock mode and real mode
- Extend the mocks with `ask`, `blocks`, `source-rows`, `export.csv` and `feedback` that satisfy the types exactly: one block of every chart type, a flagged block (failed `numbers_from_data` or `total_reconciles`), a truncated block (`row_count` above 500), a `cannot_answer`, a 402, a 409, a 410, a 429 and a 502, and a slow response (about 8 seconds) to exercise the waiting state. The mock numbers are only fixtures for display; never present them as real.
- Use real endpoints **only when marked `DONE` in `docs/STATUS.md`**; otherwise stay on mocks and say so. When they are `DONE`, test the whole flow against the running server with the fixtures.

## Tests (required)
- `chartData.ts` (pure): bar, line, area, pie, kpi and table shapes; series pivoting; gaps; a date axis; a single row; an empty result.
- `lib/format.ts` for each `ValueFormat` with `en-ZA`, including negative values, zero, very large numbers, nulls and fractions as percent.
- Ask form (length limits, Enter and Shift+Enter, disabled while asking, auto-ask once from `?q=` and removal of `q`), the waiting stages and the 45-second message, error mapping for 402, 409, 410, 422, 429 and 502, history paging, the flagged panel (text present, not colour only), the checks list, the SQL panel and narrative rendered as text (a block whose question, SQL and narrative contain `<script>` and `<img onerror>` must render them as inert text), source-rows paging and the has-no-source-rows explanation, the CSV download helper, the feedback form, delete and the pinned 409 message.
- An accessibility pass on the answer card: every control reachable by keyboard, the disclosures expose `aria-expanded`, charts have the table alternative.
- No component computes a sum, average, percentage change, share or any figure; add a short test or lint note that the only arithmetic is the `percent` display scaling inside `lib/format.ts`.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.
2. Walk the whole flow yourself (mock mode, and real mode if the server is `DONE`) at 390px and at desktop width: ask from a suggestion, ask your own question, use a follow-up, open "How this was calculated", copy the SQL, view the source rows and page them, flip a chart to its table view, mark an answer "looks wrong", download the CSV, delete an answer, hit each error. With the real server, use fixtures 01, 02 and 03 and compare at least three displayed figures with the numbers in `fixtures/expected.json` or a hand calculation, and report them.
3. Update the Part 3 cell in the **Client** column of `docs/STATUS.md` and nothing else in that file.
4. Commit: `Part 3 (client): ask, answer cards, how it was calculated`.
5. Tell me: what you built; the commands to run it; which mode you tested; what I should click by hand; the figures you compared; and anything in the contract that seemed wrong or missing (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing).

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or anything outside `client/` (except the one STATUS cell); put any secret in the client; render API text as HTML; calculate or estimate any figure on the client; hide a failed check; build reports, "add to report", sharing, XLSX export, templates or billing; claim support for any named bank, card machine or accounting product.