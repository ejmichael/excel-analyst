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
