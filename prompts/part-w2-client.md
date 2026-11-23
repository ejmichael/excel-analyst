# PART W2 (CLIENT): the Dashboard tab

You are the **client engineer** for Analyst OS. Parts 1 to 5c and W1 are done and committed. A second Claude Code chat works in `server/` on the matching server part (it never touches your files, and you never touch `server/`).
Work **only** in `client/`, plus the Client column of the slices table in `docs/STATUS.md`. Do not edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or `docs/CONTRACT_CHANGES.md`. If you need anything the contract does not have, stop and tell me.
The server's contract commit for this part is `Contract: dashboard` (commit `28ff838`). Copy `docs/api-types.ts` verbatim into the client as before. Until the server marks the three dashboard endpoints `DONE` in `docs/STATUS.md`, build against typed mocks behind `VITE_USE_MOCKS=true`.

## What this part is
Each ready file gets a **Dashboard tab**: headline numbers, charts and a filter bar, planned once by the model and run by the server. It becomes the **default tab**. You show what the server sends. **The client never computes a figure** (no totals, shares, differences, averages, or "previous period"); the only numbers you may write yourself are plain counts taken from fields the server sends (`rows_in_scope`, `rows_total`, the number of selected filter values).
Tab order now: **Dashboard, Data, Quality, Ask, Reports** (Insights will be added later; keep the tab list driven by one array).

## Read first (only these, in this order)
1. `CLAUDE.md` and `docs/STATUS.md` (the W2 notes from the server, if any)
2. `docs/API_CONTRACT.md`: the three dashboard rows in the Datasets table and the "Dashboard" paragraph; the error codes (note the new `dashboard_not_ready`); the rate-limit rules
3. `docs/api-types.ts`: `Dashboard`, `DashboardStatus`, `DashboardReading`, `DashboardFilter`, `DashboardFilterValue`, `DashboardDataRequest`, `DashboardWidget`, `DashboardWidgetWidth`, `WidgetResult`, `DashboardData`, `ChartSpec`, `ValueFormat`, `BlockCheck`
4. Your own code: the file workspace shell and tabs (W1), the Ask answer card and its chart components, the value formatter, the Quality tab (for its issue links), the theme tokens
Then reply with 8 bullets of what you understood. Include: what starts a planning run and how you make sure it starts only once per visit; what you show while planning, when it failed, and when `fallback` is true; how a filter reaches the server and what you do while its response is loading; what a widget with `error` looks like and what the rest of the page does; which figures the client may and may not compute; and which buttons from the design are **not** built in this part. Then start.

## Look (keep every existing theme token; add no new colours)
Same identity as the rest of the app: warm off-white page `#F6F5F0`, white cards with a 1px `#D9D8CE` border and 16px radius, ink `#16231F`, muted `#56625C`, accent green `#1E7A5F`, Space Grotesk headings, Inter body, sentence case, no all-caps eyebrows, no emoji, touch targets at least 44px, colour never the only signal. Single-series charts are green; multi-series charts use the series palette from Part 5c.

## Build exactly this

**1. Tab and routing.** Add `dashboard` as the first tab and the default. `/datasets/:id` and unknown tabs redirect to `/datasets/:id/dashboard`. Old `?q=` links keep working as before. The existing tabs and their tests stay as they are.

**2. Loading the dashboard (states).**
- On opening the tab call `GET /datasets/:id/dashboard`. A 404 means "none yet": call `POST /datasets/:id/dashboard` **once** (guard it so React strict mode, a remount or a re-render cannot send it twice; the model call costs money) and poll `GET` every 2 s until `ready` or `failed`.
- **Planning:** a calm card, "Analyst is planning your dashboard", with the line "This takes about a minute the first time" and skeleton tiles underneath. After 60 s add "Taking longer than usual. You can keep using the other tabs." Leaving the tab must not cancel anything; coming back resumes polling.
- **Failed:** the server's `error_message` in plain words, a **Try again** button (POST again) and a link to the Ask tab.
- **Fallback:** when `fallback` is true show a muted note above the filters: "This is a basic dashboard. Analyst could not plan a custom one for this file." with a **Try again** button.
- **Ready:** the page below. A **Rebuild dashboard** link in the reading note opens a confirm dialog ("Analyst will plan the dashboard again and replace this one.") and then POSTs.
- Errors: 409 `dataset_not_ready` and 410 `dataset_expired` in words (as on the other tabs), 429 with the server's message and no automatic retry, network errors with Retry.

**3. The page (ready).**
- **Reading note:** one line, "Analyst read this file as: {reading.text}", with Rebuild dashboard.
- **Filter bar** (one control per `DashboardFilter`, in the order sent; hidden entirely when there are none):
  - `date_range`: two date inputs, From and To, with `min` and `max` from the filter, labelled with the filter's `label`. If From is later than To do not send a request; show an inline message ("From must be on or before To").
  - `category`: a button showing "{label}: All" or "{label}: 3 selected" that opens a popover with a search box and a checkbox list of `options` (Escape closes and returns focus to the button; Select all and Clear inside).
  - A **Clear all** button when anything is active, and a text line "{rows_in_scope} of {rows_total} rows" from `DashboardData`.
  - Active filters are kept in the URL (`?filters=` with compact JSON, validated on read; an invalid or unknown value is ignored) so refresh and the back button keep them.
