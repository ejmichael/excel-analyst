# PART 5 (SERVER): Excel export and share links (slice S4)

You are the **server engineer** for Analyst OS. Parts 1 to 4b are done and committed (accounts, upload, profiling, asking, checks, source rows, reports, branding, one-click draft report). A second Claude Code chat builds `client/` in parallel against the same contract.
Work **only** in `server/`, `db/migrations/` and `docs/STATUS.md` (leave the Client column of its slices table to the client chat). You may also edit the contract files **only** as stated under "Contract".
This prompt covers **Part 5 only**: the Excel export of a report, share links, and the public report endpoint. PDF is produced by the client through the browser's print function; there is no server-side PDF. Do not build templates, runs, comparison or billing.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` and `docs/CONTRACT_CHANGES.md` (note which entries are APPLIED)
2. `docs/API_CONTRACT.md`: the Reports and Sharing tables, Flow C, and the business rules for Exports, Public reports, Plan limits and Rate limits
3. `docs/api-types.ts` (re-copy to `server/src/types/api.ts` if different): `ShareLink`, `CreateShareLinkRequest`, `PublicReport`, `ReportDetail`, `Brand`, `Block`
4. `db/schema.sql`: `share_links`, `reports`, `report_blocks`, `blocks`, `profiles`, `usage_events` (kinds `export` and `share`), and the RLS section
5. Your own code from Parts 1 to 4: report reading (`ReportDetail` builder with brand and signed logo URL), the CSV export and its formula-injection protection, the hardened XLSX reader from Part 2, the rate limit middleware, `assertWithinLimit`
Then reply with 6 bullets of what you understood (include: what an unauthenticated visitor may and may not receive, what `show_working` changes, why a revoked, expired and unknown token must be indistinguishable, and when the `export` and `share` usage events are written). Then start.

## Pre-flight (stop and tell me exactly what is missing)
- Parts 1 to 4b are committed; `npm test` and `npm run test:integration` pass; the report endpoints are `DONE`.
- `CLIENT_URL` is set in `.env` (it builds the share URLs).

## Contract (do this first, as its own commit, so the client chat can start)
You may edit `docs/API_CONTRACT.md` and `docs/api-types.ts` (then re-copy to `server/src/types/api.ts`) for exactly these, and nothing else:
1. `ShareLink` gets `contains_personal_data: boolean`: true when the report's tables appear to contain personal details. It is a **best-effort warning, never a guarantee**. Compute it when a link is created and when links are listed, from the report's blocks: true if any block's result column is (or is named like) a dataset column flagged `is_pii`, or if any stored result value matches the PII detectors you already built in Part 2 (email, SA mobile, valid 13-digit ID, name-column patterns). For a block whose dataset was deleted, use the value detectors only.
2. The public report: **`has_source_rows` is always false on `GET /public/reports/:token`**, even when `show_working` is true, because source rows are never available on public links. Say so in the contract (the existing text is ambiguous).
3. Public responses carry `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`. Add a sentence to the contract.
Commit this first (`Contract: share links and public reports`) and tell me, so the client chat can re-copy the types.

## Build exactly this

### Excel export
- `GET /api/v1/reports/:id/export.xlsx`: auth, consent, the caller's report (404 otherwise), then build and stream the file with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `Content-Disposition: attachment; filename="<slug>-<YYYY-MM-DD>.xlsx"` (slug from the title: ASCII letters and digits and hyphens, at most 60 characters, never empty; the date is today in SAST). Not wrapped in `{ data }`. Write the `export` usage event only after the file was built successfully.
- Content exactly as the contract's Exports rule: sheet "Summary" (business name, report title, subtitle, period, generated date in SAST, notes, and the one-line caution to check important figures against the source; when `watermark` is true, one more line "Made with <APP_NAME>"); one sheet per block (sheet names unique, at most 31 characters, none of `[ ] : * ? / \`, falling back to "Answer N") holding the heading, the question, the narrative, the failed-check warning in words if the block is flagged, and the result table with number formats (ZAR as `"R" #,##0.00`, `integer` `#,##0`, `number` `#,##0.00`, `percent` `0.0%` with fractions as stored, `date` as real Excel dates, `text` as text) and a header row; then a sheet "Working" listing each block's heading, SQL and checks (label, passed or not, expected and actual where present). Header fill uses `brand.color` when `limits.branding`, with a readable text colour (pick black or white by contrast).
- **Library:** choose the XLSX writer yourself, after checking the current maintained options. Requirements: multiple sheets, cell number formats, real dates, a header fill, column widths, text wrapping, sheet-name rules. Prefer the one with the fewest dependencies and no open advisories (`exceljs` is installed as a dev dependency and carries an `npm audit` advisory through `uuid`; if you pick it, say why that is acceptable, and move it to a regular dependency; if you pick another, say which and why). Tell me which one and why before you build the export.
- **Safety:** cells are always written as typed values (text, number, date), **never as formulas**. Text from the user's data that starts with `=`, `+`, `-` or `@` must be written as a plain string cell and must not be able to become a formula in Excel (prefix it the same way as your CSV export does, or set the cell type explicitly; test it). Never put the user's SQL or text into a sheet name, a defined name or a hyperlink without cleaning.
- Reports can be large (30 blocks of up to 500 rows). Build the workbook in a way that does not hold more than needed in memory, report the time and memory for a worst-case report, and fail with a clear error rather than exhaust memory.

