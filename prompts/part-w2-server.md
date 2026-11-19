PS D:\Dev\analyze> git status --short
 M CLAUDE.md
?? prompts/part-w1-client.md
PS D:\Dev\analyze> git --no-pager diff CLAUDE.md | Select-Object -First 40
warning: LF will be replaced by CRLF in CLAUDE.md.
The file will have its original line endings in your working directory
diff --git a/CLAUDE.md b/CLAUDE.md
index 36ebff1..9eede03 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -32,9 +32,9 @@ analyze/                    <- the repo root; open both Claude Code chats here
 
 ## Stack
 - **Supabase**: Postgres (metadata), Auth (JWTs), Storage (private buckets `datasets` and `branding`). No Africa region is listed in Supabase's documentation; pick the nearest (London or Frankfurt) and disclose it.
-- **Server**: Node 20+, Express, TypeScript (strict), zod, `@anthropic-ai/sdk`, DuckDB (in-process, for the SQL sandbox),
+- **Server**: Node 22.12+, Express, TypeScript (strict), zod, `@anthropic-ai/sdk`, DuckDB (in-process, for the SQL sandbox),
   `csv-parse`, `exceljs`, `jschardet` (or similar) for encoding detection, `pino`.
-- **Client**: React 18 + Vite + TypeScript, Tailwind + shadcn/ui, TanStack Query, React Router, Recharts.
+- **Client**: React 19 + Vite + TypeScript, Tailwind + shadcn/ui, TanStack Query, React Router, Recharts.
 - **Hosting**: Vercel (client), Render or Railway (server, at least 1 GB RAM because DuckDB runs in the process).
 - Payments (slice S6 only): PayFast card subscriptions.
 
PS D:\Dev\analyze> 