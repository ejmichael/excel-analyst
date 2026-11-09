# Build status

Owned by the SERVER chat. The CLIENT chat reads it: build against real endpoints only when marked `DONE`; otherwise use mocks.
Mark `DONE` only after the endpoint has been run and tested. Values: `TODO`, `WIP`, `DONE`, `BLOCKED (reason)`.

## Slices
| Slice | Scope | Server | Client |
|---|---|---|---|
| S0 | Foundation, auth, consent, workspaces, me | TODO | TODO |
| S1 | Upload, parse, profile, preview | TODO | TODO |
| S2 | Ask, verify, source rows | TODO | TODO |
| S3 | Reports and branding | TODO | TODO |
| S4 | Export and share | TODO | TODO |
| S5 | Templates and re-runs | TODO | TODO |
| S6 | Plans, billing, hardening, handover | TODO | TODO |

## Endpoints (server)
| Slice | Endpoint | Status |
|---|---|---|
| S0 | GET `/health` | TODO |
| S0 | GET `/me` | TODO |
| S0 | PATCH `/me` | TODO |
| S0 | GET `/workspaces` | TODO |
| S0 | POST `/workspaces` | TODO |
| S0 | PATCH `/workspaces/:id` | TODO |
| S0 | DELETE `/workspaces/:id` | TODO |
| S1 | POST `/datasets` | TODO |
| S1 | GET `/datasets` | TODO |
| S1 | GET `/datasets/:id` | TODO |
| S1 | PATCH `/datasets/:id` | TODO |
| S1 | POST `/datasets/:id/reparse` | TODO |
| S1 | GET `/datasets/:id/preview` | TODO |
| S1 | DELETE `/datasets/:id` | TODO |
| S1 | POST `/internal/purge-expired` | TODO |
| S2 | POST `/datasets/:id/ask` | TODO |
| S2 | GET `/datasets/:id/blocks` | TODO |
| S2 | GET `/blocks/:id` | TODO |
| S2 | GET `/blocks/:id/source-rows` | TODO |
| S2 | GET `/blocks/:id/export.csv` | TODO |
| S2 | POST `/blocks/:id/feedback` | TODO |
| S2 | DELETE `/blocks/:id` | TODO |
| S3 | GET `/reports` | TODO |
| S3 | POST `/reports` | TODO |
| S3 | GET `/reports/:id` | TODO |
| S3 | PATCH `/reports/:id` | TODO |
| S3 | DELETE `/reports/:id` | TODO |
| S3 | POST `/me/logo` | TODO |
| S3 | DELETE `/me/logo` | TODO |
| S4 | GET `/reports/:id/export.xlsx` | TODO |
| S4 | GET `/reports/:id/share-links` | TODO |
| S4 | POST `/reports/:id/share-links` | TODO |
| S4 | DELETE `/share-links/:id` | TODO |
| S4 | GET `/public/reports/:token` | TODO |
| S5 | POST `/reports/:id/save-as-template` | TODO |
| S5 | GET `/templates` | TODO |
| S5 | GET `/templates/:id` | TODO |
| S5 | PATCH `/templates/:id` | TODO |
| S5 | DELETE `/templates/:id` | TODO |
| S5 | POST `/templates/:id/run` | TODO |
| S5 | GET `/runs/:id` | TODO |
| S5 | GET `/templates/:id/runs` | TODO |
| S6 | GET `/billing/plans` | TODO |
| S6 | GET `/billing/subscription` | TODO |
| S6 | POST `/billing/checkout` | TODO |
| S6 | POST `/billing/payfast/itn` | TODO |
| S6 | POST `/billing/cancel` | TODO |
| S6 | DELETE `/me` | TODO |

## Measured numbers (server fills in during S2)
- Average input and output tokens per question: _not measured yet_
- Average cost per question (USD, ZAR): _not measured yet_
- Median and slowest ask latency: _not measured yet_

## Server notes for the client
(none yet)

## Known issues and decisions
(none yet)
