# Contract change requests

Append a dated entry here when you need a new endpoint, field, shape, enum value, error code or prompt change. Then STOP and tell the user.
Only the user decides; once approved, the user (or a chat they explicitly instruct) updates `API_CONTRACT.md`, `api-types.ts` or `LLM_PROMPTS.md`.

Entry format:

```
## YYYY-MM-DD: short title (from: server | client)
- What:
- Why:
- Proposed shape:
- Affects: (endpoints, types, slices)
- Status: PROPOSED | APPROVED | REJECTED | APPLIED
```

---

## 2026-11-06: Auto-report (one click from upload to draft report) (from: product)
- What: a "Build my report" action on a ready dataset that runs the dataset's stored `suggestions` through the normal ask pipeline and assembles the resulting blocks into a draft report. The user then skims, removes or adds blocks, and downloads or shares.
- Why: the landing page promises "upload, glance, send". As currently specified the user must think of questions and pin blocks, which a time-poor user will not do. Every piece already exists (suggestions, ask, report creation), so this only orchestrates them.
- Proposed shape (for approval; server may refine the details in the migration):
  - `POST /datasets/:id/auto-report` body `{ title?: string, period_label?: string }` returns 202 `AutoReportRun`.
  - `GET /auto-reports/:id` returns `AutoReportRun`; client polls every 2 s until `done` or `failed`.
  - `type AutoReportRun = { id, dataset_id, status: 'running' | 'done' | 'failed', blocks_done: number, blocks_total: number, report_id: string | null, error_message: string | null, created_at }`.
  - Behaviour: ask each stored suggestion (skip a question that fails with `cannot_answer`; the run fails if fewer than 3 blocks succeed), keep `flagged` blocks but mark them in the report, create the report with source `suggested` blocks, default title = dataset name.
  - Limits: counts as the questions it asks plus one report against the monthly limits; check beforehand that the remaining quota covers it, else 402 `plan_limit`. Dataset must be `ready` (409 / 410 as for `ask`).
  - Storage: either make `report_runs.template_id` nullable and add a `kind` column, or add an `auto_report_runs` table. Server decides in a migration and notes it in STATUS.md.
- Risks to test: suggested questions may be dull or redundant for some files (offer "add your own question" prominently); a draft report must never present a flagged block as clean.
- Affects: endpoints above, `api-types.ts` (`AutoReportRun`), `API_CONTRACT.md` (new rows under Questions and blocks, Flow F), slice S3 (needs reports) and a "Build my report" button in the client dataset overview.
- Status: PROPOSED

## 2026-11-09: Specify the `validation_failed` details shape (from: client)
- What: the contract says only "zod errors in `details`" for 422 `validation_failed`, and `api-types.ts` has no type for it. The server already sends `details: { fields: Array<{ location: 'body' | 'query' | 'params', path: string, message: string }> }` (documented in STATUS.md server notes, 2026-11-09).
- Why: the client shows field errors next to the matching form field, so it needs a stable shape. Today it relies on the server note, not the contract.
- Proposed shape: add to `api-types.ts`:
  `export interface ValidationFailedDetails { fields: Array<{ location: 'body' | 'query' | 'params'; path: string; message: string }> }`
  and in `API_CONTRACT.md` change the 422 row to "`details: ValidationFailedDetails` (absent for malformed JSON or bodies over 100 KB)".
- Affects: every endpoint that validates input; `api-types.ts`; client `lib/errors.ts` (`fieldErrorsFrom`). No behaviour change on either side.
- Status: APPLIED (approved by the user 2026-11-10; applied by the server chat)

