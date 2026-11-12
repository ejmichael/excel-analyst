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
- `VITE_USE_MOCKS=false` uses Supabase Auth (publishable key in `VITE_SUPABASE_ANON_KEY`) and the API at `VITE_API_URL`.
  Supabase is used for auth only; all data goes through the API.
