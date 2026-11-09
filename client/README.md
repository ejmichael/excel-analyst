# Analyst client

React 18 + Vite + TypeScript. Needs Node 22.12 or newer (Vite 8 and Vitest 5).

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
  409 on deleting the default). Any email with a password of 8+ characters signs in.
- `VITE_USE_MOCKS=false` uses Supabase Auth (publishable key in `VITE_SUPABASE_ANON_KEY`) and the API at `VITE_API_URL`.
  Supabase is used for auth only; all data goes through the API.