## 2026-11-09: Forced tool calls are not supported by Claude Sonnet 5.5 (from: server)
- What: `LLM_PROMPTS.md` requires a forced tool call (`tool_choice` naming the tool) for all three calls. Tested on 2026-11-09 through OpenRouter, `anthropic/claude-sonnet-5.5` rejects it from every provider, including Anthropic directly: "tool_choice: type "tool" and "any" are not supported for this model." `anthropic/claude-haiku-5.5` accepts it.
- Why: the planner (Part 3) uses `ANTHROPIC_MODEL_PLANNER`. If that stays Sonnet 5.5, the planner call as specified cannot be made. Suggestions (Part 2) and the narrator are unaffected if `ANTHROPIC_MODEL_FAST` is Haiku 5.5.
- Proposed shape (pick one for the planner): (a) keep the forced tool call and use a planner model that supports it; (b) for models that reject forced tool choice, send the single tool with `tool_choice: "auto"` and a system line "Always answer by calling the <tool> tool", treat a reply without the tool call as a failure (one retry, then 502 `llm_failed`). Tested: Sonnet 5.5 called the tool; (c) use structured output (`response_format` json_schema, strict) with the same schema. Tested: valid JSON from Sonnet 5.5. In all cases the output is still validated with zod.
- Also: `LLM_PROMPTS.md` sets temperature 0.3 (narrator, suggestions) and 0 (planner). Claude Sonnet 5.5 and Haiku 5.5 return a 400 for any non-default temperature on the Anthropic API, and OpenRouter silently drops it for them (its model list does not include `temperature` for either). Until this is decided, the server sends `temperature` only through OpenRouter (where it is ignored for these models) and never through the Anthropic provider. Proposed: drop the temperature values from `LLM_PROMPTS.md`, or keep them as "where the model supports it".
- Affects: `LLM_PROMPTS.md` (header paragraph), `server/src/llm/client.ts`, slice S2 (planner). Not S1 if the fast model supports forced tools.
- Status: PROPOSED

## 2026-11-10: Structured details for a dataset that failed on a plan limit (from: client)
- What: Flow A says a file over `max_rows` ends `failed` with `error_message` "Your plan allows N rows; this file has M." and no 402. The client has to parse that sentence to offer the upgrade dialog, and it cannot know `upgrade_to` (only the server knows the plan table), so the dialog names no plan.
- Why: matching words is brittle (any rewording breaks it), and the dialog cannot say which plan allows the file.
- Proposed shape: add `error_details: PlanLimitDetails | null` to `Dataset` (set only when profiling failed on a plan limit, else null). The client would use it instead of the message text.
- Also unspecified: what `PlanLimitDetails.used` means for `max_file_mb` (megabytes, rounded how?). The client currently shows it with one decimal.
- Affects: `api-types.ts` (`Dataset`), `GET /datasets`, `GET /datasets/:id`, client `DatasetPage` (`rowLimitFrom`).
- Status: APPLIED (approved by the user 2026-11-10; applied by the server chat)

## 2026-11-10: Dataset name and column display-name lengths, and what a reparse keeps (from: client)
- What: (1) The contract gives no bounds for `UpdateDatasetRequest.name`, `columns[].display_name` or the upload's `name` field. The client mock assumes name 1 to 200 characters and display name 1 to 120 (or null), and the inputs cap at those lengths. (2) The Part 2 brief says column edits (display name, meaning, Private, VAT) are kept after `POST /datasets/:id/reparse` "where the column still exists", but the contract only says reparse re-runs steps b to h. It does not say whether `dataset_columns` edits survive, or how a column is matched (by `sql_name`?).
- Why: the server needs these to validate and to rebuild columns; the client tells users their edits are kept, which must be true.
- Proposed shape: state the bounds in the Datasets table; add to the reparse row: "keeps `display_name`, `semantic`, `is_pii` and `vat_included` for columns whose `sql_name` is unchanged".
- Affects: `PATCH /datasets/:id`, `POST /datasets`, `POST /datasets/:id/reparse`.
- Status: APPLIED (approved by the user 2026-11-10; applied by the server chat)

## 2026-11-10: Server behaviour found during client integration (S1) (from: client)
- What:
  1. **`Retry-After` is not readable by the client.** The contract says every 429 carries `Retry-After`, and the server sets it, but CORS (`cors({ origin: CLIENT_URL })` in `server/src/app.ts`) does not list it in `Access-Control-Expose-Headers`. The client (on another origin) therefore never sees it and shows its generic "wait a moment" message instead of the number of seconds.
  2. **`preamble_lines` leaves out blank lines.** For `01_card_sales_semicolon_win1252.csv` the server returns 3 lines with `header_row: 5`, while `fixtures/expected.json` says `preamble_lines: 4` ("4 preamble lines (one blank)"). The contract field is "text found above the header row", so this may be intended; the client now shows the true count from `header_row` ("These 4 lines… and 1 empty line"), which is correct either way.
- Why: (1) the contract's promise only works for same-origin clients; (2) the server and the shared fixture expectations disagree, so one of them should change.
- Proposed shape: (1) server: `cors({ origin: CLIENT_URL, exposedHeaders: ['Retry-After'] })`. (2) Decide whether `preamble_lines` includes blank lines (as `''`) and align either the server or `fixtures/expected.json`.
- Affects: every 429 response; `DatasetDetail.preamble_lines`.
- Status: PROPOSED
