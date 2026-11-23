# PART W2b (SERVER): trust fixes found while testing a real file

You are the **server engineer** for Analyst OS. Parts 1 to 5c, W1 and W2 are done and committed. A second Claude Code chat works in `client/` on a matching polish part; you never touch `client/`.
Work **only** in `server/`, `db/migrations/` and `docs/STATUS.md`. You may also edit `docs/LLM_PROMPTS.md` (the two sentences in item 3 only) and `docs/ARCHITECTURE.md` (the one sentence about allowed functions in section 4, item 5 only). Do not touch `docs/API_CONTRACT.md` or `docs/api-types.ts`: nothing here changes a shape, field or error code. If you think something does, stop and tell me.

## Why this part exists
The user tested W2 on a real file ("Booking app", a leads list exported from a spreadsheet, 115 rows, 10 columns) and found five problems that make answers misleading or waste money. They are small, they all touch what the data means, and they must be fixed before anything is built on top.
1. **Spreadsheet error cells are read as values.** The Phone column holds the text `#ERROR!` in 81 of 115 rows (a broken formula in the source). The dashboard then counted those 81 as "has a phone number". A formula error is not a value.
2. **A pie chart was used for overlapping counts.** "Contact details available" showed Phone 81, Email 19, Website 46 as slices of one donut. They overlap (81 + 19 + 46 is more than the 115 rows), so a pie says something false.
3. **Questions and widgets about columns that are completely empty.** Two columns were empty in every row, and one suggested question asked about outreach by date.
4. **A harmless figure was dropped by the personal-data rule.** `WHERE "email" IS NOT NULL` (how many leads have an email) was treated like reading the email.
5. **`trim()` is rejected by the sandbox validator**, which costs a repair call (double the price) whenever the model uses it, and the cleaning part will need it.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md`
2. `docs/ARCHITECTURE.md` sections 2 (life of an upload), 4 (the SQL sandbox, especially how functions are checked) and 5
3. `docs/LLM_PROMPTS.md` sections 1, 2 (chart rules) and 5
4. Your own code: the XLSX and CSV readers and the normalising step, the profiler and `warnings`, the reparse route, the suggestions generator, the dashboard planner and its widget validation, the fallback dashboard, the sandbox validator and its escape-attempt tests
Then reply with 6 bullets of what you understood. Include: where an Excel error cell is currently turned into text, what the sandbox validator does with a function name and why `trim` fails, which columns the suggestions and dashboard planner currently see, and what must not change in the sandbox. Then start.

## Build exactly this

**1. Spreadsheet error cells become empty, with a warning.**
- In the readers: an XLSX cell of error type, and any text cell (CSV or XLSX) that equals, after trimming and ignoring case, one of `#ERROR!`, `#N/A`, `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#NULL!`, `#NUM!`, `#SPILL!`, `#CALC!`, `#GETTING_DATA`, is stored as **empty** in the normalised file. They must not influence type detection, distinct counts, min and max, samples or semantic guesses.
- Count them per column. Add one entry per affected column to the dataset's `warnings` (plain strings, no contract change): `"Phone: 81 cells held a spreadsheet error such as #ERROR! and were read as empty."` At most 5 such lines, then one line `"and N more columns also held spreadsheet errors."`
- Reparse must apply the same rules. A reparse also deletes the dataset's stored dashboard row (so the client plans a fresh one) and clears the cached quality result.
- Tests: an XLSX built in the test with error-type cells (use the dev dependency already in the repo) and a CSV with the text `#ERROR!`; counts per column; the cells are null; a column that is all errors becomes all empty and shows up as an empty column; type detection unchanged for the rest of the column; the warning text; more than 5 columns; reparse deletes the dashboard.

**2. Completely empty columns stay out of what the model plans from.**
- Columns where every row is empty are **not** sent to the suggestions generator or to the dashboard planner (neither in the schema lines nor in the samples), and are not used by the fallback dashboard or as filters. The Ask planner keeps seeing them (a user may ask about one and should get a clear "cannot answer").
- Tests: the suggestions input and the dashboard planner input exclude them; the Ask planner input includes them; the fallback ignores them.

