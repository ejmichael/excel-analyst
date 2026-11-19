# PART 5 (CLIENT): Download, share and the public report page (slice S4)

You are the **client engineer** for Analyst OS. Parts 1 to 4b are done and committed (sign-in, upload, profile, asking, answer cards, reports, branding, one-click draft report). A second Claude Code chat is building the export and sharing endpoints in `server/` in parallel against the same contract.
Work **only** in `client/` (plus the Part 5 cell in the **Client** column of the slices table in `docs/STATUS.md`).
This prompt covers **Part 5 only**: Download PDF (through the browser's print function), Download Excel, share links, and the public report page at `/r/:token`. Do not build templates, comparison or billing.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` (which S4 endpoints are `DONE`, and the server's notes) and `docs/CONTRACT_CHANGES.md`
2. `docs/API_CONTRACT.md`: the Reports and Sharing tables, Flow C, and the business rules for Exports and Public reports (the server chat applies the share-link contract changes as its first commit; if they are not there yet, stop and tell me)
3. `docs/api-types.ts`: compare with `client/src/api/types.ts` and re-copy verbatim. Read `ShareLink` (including `contains_personal_data`), `CreateShareLinkRequest`, `PublicReport`, `ReportDetail`
4. `docs/PRODUCT_BRIEF.md` for tone
5. Your own code: the report page and its actions row ("Coming soon" placeholders), the answer card and chart components, `lib/format.ts`, the API client (token handling and the download helper from the CSV export), `UpgradeDialog`, the router, the mocks
Then reply with 6 bullets of what you understood (include: what a visitor to a public link may see, what `show_working` changes, why the public page must send no credentials, what `contains_personal_data` is and is not, and which endpoints you may call for real versus mock). Then start.

## Look and feel
Same as earlier parts (warm off-white, ink, accent `#1E7A5F`, white cards with 1px borders and 16px radius, Space Grotesk headings, Inter body, tabular figures). Every control has a visible label, a focus ring and a 44px touch target; warnings in words, never colour alone; works at 390px. The user's brand colour and logo apply only inside the report header and accents.

## Build exactly this

### 1. Download PDF (print)
- Replace the placeholder with a **"Download PDF"** button on the report page that calls `window.print()`, with a short hint under it: "Choose Save as PDF in the print window." 
- Write a **print stylesheet** (`@media print`) so that the printed report is the report only: A4 portrait with sensible margins, no app chrome (header, navigation, tray, buttons, banners, edit controls), the brand header on the first page, each answer kept together where it fits (`break-inside: avoid`) with a page break before an answer that would split, charts and tables printed in colour with `print-color-adjust: exact` for the brand band and chart colours, tables wrapped so no column is cut off (shrink the font or allow wrapping, never clip), "View as table" content hidden in print unless the chart is shown as a table, the watermark line at the end when `watermark` is true, and the generated date and page-friendly footer. The "How this was calculated" disclosures print **closed**. A flagged answer prints with its warning text.
- If Playwright with Chromium is available on this machine, generate PDFs of a real report with `page.pdf()` (A4) for a small report (3 answers) and a large one (30 answers), rasterise the pages and look at them: nothing clipped, no blank pages, brand header and watermark present, charts visible, long tables paginated. Say what you checked. If it is not available, say so and list what I should check by hand.

### 2. Download Excel
- A **"Download Excel"** button: fetch `GET /reports/:id/export.xlsx` with the token and save the blob (reuse the CSV download helper), using the file name from `Content-Disposition` (fall back to `<title>-<date>.xlsx`). Show a busy state, a written error for 402, 404, 409, 429 (with the `Retry-After` seconds) and 502, and never leave the button stuck.

### 3. Share
- A **"Share"** button opens a share dialog:
  - **Create a link:** choose expiry (7 days, 30 days, 90 days, "No expiry") and a checkbox "Show how each answer was calculated (the SQL and checks)", default off, with a one-line explanation. A short sentence states plainly what a link does: "Anyone who has this link can see this report, including every table in it. They don't need an account."
  - If the report's links include `contains_personal_data: true` (or the response to creating one does), show a clear amber notice before and after creating: "This report may contain personal details such as names, emails or phone numbers. Check the tables before you share it." State that this is a best-effort check, not a guarantee.
  - **Existing links:** list them (`GET /reports/:id/share-links`) with created date, expiry, whether working is shown, view count, status in words ("Active", "Expired", "Turned off") and **Copy link** and **Turn off** (confirm; `DELETE /share-links/:id`) buttons. Copy uses the clipboard API with a visible fallback (a read-only text field the user can select) and a written "Link copied" confirmation.
  - **Free plan:** if the server answers 402 for `share_links`, open `UpgradeDialog`. Do not hide the button.
