# PART 4 (SERVER): Reports and branding (slice S3)

You are the **server engineer** for Analyst OS. Parts 1 to 3 (accounts, workspaces, upload, profiling, asking, checks, source rows) are done and committed. A second Claude Code chat builds `client/` in parallel against the same contract.
Work **only** in `server/`, `db/migrations/` and `docs/STATUS.md` (leave the Client column of its slices table to the client chat).
This prompt covers **Part 4 only**: reports (create, list, read, edit, delete) and branding (business name, colour, logo). Do not build XLSX export, share links, public pages, templates, runs, comparison, auto-report or billing, even if you can see them in the docs. `ReportDetail.comparison` is always `null` for now.

## Read first (only these, in this order)
1. `CLAUDE.md`, then `docs/STATUS.md` and `docs/CONTRACT_CHANGES.md` (note which entries are APPLIED, and that the auto-report entry is APPROVED but not to be built or applied yet)
2. `docs/API_CONTRACT.md`: the Reports table, the Me table (the logo rows), Flow C steps 1 and 2, and the business rules for Plan limits, Retention and Rate limits
3. `docs/api-types.ts` (re-copy to `server/src/types/api.ts` if different): `Report`, `ReportBlock`, `ReportDetail`, `CreateReportRequest`, `UpdateReportRequest`, `Brand`, `Me`, `UpdateMeRequest`
4. `db/schema.sql`: `reports`, `report_blocks`, `blocks`, `profiles` (brand columns), `workspaces`, `usage_events`, and the RLS section
5. Your own code from Parts 1 to 3: `services/limits.ts`, how `Me` and `Brand` are built, the block delete (409) check, the `branding` bucket usage, the multipart upload code from Part 2
Then reply with 6 bullets of what you understood (include: when the `report` usage event is written, which plans may set a brand colour or upload a logo, what `watermark` means, and why a block from another workspace must be refused). Then start.

## Pre-flight (stop and tell me exactly what is missing)
- Parts 1 to 3 are committed; `npm test` and `npm run test:integration` pass.
- The private storage bucket `branding` exists (check with the service-role client).
- `docs/STATUS.md` shows the S2 endpoints as `DONE`.

## Build exactly this