**3. Pie charts only for parts of a whole.**
- Add this sentence to the chart rules of `docs/LLM_PROMPTS.md` section 2, replacing "Pie only for up to 6 parts of a whole.": `Pie only for up to 6 parts that do not overlap and add up to the whole (every row falls in exactly one slice). Counts of rows that have each of several attributes overlap, so use a bar chart for those.` Section 5 says the planner rules apply unchanged, so also add the same sentence to the "Order and mix" breakdowns bullet there.
- Add a **server-side safety check** in the dashboard planning validation **and** in the Ask pipeline's chart validation: if `chart.type` is `pie` and the pie's value column has `value_format` `integer` and the values add up to more than the number of rows in the file (a sign the slices overlap), change the chart to a horizontal `bar` (same x and y, `stacked` false) instead of dropping it. This is the one permitted change to the Ask pipeline; do not touch anything else in it.
- Tests: an overlapping pie becomes a horizontal bar in a dashboard and in an Ask answer; a real pie whose slices add up to the row count is untouched; a pie of a non-count column is untouched.

**4. Null checks on personal-data columns are allowed in dashboard widgets.** Today any use of a personal-data column outside COUNT or COUNT(DISTINCT) drops the widget. Also allow `IS NULL`, `IS NOT NULL`, and `COUNT(*) FILTER (WHERE "col" IS [NOT] NULL)`. Everything else about a personal-data column (selecting it, grouping by it, comparing it to a value, using it in an expression) still drops the widget. Tests for each allowed and each still-forbidden form.

**5. The sandbox accepts a fixed list of safe text functions.** Make the validator accept these scalar functions, unqualified: `trim`, `ltrim`, `rtrim`, `lower`, `upper`, `replace`, `regexp_replace`, `substr`, `substring`, `length`, `split_part`, `concat`. Find out why `trim` is currently rejected (it is parsed as a qualified function) and fix it without loosening anything else: every function that reads files, lists files or environment, runs system commands, or loads extensions stays rejected, and a qualified name (`schema.func(...)`, `main.trim(...)`) stays rejected. Update the one sentence in `docs/ARCHITECTURE.md` section 4 that lists what is allowed. **Every existing escape-attempt test must pass untouched**; add tests that each listed function runs in a query and that `read_csv`, `read_text`, `glob`, `getenv`, `current_setting`, `system`, `load` and a few qualified names are still refused.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run test:integration`; fix everything.
2. Real-model check (opt-in, `RUN_LLM_TESTS=1 npm run test:llm`, a few cents): upload a file shaped like the Booking app (generate it in the test, not in `fixtures/`): 115 rows, business, niche, area, a phone column where 70% of cells are the text `#ERROR!` and the rest are numbers, an email column mostly empty, a website column half empty with a mix of http and https, and two completely empty columns (date email sent, outreach sent). Plan the suggestions and the dashboard and show me: the warnings, the five suggested questions, every widget (title, chart type), and whether any pie survived. Report cost.
3. Update `docs/STATUS.md` with a note for the user: files uploaded before this part keep their old reading; open the file, press Change, and re-read it to apply the new rules (this also re-plans the dashboard).
4. Commit in stages (1: error cells, 2: empty columns, 3: pie rule, 4: null checks, 5: sandbox functions, 6: tests and STATUS). If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
5. Tell me: what you built; the real-model result; anything you could not verify; and what I should try by hand (re-read the Booking app file with Change and check the Phone column in the Data tab, the warnings, the Dashboard and the suggested questions).

## Do not
Touch `client/` or `fixtures/`; edit contract files; change the quality score rules (the user is still judging them on real files); change anything in the sandbox beyond item 5; change the Ask pipeline beyond the pie check; add endpoints, fields or error codes; log row values; put a secret in any committed file.