- The full link is shown at creation and in the list because the server returns it to the owner; never put a token in logs, error messages, analytics, the browser history of other pages or the page title.

### 4. The public page (`/r/:token`)
- A route outside the authenticated app shell: **no sign-in, no app navigation, no workspace switcher, no consent gate, and no `Authorization` header** (use a plain fetch to `GET /public/reports/:token`, not the authenticated API client). Nothing from the visitor is stored (no localStorage, no cookies of your own).
- Set `<meta name="robots" content="noindex, nofollow">` and `<meta name="referrer" content="no-referrer">` for this route only, and a neutral page title (the report's title).
- Render the report like the owner's report page (brand header with logo and colour, title, subtitle, period, answers in order with charts, narrative and, for a `flagged` answer, "Check the numbers" with its warning), **without any owner controls** (no edit, add, delete, share, download Excel, feedback). Keep the "Download PDF" button (print) and the print stylesheet from step 1. Show the watermark line when `watermark` is true. Show "How this was calculated" only if the response includes SQL or checks (`show_working`); never show a source-rows button.
- If the logo image fails (its URL expires after an hour), reload the report payload once to get a fresh URL, then give up quietly.
- **Unavailable links:** for a 404 show one friendly page for every case: "This link isn't available. It may have expired or been turned off. Ask the person who sent it for a new link." Never say which. For 429 say to wait a moment. For network errors offer "Try again".
- All text from the API is rendered as text, never as HTML.

### Mock mode and real mode
- Extend the mocks: `GET export.xlsx` (return a small valid blob and a `Content-Disposition` header), share links create, list and revoke (including `contains_personal_data` true and false, expired and revoked states), and the public report endpoint for a valid token, an expired token, a revoked token and an unknown token (all four of the last three return the same 404), a `show_working` variant, a `watermark` variant, and a 429. Mocks must satisfy the types exactly.
- Use real endpoints **only when marked `DONE` in `docs/STATUS.md`**; otherwise stay on mocks and say so. When they are `DONE`, test the whole flow against the running server.

## Tests (required)
- Download PDF button and the print stylesheet (assert the key print rules exist: chrome hidden, disclosures closed, break rules, the watermark line, brand colour adjust), the Excel download helper (file name from the header, fallback name, each error mapped, button never stuck), the share dialog (create with each expiry and the checkbox, copy with and without the clipboard API, revoke with confirm, status words for active, expired and turned off, the personal-data notice shown for true and absent for false, 402 opens `UpgradeDialog`), the public page (no `Authorization` header sent, no storage used, the robots and referrer meta tags set on mount and removed on leaving, hides owner controls, shows or hides working from the payload, never shows source rows, one identical 404 page for all unavailable cases, 429 and network error handling, logo refetch-once, text from the API rendered as inert text with `<script>` and `<img onerror>` in a title, heading, note and question).
- No component computes a figure; the earlier "no arithmetic" tests still pass.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.
2. Walk through the whole flow yourself (mock mode, and real mode if the server is `DONE`) at 390px and at desktop width: open a report, print it to PDF, download the Excel file and open it, create a link with and without working shown, open it in a **private window with no session** (confirm no sign-in prompt and no owner controls), copy the link, turn it off and confirm the same link now shows the friendly unavailable page, check an expired link in mock mode, and view the free-plan state. With the real server compare at least three figures in the Excel file and on the public page with the report page.
3. Update the Part 5 cell in the **Client** column of `docs/STATUS.md` and nothing else in that file.
4. Commit in stages (1: print and PDF; 2: Excel and share dialog; 3: public page; 4: tests and STATUS), only after the tests pass. If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
5. Tell me: what you built; the commands to run it; which mode you tested; what I should click by hand (including opening the Excel file and printing a report); the figures you compared; what you checked in the PDFs; and anything in the contract that seemed wrong or missing (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing).

## Do not
Invent endpoints, fields or error codes; edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or anything outside `client/` (except the one STATUS cell); put any secret in the client; send credentials or any stored token to the public endpoint; render API text as HTML; log or display a share token anywhere other than the owner's link field; calculate or estimate any figure on the client; hide a failed check; build templates, comparison or billing.