### Share links
- `GET /api/v1/reports/:id/share-links` returns the report's `ShareLink[]` (caller's only, newest first, with `contains_personal_data`).
- `POST /api/v1/reports/:id/share-links` (`CreateShareLinkRequest`, strict): needs `limits.share_links` (402 `plan_limit` with `limit: 0` and `upgrade_to`). `expires_in_days` of 7, 30, 90 or null; `show_working` default false. Generate the token with `crypto.randomBytes(32)` encoded as base64url (the database requires at least 32 characters), `url = CLIENT_URL + '/r/' + token`. Write the `share` usage event after success. Return 201 `ShareLink`.
- `DELETE /api/v1/share-links/:id` revokes (sets `revoked_at`; repeating it is harmless) and returns the updated link; someone else's id is 404.
- `GET /api/v1/public/reports/:token` (no auth): rate limit 60 per minute per IP. Look the link up with the service role. If it is unknown, revoked or expired, return the **same** 404 body and status for all three cases, with no timing hint you can avoid. Otherwise increment `view_count`, and return the `PublicReport`: the report with its brand (never the owner's email, id or name), `watermark`, and the blocks with `sql` as `''` and `checks` as `[]` unless `show_working`, and `has_source_rows` false. A `flagged` block keeps `status: 'flagged'` even when its checks are hidden, so the public page can still say that it needs a closer look. Set the three headers from the contract.
- The public route must never accept or use an `Authorization` header, and must not reveal whether a token ever existed.

### Rules
- READS for the owner use the RLS-protected client; writes and the public read use the service role, and every owner write is filtered by `owner_id`. Cross-user ids are 404.
- Never log tokens (log the link id only), titles, notes or data. Treat the token like a password in every log, error and metric.
- Public JSON must not contain the owner's email, `owner_id`, workspace or dataset ids, file names or storage paths. Add a test that walks the whole response and fails if any such value appears.

## Tests (required)
- Unit: slug rules, sheet-name rules (length, forbidden characters, duplicates, empty), number-format mapping, the readable text colour, the formula-injection protection for cells beginning with `=`, `+`, `-`, `@`, `contains_personal_data` for email, phone, ID and name columns and for a clean report, token shape and length.
- Round trip: build an export for a report with several blocks, read it back with your own hardened XLSX reader and compare every value to the blocks (including a date, a ZAR amount, a percent and a flagged block's warning); check the sheet list, the Summary caution line, the watermark line on `free`, and the brand fill when branding is allowed.
- Integration (throwaway users, always cleaned up): export counts one `export` event and only on success; cross-user 404; free plan can export (the contract does not gate Excel; confirm and tell me) but cannot create a share link (402); create, list, revoke, repeat revoke; expiry; the three 404 cases are byte-for-byte identical; `view_count` increments; `show_working` false hides SQL and checks and true shows them but still hides source rows; the public payload leaks nothing from the list above; the headers are present; the rate limit returns 429 with `Retry-After`; deleting the report removes its links (the public URL then 404s); A cannot revoke or list B's links.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run test:integration`; fix everything.
2. Update `docs/STATUS.md`: mark the S4 endpoints `DONE` only after their tests pass; notes for the client (the file name header, the 404 behaviour, `contains_personal_data`, the headers, expected sizes and timings).
3. Commit in stages (1: contract; 2: Excel export; 3: share links and public report; 4: tests and STATUS), so nothing is lost if the session stops. If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
4. Tell me: what you built; the library you chose and why; the commands to run and test; the measured size, time and memory of a worst-case export; anything you could not verify; any ambiguity in the contract (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing); and what I should try by hand (including opening the exported file in Excel).

## Do not
Invent endpoints or error codes; edit contract files beyond the three items above; touch `client/` or `fixtures/`; write formulas into a workbook; log or return a token anywhere except the one creation response and the owner's list; let a public response carry the owner's identity; build templates, runs, comparison or billing; put a secret in any committed file.