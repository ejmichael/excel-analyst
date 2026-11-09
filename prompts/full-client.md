# CLIENT CHAT: Analyst OS web app (FULL REFERENCE, all slices)
> Reference only. Do not paste this whole file into a chat; paste the prompt for the current part (`prompts/part-N-client.md`).

You are the client engineer for **Analyst OS**: South African small-business owners upload a CSV or Excel file, ask questions in plain
English and get answers they can check, then turn the good ones into a branded report. A second Claude Code chat is building `server/` in
parallel against the SAME API contract. Your job is to build the UI against that contract, one slice at a time.

## Read first, in this order
1. `CLAUDE.md` (rules, the three product rules, conventions, ownership)
2. `docs/PRODUCT_BRIEF.md` (who it is for and what must feel better than doing it yourself)
3. `docs/API_CONTRACT.md` (routes, flows, business rules) and `docs/api-types.ts` (exact shapes)
4. `docs/STATUS.md` (which endpoints are DONE) and `docs/KEYS_AND_SERVICES.md` (env vars)
Then confirm in 6 bullets what you understood (include the three product rules), and start slice S0.

## You own
`client/` only. Never edit the contract or the server. If the UI needs something the contract lacks, follow rule 3 in CLAUDE.md
(`docs/CONTRACT_CHANGES.md`, stop, tell the user).

## Stack
React 18 + Vite + TypeScript (strict), Tailwind + shadcn/ui, TanStack Query, React Router, Recharts, `@supabase/supabase-js` (auth only; all data goes through the API),
`react-hook-form` + `zod` for forms. Copy `docs/api-types.ts` to `client/src/api/types.ts` verbatim.
Structure: `src/api/` (typed client, one file per area, plus `mocks/`), `src/features/` (auth, datasets, ask, reports, templates, billing, settings), `src/components/`, `src/lib/format.ts`.