- **Data requests:** every change of filters calls `POST /datasets/:id/dashboard/data` (debounced 300 ms; one request per settled change). The unfiltered request runs on first load. Keep the previous results on screen, dimmed, while the next loads; ignore any response that is not for the current filters. Never call the model or `POST .../dashboard` because of a filter.
- **Grid:** `width` decides the span. Desktop (1024px and up): `quarter` 3 of 12 columns, `half` 6, `full` 12. Tablet: `quarter` 6, others 12. Phone: `quarter` 6 (two tiles per row), others 12. Widgets in `position` order.
- **Widget rendering** (white card, the widget's `title` as a small heading):
  - `kpi`: one big value from the first row's first `y` column, formatted by its `value_format` with the existing formatter (rand, `en-ZA` numbers, percent from fractions). A null shows "–". Nothing else on the tile except the title.
  - `bar`, `line`, `area`, `pie`: use the existing chart components with the widget's `ChartSpec` and rows, including the Part 5c fixes (whole-number axes, distinct series colours). Give each chart an accessible name (`aria-label` = the title) and a visually hidden or toggled data table so the numbers are reachable without sight.
  - `table`: a table with a sticky header showing 10 rows, with **Show all {N}** expanding to the rows sent (at most 50).
  - A widget with `error`: the card keeps its title and says "This could not be built for this selection." (and, when filters are active, "Try changing the filters."). The rest of the page is unaffected.
  - Empty result under filters: "No rows match these filters." inside the card.
  - A truncated result shows the visible warning "Showing the first 50 of {total_rows} rows" (from the server's numbers).
  - **Show the working** (a disclosure on every widget): the SQL (read-only, monospace, with a Copy button), the checks as the Ask answer card shows them (a failed check shows a visible warning, never a silent pass), and the result rows in a table.
- **Not built in this part (no buttons, no placeholders):** Customise, Save to a report, Excel, Download PDF, Share a snapshot, insights, previous-period comparison.

**4. Quality tab follow-up.** Hide the **See the rows** link on issues of kind `inconsistent_case` and `stray_whitespace` (the search cannot isolate those rows). Keep it for the other kinds.

**5. Mocks.** Typed mocks for all three endpoints: a ready dashboard with 8 widgets across `kpi`, `bar`, `pie`, `line` and `table`; a `planning` response that turns `ready` on the third poll; a `failed` one; a `fallback` one; a filtered response whose rows differ from the unfiltered one; one widget with `error`; one empty result.

## Tests (required)
- Routing: default redirect to the dashboard, each tab URL, old dataset URL, old `?q=` links.
- Loading: 404 then exactly one `POST` (including under strict mode and remount), polling stops at `ready` and `failed`, the 60 s message, failed and fallback states, Try again, Rebuild with confirm, 409, 410 and 429 messages.
- Filters: both kinds render from the contract; From later than To sends nothing; category search, select all, clear; Clear all; the row count text; URL sync, an invalid URL value is ignored; a settled change sends one request; stale responses are ignored; the page shows previous results dimmed while loading; no call to `POST .../dashboard` when filters change.
- Widgets: each chart type renders from a fixture; kpi formats (rand, integer, percent, null); the grid span for each width and breakpoint; error widget; empty result; truncated warning; Show the working contents (SQL, checks including a failed one, rows); table Show all; accessible names and the data table for charts; no dead buttons (none of the not-built actions appear).
- Quality tab: See the rows is gone for `inconsistent_case` and `stray_whitespace` and still there for others.
- Accessibility: keyboard use of the filter popover, focus return, visible focus, `tablist` unchanged.
- Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.

## Verify in a real browser
Once the server marks the endpoints `DONE`, use Playwright with a throwaway user: upload fixture 02 and a small text-only leads CSV you write in your scratch folder (business, contact, job title, website; about 25 rows), open the Dashboard tab and let it plan. Screenshot at 1360 px and 390 px (deviceScaleFactor 1): planning, ready, a category filter on, a date filter on (fixture 02), the working open on one widget, and the fallback if you can provoke it. Check against the real server: the record-count tile equals the file's row count; with a filter set, the record-count tile equals a count you compute in your **verification script** over the CSV rows (not in product code); a filtered response never changes the layout; no page scroll at 390 px; the planning request is sent exactly once in the network log. If the server part is not `DONE`, say so and verify against the mocks. Delete the throwaway user and its data afterwards.

## Finish
1. Update the Client column in `docs/STATUS.md` (`DONE` only after tests and the browser check pass).
2. Commit in stages (1: tab, routing and loading states, 2: filter bar and data requests, 3: widgets and the working panel, 4: Quality tab follow-up, mocks, tests and STATUS). If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
3. Tell me: what you built; anything that differs from this prompt; the screenshot paths; and what I should test by hand (open a file, wait for the plan, change a filter and compare a tile with the file, open "Show the working" on two widgets, rebuild the dashboard, open a file with only text columns).

## Do not
Touch `server/` or `fixtures/`; edit the contract files; compute any figure, share, total or comparison in the client; call `POST .../dashboard` for any reason except first open, Try again and confirmed Rebuild; build Customise, Save to a report, Excel, PDF, Share a snapshot, Insights or previous-period comparison; add new colours; change the Ask answer card, the report pages or the print layout; log or store row values; commit anything outside `client/` and your STATUS column.