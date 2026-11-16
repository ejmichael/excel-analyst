# Analyst client

React 19 + Vite + TypeScript. Needs Node 22.22 or newer (React Router 8, Vite 8 and Vitest 5).

```sh
cp .env.example .env   # then fill in the values
npm install
npm run dev            # http://localhost:5173
npm run typecheck
npm test
npm run build
```

- `VITE_USE_MOCKS=true` runs with no Supabase and no server: an in-memory fake session and typed mock handlers
  (`src/api/mocks/`) that follow the contract (consent gating, one default workspace, 402 on a second workspace on Free,
  409 on deleting the default, uploads with 402/413/415, profiling that turns ready after a few seconds).
  Any email with a password of 8+ characters signs in; `demo@example.co.za` starts with example files in every
  state (ready, warning, failed on the row limit, expired, still reading). Uploading a file from `fixtures/` gives
  that fixture's profile. On the Ask page, mock answers are example data (card-sales themed); questions containing
  "slow" (about 8 s), "weather" (422 cannot_answer), "busy" (429) or "fail" (502) show the waiting state and errors.
  "Build my report" answers one suggestion every 2 seconds (about 10 s), then opens the draft report; on the card-sales
  file one answer is flagged. A title containing "fail" ends failed after two answers, "busy" is 409 naming a run started
  as if from another tab (the page then shows its progress),
  "limit" is 402 on the monthly questions, and "slow" takes 3 minutes.
  Reports: "Download Excel" saves a small example workbook. A report titled with "busy" answers the export with 429;
  links made on a report titled with "expired" have already expired; a report titled with "personal" (or with a column
  such as email or phone) is flagged as containing personal details. Share links need Solo or above (`paid@…`).
- `VITE_USE_MOCKS=false` uses Supabase Auth (publishable key in `VITE_SUPABASE_ANON_KEY`) and the API at `VITE_API_URL`.
  Supabase is used for auth only; all data goes through the API.