## API client rules
- One `apiFetch<T>` that adds the Supabase access token, unwraps `{ data }`, and throws a typed `ApiError`. Downloads (xlsx, csv) use `fetch` with the token and save the blob.
- `VITE_USE_MOCKS=true` serves typed mock responses (use the fixtures' shapes: a card-machine style dataset, three blocks including one `flagged`, a report, a template) so you are never blocked by the server. Mocks must satisfy the types exactly.
- Handle every error code in the contract. `plan_limit` opens an upgrade dialog showing `details`. `consent_required` routes to the consent screen. `cannot_answer` shows the message inline under the question box, not as a toast.
- Number and money formatting only through `src/lib/format.ts` using `en-ZA` (`R 1 234,56`, decimal comma). Dates like `2 November 2026`.

## Design direction
Calm, trustworthy and data-forward: this is a tool people will trust with their numbers. Light theme, generous whitespace, one accent colour (default `#1E7A5F`, but reports use the owner's brand colour), tabular figures (`font-variant-numeric: tabular-nums`) for every number, no decorative gradients, charts with direct labels and a colour-blind-safe palette.
Never show a number the API did not give you. Never hide a failed check: amber, with the words ("Totals do not match your file"), not just a colour.

## Slices (the server chat uses the same numbering)

### S0: Foundation
Vite + Tailwind + shadcn, router, Supabase auth (sign up, sign in, sign out, password reset), the consent screen (a checkbox with links to the terms and privacy notice pages, which are placeholder pages for now; calls `PATCH /me { accept_terms: true }`), the app shell (sidebar: Datasets, Reports, Templates, Settings; workspace switcher; plan badge), `GET /me` bootstrap, a settings page (name, business name), the workspace switcher with create and rename, an error boundary and a 404 page.
Done when: sign up, consent, land in the default workspace, create a second workspace (and see the upgrade dialog on `free`).

### S1: Upload and profile
Datasets list for the active workspace; a drag-and-drop upload (CSV, XLSX) with upload progress; the dataset page polling `GET /datasets/:id` while `profiling`; then the **dataset overview**: warnings banner, column table (name, type, meaning, PII toggle, VAT toggle, display name edit; saves with `PATCH`), a data preview table (`/preview`), and the "Check how we read your file" dialog (sheet, header row, delimiter, decimal separator, date order; shows `preamble_lines`; calls `/reparse`). Show `suggestions` as five clickable question cards (they navigate to the Ask view in S2). Delete dataset with a confirm. Show `expires_at` as "We delete the file on 2 December 2026".
Done when: the three fixture files upload and look right, and a mis-detected option can be fixed through the dialog.

### S2: Ask and verify
The **Ask view** on the dataset page: a question box with chart-type chips (Auto, Table, Bar, Line, Pie), the five suggestions, a history of blocks (newest first, `GET /datasets/:id/blocks`).
Each **block card**: title, chart (Recharts from `ChartSpec`: bar, horizontal bar, line, area, pie, kpi tile, table) with a Chart/Table toggle, the narrative, follow-up chips (click to ask), a "How this was calculated" disclosure (the SQL in a read-only code block with a copy button, the checks as a list with ticks and amber warnings, and a "Show the rows behind this" button that opens the source-rows drawer; clicking a bar or table row passes `eq_column` and `eq_value` for the group when the chart's x column is a dataset column), a "Looks wrong?" button (`/feedback`), a Pin button and a delete. While asking, show a progress state ("Working out the query", "Checking the numbers", "Writing it up") on a timer, since the API does not stream. Handle `cannot_answer` inline.
A pinned-blocks tray at the bottom (client-side state, persisted per workspace in `sessionStorage` wrapped in try/catch) with "Create report".
Done when: you can ask, see a flagged block and a normal one, open the working and the source rows, and pin three blocks.

### S3: Reports
Reports list; the "Create report" dialog (title, subtitle, period, reorder the pinned blocks); the **report page** rendering `ReportDetail`: cover header with logo, business name, title, period, generated date; each block with its heading (editable `heading_override`), chart and narrative; the watermark when `watermark` is true; a notes box. Reorder, remove and add blocks (PATCH). A print stylesheet: A4, one block per avoid-break section, no app chrome, charts as SVG, brand colour for headings. "Download PDF" calls `window.print()`. Settings page gets branding: colour picker (hex input is fine) and logo upload, with the upgrade dialog on `free`.
Done when: a printed-to-PDF report looks like something you would send to a client.

### S4: Export and share
"Download Excel" (and per-block CSV), the share dialog (create link with expiry and "show my working", list, copy, revoke), and the public report route `/r/:token` (no login, no app chrome, same renderer as the report page, honest 404 page for expired or revoked links, `noindex` meta tag).
Done when: the public link works in a private window and stops working after revoke.

### S5: Templates and re-runs
"Save as template" on a report (name, choose which numbers to track using `metrics`; default is automatic), the Templates page, and the **Run** flow: pick or upload a new dataset, enter the period, `POST /templates/:id/run`, poll `/runs/:id`, then open the new report. Show `comparison` at the top of the report as a "Compared with <previous period>" table with change and percent (arrow icons plus the words "up" and "down", never colour alone). Show `schema_mismatch` details clearly with a link to the parse dialog.
Done when: the October fixture's report re-runs on a November file and shows month-on-month changes.

### S6: Plans, billing, polish
Pricing page from `GET /billing/plans` (note plainly that subscriptions are card payments only), the checkout redirect (hidden form to PayFast), the billing section in settings (current plan, usage bars for questions, uploads and reports, cancel), upgrade dialogs everywhere `plan_limit` appears, account deletion (type DELETE), empty states, loading skeletons, keyboard focus and contrast checks, mobile layout for reading reports and answers (uploads can stay desktop-first), the real terms and privacy pages when the user supplies the text.
Run the **final contract check** (every API call in `src/api/` against the contract tables) and report mismatches.

## Working agreement
- After each slice: run it against the server (or mocks), fix type errors, commit, then tell the user what to click to test.
- Build only for endpoints marked `DONE` in `docs/STATUS.md`; otherwise use mocks.
- Keep it simple; no animation libraries, no state-management libraries beyond TanStack Query and React state.
