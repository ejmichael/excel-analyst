# PART 5c (CLIENT): Chart trust fixes, easier report editing, ask from the dataset page

You are the **client engineer** for Analyst OS. Parts 1 to 5b are done and committed. I looked at a real printed report (v2) and tested editing; this prompt fixes what I found. Three groups, in this order: **A. charts must never mislead**, **B. editing a report must let me add questions**, **C. the dataset page needs a way to ask your own question**.
Work **only** in `client/` (plus the Part 5c cell in the **Client** column of the slices table in `docs/STATUS.md`; if there is no 5c row, record it in the S4 Client cell as you did for 5b). No endpoints, fields or error codes are added; use only the existing ones. If you think one is needed, write it in `docs/CONTRACT_CHANGES.md` and STOP.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md`
2. `docs/API_CONTRACT.md`: Questions and blocks (`POST /datasets/:id/ask`, `GET /datasets/:id/blocks`), Reports (`PATCH /reports/:id`), and the business rules for Plan limits
3. Your own code: the chart components and palette, `chartData.ts`, `lib/format.ts`, the report edit mode and its add-answers picker, the Ask screen and its hooks, the dataset page, `UpgradeDialog`, the mocks
Then reply with 6 bullets of what you understood (include: which of the three groups touch figures and why none may compute one, what an ask costs the user, which existing endpoints you will call, and what is NOT being built). Then start.

## A. Charts must never mislead (this is a trust bug, fix first)
Found in a real report: a bar chart of counts from 1 to 3 had axis labels `0, 1, 2, 2, 3`. The ticks were really at 0, 0.75, 1.5, 2.25 and 3 and were rounded for display, so a bar of value 1 ended past the label "1". A reader cannot trust that. Also, a stacked chart with 8 series reused the same green for two series and the same amber for two others, so the legend was ambiguous.
1. **Whole-number axes.** When the value format is `integer` (or every plotted value is a whole number), the value axis shows whole-number ticks only: no fractional ticks, no duplicate labels, and every tick label equals its true position (for example `allowDecimals={false}` and a tick count that fits the range). A range of 0 to 3 shows 0, 1, 2, 3. Percent, ZAR and decimal axes keep their formats and never round a tick to a wrong label. Apply to bar (both orientations), line, area and stacked charts, on screen, in print and on the shared page.
2. **Distinct series colours.** A chart never gives two series the same colour. Use an ordered palette of at least 10 clearly different colours (brand colour first, with the Part 5b contrast guard; then amber, blue, pink, sky and then at least five more that are not another green or a close shade of an earlier one). Check the palette with a small script that every pair is clearly distinct (for example CIE76 ΔE of at least 25) and keep that script's result in the tests. If a chart has more than 10 series, vary the extra ones with a hatch pattern so no two look alike. The legend always names each series.
3. **Print chart size.** In print and on the shared page's print, a horizontal bar chart is about 5mm per category with a maximum height of about 95mm, a vertical or line chart a maximum of about 75mm, so two chart answers can share a page. Bars keep sensible thickness (not full-height slabs). Labels stay readable (at least 7pt on paper). Keep the Part 5b rule that a chart answer is never split.
4. Do not change any figure, label text or order of the data. Do not compute anything; ticks come from the chart library's scale over the values it was given.

## B. Editing a report: adding questions and answers
Found: in edit mode the only way to add an answer is a small "Add answers" button in the bottom bar. It lists answers that already exist, so when all of a file's answers are already in the report there is nothing to add, and there is no way to ask a new question from here. The bottom bar also covers the last fields on screen.
1. **The bottom bar must never cover content.** Add bottom padding equal to the bar's height (including on phones and with the keyboard open) so every field and block above it can be reached.
2. **Make adding obvious.** In edit mode show an "Add an answer" button at the end of the answer list as well as in the bar, with the count ("3 of 30 answers"); at 30 it is disabled with the reason in words.
3. **The picker:** choose a file (default: the dataset the report is mainly from; list this workspace's datasets), then list that file's answers not yet in the report, newest first, with title, question and date, and a search box. If every answer is already in the report, say so in one sentence ("Every answer for this file is already in the report. Ask a new question below.").
4. **Ask a new question in the picker.** Under the list, a text box "Ask a new question about this file" (the Ask screen's length limit, and its quota note from `Me`). Submit calls the existing `POST /datasets/:id/ask`; show progress; on success the new answer is added to the report's local edit list at the end and the picker closes or shows it ticked. It is saved only when the user chooses Save changes, as for other edits. Map errors exactly as the Ask screen does (402 opens `UpgradeDialog`, 409, 410, 422 and the "could not answer" outcome in words). A question that cannot be answered is not added. Reuse the Ask screen's hooks and answer handling; do not copy them.
5. **"Parts" are out of scope.** Reports hold answers plus the notes field. Text or heading blocks are not in the contract. Do not build them. Mention in your report that notes are the only free text, so I can decide later.

## C. Ask your own question from the dataset page
Found: the dataset page shows only suggested questions; typing your own is only possible after clicking a suggestion. Under the dataset header, above the suggestions and the "Build my report" panel, add a single-line box "Ask your own question about this file" with a visible label, an "Ask" button, and one plain line: "You can ask anything about this file. Analyst shows how it got each answer." Submitting opens the Ask screen for this dataset with the question prefilled (use the same mechanism as clicking a suggestion). Disabled while the dataset is not `ready`, with the reason in words. Works at 390px.

## Tests (required)
- A: integer axis ticks are whole numbers, unique, and each equals its position for ranges 0 to 3, 0 to 1 and 0 to 5000; percent and ZAR axes unchanged; a 10-series chart gets 10 distinct colours and an 11th is hatched; the palette distance check; print chart height caps; the "no arithmetic" tests still pass.
- B: the bottom bar never overlaps the last field (assert the padding); the picker lists only answers not in the report; the empty sentence; ask-in-picker success adds one answer at the end and enables Save; each error maps in words; an unanswerable question is not added; nothing is sent until Save; 30 limit; text from the API stays inert.
- C: the box, prefill and navigation; disabled when not ready.

## Verify with real rendering
Playwright with Chromium: render the Logistics Leads report (real mode) with `page.pdf()` on A4 and look at every page: whole-number axes on every count chart, distinct stacked colours, and fewer half-empty pages than before (before: 5 pages for this report). Take screenshots of edit mode at 390px and desktop with the bar not covering fields, of the picker with the ask box, and of the dataset page with the new box. Say what you saw and where the images are.

## Finish
1. `npm run typecheck`, `npm test`, `npm run build`; fix everything.
2. Commit in three stages (A, B, C), only after the tests pass. If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
3. Tell me: what you changed; page count before and after for the Logistics report; what I should check by hand (a count chart's axis against its bars, asking a new question while editing a report, the dataset-page box); anything that did not match this prompt.

## Do not
Touch `server/` or any contract file; add endpoints, fields or error codes; add packages unless a palette check needs none (prefer a small local script); compute, round or reorder any figure; build text or heading blocks, dashboards, filters or templates; hide or soften a failed check; put a secret in the client.