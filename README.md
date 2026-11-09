# Analyst OS: Claude Code starter pack

A web app where South African small-business owners, freelancers and bookkeepers upload a CSV or Excel file, ask questions in plain English
and get answers they can check (table, chart, short explanation, SQL and source rows), then turn the good ones into a branded report,
export it (PDF, XLSX, CSV), share it by link and re-run it on next month's file.

"Analyst" is a working name. Set it in `APP_NAME` / `VITE_APP_NAME`.

## What is in this pack
| Path | What it is |
|---|---|
| `CLAUDE.md` | Project rules both Claude Code chats read first |
| `docs/PRODUCT_BRIEF.md` | Who it is for, why they would switch, scope, price hypotheses, risks |
| `docs/ARCHITECTURE.md` | How an upload and a question work, the SQL sandbox, privacy, South African file parsing |
| `docs/API_CONTRACT.md`, `docs/api-types.ts` | The contract both chats build against (source of truth) |
| `docs/LLM_PROMPTS.md` | The three Claude calls: prompts and tool schemas |
| `db/schema.sql` | Postgres schema with row-level security, plan limits seed |
| `docs/KEYS_AND_SERVICES.md` | Accounts, keys, env vars, POPIA and security checklists |
| `docs/STATUS.md`, `docs/CONTRACT_CHANGES.md` | Progress board and the change-request log |
| `prompts/part-1-server.md`, `prompts/part-1-client.md` (and later parts) | The prompts you paste into the two chats, one pair per part |
| `prompts/full-server.md`, `prompts/full-client.md` | Reference only: every part in one document. Do not paste these |
| `fixtures/`, `scripts/make-fixtures.mjs` | Synthetic test files with South African formatting and their expected results |

## How to start (about 1 hour of setup)
1. Put this folder in a private GitHub repo.
2. Follow `docs/KEYS_AND_SERVICES.md` steps 1 to 4: Supabase project (run `db/schema.sql`, create the two private buckets), Anthropic key with a spend limit, `.env` files.
3. Open **two** Claude Code chats, both started in this root folder (`analyze/`).
   - Server chat: paste `prompts/part-1-server.md`. It works only in `server/`.
   - Client chat: paste `prompts/part-1-client.md`. It works only in `client/`.
4. Each chat confirms what it understood, then builds Part 1 only. When the server chat finishes a part it marks the endpoints `DONE` in `docs/STATUS.md`; the client chat builds against those, or against mocks until then.
5. After every part: test it yourself using the "how to test" the chat gives you, commit, then start the next pair of prompts. Parts and slices are the same thing: Part 1 = S0, Part 2 = S1, and so on.

## The three rules that make this worth paying for
1. Numbers come from queries, never from the model.
2. Every answer shows its working (SQL, checks, source rows).
3. The model never receives the whole file.

## Build order and honesty about effort
- S0 to S4 is the sellable core: sign-up and consent, upload and parse, ask and verify, reports, export and share.
- S5 (templates and monthly re-run) is the feature that brings people back next month. S6 (plans and PayFast) turns on payments.
- The research behind this pack scored the generic "upload, analyse, visualise" idea 15 out of 30 on your criteria, because ChatGPT and Claude already do it for free or cheaply. This pack bakes in the differences (working shown, South African file formats, branded reports, monthly re-runs), but the market test is the real answer: before S3, get five real people to try S2 with their own file.
- Hours are not estimated here. Plan on evenings and Saturday mornings, expect each slice to take longer than the chat suggests, and budget two to three times your first guess.

## Test data
`fixtures/` holds three SYNTHETIC files (invented rows, no real customers). They imitate common South African formatting conventions (decimal comma, space thousands separators, dd/mm/yyyy, preamble and total lines, windows-1252). They do not copy the layout of any real bank, card machine or accounting product, and the app must not claim to support any. Test the parsers on real exports from real users, with their permission, before launch.
Regenerate with `node scripts/make-fixtures.mjs` (deterministic).

## Not legal advice
`docs/KEYS_AND_SERVICES.md` contains a POPIA checklist built from research. Have a South African lawyer review your terms, privacy notice and cross-border transfer position before real users upload anything.