### Endpoints (paths, shapes and codes exactly as the contract; nothing else)
- `GET /api/v1/reports?workspace_id=&limit=&offset=` (`Paged<Report>`, `workspace_id` required and the caller's, newest first, `block_count` from `report_blocks`).
- `POST /api/v1/reports` (`CreateReportRequest`, strict). Order of checks: auth, consent, `workspace_id` is the caller's (404), `assertWithinLimit(max_reports_per_month)` (402), then validate: `title` trimmed 1 to 120; `subtitle` up to 200; `period_label` up to 60; `block_ids` 1 to 30 distinct UUIDs (duplicates are 422). Every block must be the caller's (404 if any is not, with no hint which). **Workspace rule (a bookkeeper's workspaces are their clients, so one client's numbers must never end up in another client's report):** a block whose dataset still exists must belong to a dataset in the report's workspace, otherwise 422 `validation_failed` with a clear message; a block whose dataset was deleted (`dataset_id` null) cannot be verified, so it is refused on create (422) and allowed on update only if it is already in that report. Insert the report and its blocks in the given order atomically, write the `report` usage event only after success, return 201 `ReportDetail`. Blocks from several datasets in the same workspace are allowed.
- `GET /api/v1/reports/:id` returns `ReportDetail`: the report, `brand` (current business name, colour and a fresh signed logo URL), `watermark` (true when the owner's plan is `free`), `blocks` in position order each with its `heading_override` and the full `Block`, and `comparison: null`. Cross-user is 404.
- `PATCH /api/v1/reports/:id` (`UpdateReportRequest`, strict, same length rules; `notes` up to 2000; an empty body is 422). When `blocks` is present it replaces membership and order atomically (1 to 30 distinct blocks, same ownership and workspace rules, `heading_override` up to 120 or null, positions renumbered from 0). Use one database transaction or a SQL function in a migration; a failure must leave the old blocks intact. Does not count against `max_reports_per_month`. Returns `ReportDetail`.
- `DELETE /api/v1/reports/:id`: deletes the report and its `report_blocks` (and, later, its share links through the database cascade). The blocks themselves stay. Returns `{ deleted: true }`.
- `POST /api/v1/me/logo` (multipart `file`) and `DELETE /api/v1/me/logo`: both need `limits.branding` (402 `plan_limit` with `PlanLimitDetails` otherwise, `upgrade_to` the cheapest plan that allows it). Rules for the upload: PNG, JPEG or WebP only, **decided by the file's bytes (magic numbers), never by the extension or MIME type**; SVG and GIF are refused (415); at most 1 MB (413 `file_too_large`); width and height each at most 4,000 px, read from the file header without decoding the whole image, and each at least 16 px (422). Store at `branding/<owner_id>/logo.<ext>` using a generated name only, delete any previous logo object with another extension, save the path on the profile, and return `Brand` with a signed URL valid for 1 hour. `DELETE` removes the object and the path and returns `Brand` with `logo_url: null`. A logo can never be a way to read another user's files: paths are built from `owner_id` only.
- `GET /me` and `PATCH /me` already exist: make sure `Me.brand.logo_url` is a fresh signed URL (or null) and that `brand_color` keeps its plan check and `#RRGGBB` validation.

### Rules
- READS use the RLS-protected client; WRITES use the service role and every write and service-role read is filtered by `owner_id`. Cross-user ids are 404, never 403.
- Delete of a block that is pinned in any report is 409 `conflict` (it already exists from Part 3; make sure the test now uses a real report).
- Block payloads in `ReportDetail` can be large (up to 30 blocks of up to 500 rows). Enable response compression for JSON if it is not already on (use the maintained `compression` package, check it first), keep `Retry-After` and `Content-Disposition` exposed, and report the measured size of a 30-block `ReportDetail` before and after compression.
- Never log titles, notes, headings or the logo content; log ids, sizes and timings only.
- The logo URL is signed and expires; never store a signed URL in the database.

## Tests (required)
- Unit: length and count validation (strict bodies, duplicates, 0 and 31 blocks), the workspace rule (same workspace ok, other workspace 422, deleted-dataset block 422 on create and allowed on update only when already a member), the logo byte check (real PNG, JPEG and WebP accepted; an SVG, a GIF, a text file renamed `.png`, a truncated PNG and an oversized-dimension PNG refused), watermark true only on `free`.
- Integration (throwaway users, always cleaned up): create a report from blocks asked on a fixture (use the mocked-LLM path to create blocks cheaply); `report` usage written only on success; `max_reports_per_month` on `free` is 402 on the second report with the right `details`; list and read return blocks in order with `brand` and `watermark`; PATCH reorders, renames headings, removes and adds blocks atomically (inject a failure and prove the old blocks stay); deleting a report keeps its blocks and deleting a pinned block is 409 until the report is deleted; user B gets 404 on A's report (read, patch, delete) and cannot use A's block ids; creating a report with a block from another workspace is 422; `brand_color` and logo on `free` are 402; logo upload and delete on a paid plan (set the plan with the service role in the test), the signed URL works and the object path contains only `owner_id`; the previous logo is replaced and removed; A's logo is not reachable through B.

## Finish
1. Run `npm run typecheck`, `npm test` and `npm run test:integration`; fix everything.
2. Update `docs/STATUS.md`: mark the S3 endpoints `DONE` only after their tests pass; add notes the client needs (workspace rule and its message wording, payload sizes, logo URL expiry, limits on lengths). Add the length bounds above to `docs/API_CONTRACT.md` (you may edit it for this only).
3. Commit in stages with clear messages (1: migration and report endpoints; 2: branding and logo; 3: tests and STATUS), so work is not lost if the session stops. If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
4. Tell me: what you built; the commands to run and test; the measured payload sizes; anything you could not verify; any ambiguity in the contract (write it in `docs/CONTRACT_CHANGES.md` and STOP rather than guessing); and what I should try by hand.

## Do not
Invent endpoints, fields or error codes; edit `docs/api-types.ts` or `docs/LLM_PROMPTS.md`; touch `client/` or `fixtures/`; build export, sharing, templates, auto-report or billing; accept SVG logos; trust a file extension or MIME type; put a secret in any commited file.