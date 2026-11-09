# Product brief: Analyst (working name)

## One line
Upload a spreadsheet, ask questions in plain English, get answers you can check, and export a branded report.

## Who it is for
- **Primary:** owners of small South African businesses and freelancers who have sales, cost or stock data in CSV or Excel
  and today either eyeball it, build pivot tables, or paste it into a general chatbot.
- **Secondary:** bookkeepers and small consultancies who prepare monthly numbers for clients (this is what workspaces are for).

## The honest starting point
The research behind this brief scored the generic "upload, analyse, visualise, export" idea at **15 out of 30** and the
bookkeeper-pack version at 17. Analysis, charts and export are available free or cheaply elsewhere (Claude Free creates
files and runs code; ChatGPT Go is about R149 a month in South Africa; the AI-spreadsheet startup Rows shut down on 31 May 2026).
So this product is **not** "AI that analyses your file". It wins only if the six things below are noticeably better than
doing it yourself or asking a general chatbot. If after launch users do not come back with a second file, that is the signal to
narrow to bookkeepers (the workspace and template features are already there for that).

## Why someone would use it instead of doing their own analysis
| # | What users get | Why it matters | Slice |
|---|---|---|---|
| 1 | **Answers you can check.** Every figure comes from a query. Each block shows the SQL, a "totals reconcile to your file" check, and the source rows. | The best-documented complaint about AI analysis tools is invented numbers. | S2 |
| 2 | **Repeatable monthly reports.** Save a report as a template, upload next month's file, get the same pack with month-on-month changes. | Turns a one-off novelty into a habit. Competitors gate this behind paid tiers. | S5 |
| 3 | **Branded, shareable output.** Rand and VAT formatting, your logo and colour, PDF and Excel export, a read-only link. | The output is something you can send to a client, not a chat transcript. | S3, S4 |
| 4 | **Imports that cope with South African files.** Semicolon CSVs, decimal commas, `dd/mm/yyyy` dates, preamble lines above the header, "Total" rows at the bottom, Windows-1252 encoding. | Real exports are messy; a tool that chokes on them loses the user in the first minute. | S1 |
| 5 | **POPIA-conscious handling.** Stated retention, delete on request, no training on your data, sensitive columns masked before any AI call, disclosed sub-processors. | Bookkeepers will not upload client data without it. | S0, S1, S6 |
| 6 | **Predictable pricing.** Flat monthly plans. No credits that vanish. | A common complaint about US rivals. | S6 |

Evidence status: features 2 to 4 rest on a pattern (every competitor puts scheduling, branding and connectors above its free
tier), not on measured retention. No conversion or retention data exists for any competitor. Treat the whole table as a hypothesis.

## MVP user flow
1. Sign up, accept the terms and privacy notice (POPIA consent), land in a default workspace.
2. Drop a CSV or Excel file. See it profiled in seconds: detected columns, types, warnings ("dates read as dd/mm/yyyy",
   "3 total rows excluded"). Fix anything wrong (header row, decimal separator, column meaning).
3. Click one of five suggested questions, or type your own. Get a table, a chart, a short explanation and the working.
4. Pin the good answers into a report, title it, add the period, and see it with your logo and colours.
5. Export to PDF or Excel, or send a link. Optionally save it as a template for next month.

## In scope for the MVP
CSV and XLSX upload (plan limits on rows and size), automatic profiling and PII flagging, suggested questions,
question to answer (SQL, chart, narrative, checks, source rows), reports, branding, PDF (print), XLSX and CSV export,
share links, templates and re-runs (S5), plans and PayFast subscriptions (S6).

## Not in the MVP
See "Out of scope" in `CLAUDE.md`. In particular: no connectors, no multi-file joins, no forecasting, no provider-specific
parsers. Provider parsers (card machines, POS, bank exports) come after real customer files are collected; the generic
parser plus manual overrides is the MVP's answer.

## Pricing hypotheses (all unvalidated; edit in the `plan_limits` table, no deploy needed)
| Plan | Price (ZAR/month) | Intended buyer | Main limits |
|---|---|---|---|
| Free | 0 | Try it | 1 report a month with a watermark, 20k rows, 5 MB, 30-day retention |
| Solo | 249 | One business owner | 100k rows, templates, branding, share links |
| Practice | 749 | Bookkeeper, about 10 client workspaces | 200k rows, 10 workspaces |
| Practice Plus | 1 749 | Larger practice, about 30 clients | 30 workspaces, white label |
The research suggests ranges of R199-R299, R599-R899 and R1,499-R1,999. These are midpoints I chose; no South African
willingness-to-pay evidence exists. PayFast subscriptions are card-only, so users without a card cannot subscribe in the MVP.

## Unit economics (assumptions, not measurements)
At current list prices (Sonnet 5.5 about US$2 in / US$10 out per million tokens, Haiku 5.5 about US$0.10 / US$0.50; check the
pricing page), one question (planner call about 3,000 in and 700 out on Sonnet, narrator about 1,500 in and 300 out on Haiku)
costs roughly US$0.013, about R0.21 at R16.45 per dollar. Forty questions a month is under R10. Hosting (a server with at
least 1 GB RAM) is the larger fixed cost. The server logs real token counts to `usage_events` from day one so these numbers
can be replaced with measurements within a week.

## Success metrics
- Activation: upload to first answer in under 3 minutes for the fixtures.
- The real test: a user returns and uploads a second file within 35 days (or runs a template).
- Trust: share of blocks with all checks passing (target above 95%), share of questions answered without a repair retry.
- Parsing: share of uploads that profile correctly without manual override.

## Risks to keep visible
- **Bundling:** general assistants and ledger vendors (Xero announced Claude inside Xero in March 2026) may cover this.
- **Accuracy liability:** a wrong number in a client pack hurts the user's reputation. Show the working; add a plain
  "check important figures against your source" line to reports; never promise accuracy.
- **Novelty churn:** users may try it once. Templates and monthly packs are the countermeasure.
- **Parser upkeep:** every provider changes its export layout eventually.
- **POPIA:** sending data to a US AI API is a cross-border transfer (section 72). This design sends only aggregates and
  masked samples, but it still needs a privacy notice, a sub-processor disclosure and a lawyer's one-hour review. Not legal advice.

## Phase 2 (after real usage)
Provider-specific parsers from collected files, multi-file joins, PowerPoint export, scheduled refresh, WhatsApp delivery of
reports, team seats, an "ask anything" agentic mode on higher plans only (it costs several times more per question).
