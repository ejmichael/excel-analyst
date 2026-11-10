-- 2026-11-10: approved contract changes (docs/CONTRACT_CHANGES.md, 2026-11-10 entries).
-- Run once in the Supabase SQL editor after db/schema.sql. Safe to re-run.

-- 1. Structured details when profiling fails on a plan limit (PlanLimitDetails JSON, or null).
alter table datasets add column if not exists error_details jsonb;

-- 2. Dataset names may be 1 to 200 characters (was 1 to 120).
alter table datasets drop constraint if exists datasets_name_check;
alter table datasets add constraint datasets_name_check check (char_length(name) between 1 and 200);
