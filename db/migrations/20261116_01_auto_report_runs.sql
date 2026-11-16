-- Part 4b (S3b): "Build my report" runs (POST /datasets/:id/auto-report, GET /auto-reports/:id).
-- A separate table because report_runs.template_id is NOT NULL (template runs only).
-- Same RLS style as report_runs: signed-in users may read their own rows; every write goes through the server
-- (service-role client, always filtered by owner_id).

create table auto_report_runs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  dataset_id    uuid references datasets(id) on delete set null,   -- null after the dataset is deleted
  status        run_status not null default 'running',
  blocks_done   int  not null default 0 check (blocks_done >= 0),
  blocks_total  int  not null check (blocks_total >= 0),
  report_id     uuid references reports(id) on delete set null,
  error_message text,                                               -- short, user-safe
  title         text check (title is null or char_length(title) between 1 and 120),
  period_label  text check (period_label is null or char_length(period_label) <= 60),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  check (blocks_done <= blocks_total)
);
create index auto_report_runs_owner on auto_report_runs(owner_id, created_at desc);
-- At most one running auto-report per dataset (the server answers 409 conflict; this makes it hold under a race).
create unique index auto_report_runs_one_running on auto_report_runs(dataset_id) where status = 'running';

alter table auto_report_runs enable row level security;
create policy auto_report_runs_select on auto_report_runs for select to authenticated using (owner_id = auth.uid());
