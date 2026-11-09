-- ============================================================================
-- Analyst OS: base schema for Supabase (Postgres 15+)
-- Run in the Supabase SQL editor. Then create two PRIVATE storage buckets:
--   datasets   (uploads and normalised files)
--   branding   (logos)
-- Storage is only reached through the server (service role); add no public policies.
-- Every table has Row Level Security. The server uses a per-request client carrying
-- the user's JWT for normal routes, and the service-role client only where the
-- contract says so (public share links, webhooks, cron, account deletion).
-- ============================================================================

-- ---------- enums ----------
create type plan_tier           as enum ('free', 'solo', 'practice', 'practice_plus');
create type dataset_status      as enum ('uploading', 'profiling', 'ready', 'failed', 'expired');
create type block_status        as enum ('ok', 'flagged');
create type block_source        as enum ('user', 'suggested', 'template');
create type run_status          as enum ('running', 'done', 'failed');
create type subscription_status as enum ('none', 'active', 'past_due', 'cancelled');
create type usage_kind          as enum ('upload', 'question', 'report', 'report_run', 'export', 'share', 'llm', 'feedback');

-- ---------- helpers ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- plan limits (editable without a deploy; values are pricing HYPOTHESES) ----------
create table plan_limits (
  plan                    plan_tier primary key,
  price_zar               numeric(10,2) not null,
  max_workspaces          int  not null,
  max_datasets_per_month  int  not null,
  max_questions_per_month int  not null,
  max_reports_per_month   int  not null,
  max_rows                int  not null,
  max_file_mb             int  not null check (max_file_mb <= 50),
  max_templates           int  not null,
  branding                boolean not null,
  share_links             boolean not null,
  white_label             boolean not null,
  retention_days          int  not null
);

insert into plan_limits
  (plan,            price_zar, max_workspaces, max_datasets_per_month, max_questions_per_month, max_reports_per_month, max_rows, max_file_mb, max_templates, branding, share_links, white_label, retention_days)
values
  ('free',            0,       1,              3,                      20,                      1,                     20000,    5,           0,             false,    false,       false,       30),
  ('solo',          249,       1,             20,                     300,                     20,                    100000,   25,           5,             true,     true,        false,       90),
  ('practice',      749,      10,            150,                    2000,                    150,                    200000,   25,          50,             true,     true,        false,      180),
  ('practice_plus',1749,      30,            500,                    6000,                    500,                    200000,   50,         200,             true,     true,        true,       365);

-- ---------- profiles and workspaces ----------
create table profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text not null,
  full_name        text,
  business_name    text,
  plan             plan_tier not null default 'free',
  brand_color      text not null default '#1E7A5F' check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  brand_logo_path  text,                         -- path in the `branding` bucket
  popia_consent_at timestamptz,                  -- terms and privacy notice accepted
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger profiles_updated before update on profiles for each row execute function set_updated_at();

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references profiles(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index workspaces_one_default on workspaces(owner_id) where is_default;
create index workspaces_owner on workspaces(owner_id);

-- Create a profile and a default workspace whenever someone signs up.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email) values (new.id, new.email);
  insert into workspaces (owner_id, name, is_default) values (new.id, 'My workspace', true);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- ---------- datasets ----------
create table datasets (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references profiles(id) on delete cascade,
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 120),
  original_filename text not null,
  file_type         text not null check (file_type in ('csv', 'xlsx')),
  size_bytes        bigint not null,
  storage_path      text not null,               -- raw upload
  normalised_path   text,                        -- normalised CSV (set when profiling finishes)
  status            dataset_status not null default 'profiling',
  error_message     text,                        -- short, user-safe
  row_count         int,
  excluded_rows     int not null default 0,      -- totals/footer/empty rows dropped
  sheet_names       jsonb not null default '[]', -- XLSX only
  parse_options     jsonb not null default '{}', -- effective options: sheet_name, header_row, delimiter, decimal_separator, date_format
  preamble_lines    jsonb not null default '[]', -- text lines found above the header (first 10), shown in the parse dialog
  warnings          jsonb not null default '[]', -- array of short strings
  suggestions       jsonb not null default '[]', -- array of { question, why }
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index datasets_owner_ws  on datasets(owner_id, workspace_id, created_at desc);
create index datasets_expires   on datasets(expires_at) where status in ('ready', 'failed');
create trigger datasets_updated before update on datasets for each row execute function set_updated_at();

create table dataset_columns (
  id             uuid primary key default gen_random_uuid(),
  dataset_id     uuid not null references datasets(id) on delete cascade,
  owner_id       uuid not null references profiles(id) on delete cascade,
  position       int  not null,
  name           text not null,                  -- header as found in the file (after de-duplication)
  display_name   text,                           -- user-edited label
  sql_name       text not null,                  -- safe identifier used in SQL
  data_type      text not null check (data_type in ('text', 'integer', 'decimal', 'date', 'datetime', 'boolean')),
  semantic       text not null default 'none'
                 check (semantic in ('none', 'currency_zar', 'percentage', 'identifier', 'category', 'email', 'phone', 'sa_id_number', 'person_name', 'address', 'free_text')),
  is_pii         boolean not null default false,
  vat_included   boolean,                        -- null = unknown (never assume)
  null_count     int not null default 0,
  distinct_count int not null default 0,
  min_value      text,
  max_value      text,
  sample_values  jsonb not null default '[]',    -- up to 5 values; already masked if is_pii
  unique (dataset_id, position),
  unique (dataset_id, sql_name)
);
create index dataset_columns_dataset on dataset_columns(dataset_id);

-- ---------- blocks: one answered question ----------
create table blocks (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references profiles(id) on delete cascade,
  dataset_id          uuid references datasets(id) on delete set null,   -- null after the dataset is deleted
  question            text not null,
  title               text not null,
  sql                 text not null,
  source_filter_sql   text,                      -- WHERE predicate selecting the source rows (no leading WHERE), or null
  columns             jsonb not null,            -- [{ name, format }]
  rows                jsonb not null,            -- up to 500 rows, array of objects
  row_count           int  not null,             -- true count before truncation
  truncated           boolean not null default false,
  chart               jsonb not null,            -- ChartSpec
  reconcile           jsonb,                     -- { column, aggregation, total_sql } as planned, or null
  narrative_template  text not null,             -- with {{...}} tokens
  narrative           text not null,             -- rendered
  follow_ups          jsonb not null default '[]',
  checks              jsonb not null default '[]',   -- BlockCheck[]
  status              block_status not null default 'ok',
  source              block_source not null default 'user',
  model               text,
  created_at          timestamptz not null default now()
);
create index blocks_dataset on blocks(dataset_id, created_at desc);
create index blocks_owner   on blocks(owner_id, created_at desc);

-- ---------- reports ----------
create table reports (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references profiles(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 120),
  subtitle     text,
  period_label text,                             -- e.g. 'October 2026'
  notes        text,
  template_id  uuid,                             -- FK added below (templates are created later in the file)
  comparison   jsonb,                            -- ReportComparison or null
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index reports_ws on reports(owner_id, workspace_id, created_at desc);
create trigger reports_updated before update on reports for each row execute function set_updated_at();

create table report_blocks (
  id               uuid primary key default gen_random_uuid(),
  report_id        uuid not null references reports(id) on delete cascade,
  block_id         uuid not null references blocks(id),   -- NO ACTION: deleting a pinned block is refused (409)
  owner_id         uuid not null references profiles(id) on delete cascade,
  position         int  not null,
  heading_override text,
  unique (report_id, block_id)
);
create index report_blocks_report on report_blocks(report_id, position);

-- ---------- templates and runs ----------
create table report_templates (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null references profiles(id) on delete cascade,
  workspace_id           uuid not null references workspaces(id) on delete cascade,
  name                   text not null check (char_length(name) between 1 and 80),
  expected_columns       jsonb not null,          -- [{ sql_name, name, data_type }]
  definition             jsonb not null,          -- TemplateBlockDef[]
  metrics                jsonb not null default '[]',   -- TemplateMetricDef[]
  created_from_report_id uuid references reports(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index report_templates_ws on report_templates(owner_id, workspace_id);
create trigger report_templates_updated before update on report_templates for each row execute function set_updated_at();

alter table reports
  add constraint reports_template_fk foreign key (template_id) references report_templates(id) on delete set null;

create table report_runs (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references profiles(id) on delete cascade,
  template_id     uuid not null references report_templates(id) on delete cascade,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  dataset_id      uuid references datasets(id) on delete set null,
  report_id       uuid references reports(id) on delete set null,
  period_label    text,
  status          run_status not null default 'running',
  summary_metrics jsonb not null default '[]',    -- [{ key, label, format, value }] used for the next run's comparison
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index report_runs_template on report_runs(template_id, created_at desc);

-- ---------- share links ----------
create table share_links (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references profiles(id) on delete cascade,
  report_id    uuid not null references reports(id) on delete cascade,
  token        text not null unique check (char_length(token) >= 32),   -- generated by the server (crypto.randomBytes)
  show_working boolean not null default false,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  view_count   int not null default 0,
  created_at   timestamptz not null default now()
);
create index share_links_report on share_links(report_id);

-- ---------- usage and billing ----------
create table usage_events (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  kind          usage_kind not null,
  model         text,
  input_tokens  int,
  output_tokens int,
  cost_usd      numeric(10,6),
  meta          jsonb not null default '{}',      -- ids, purpose, timings. NEVER file content or prompts
  created_at    timestamptz not null default now()
);
create index usage_events_owner_time on usage_events(owner_id, created_at desc);

create table subscriptions (
  owner_id           uuid primary key references profiles(id) on delete cascade,
  plan               plan_tier not null default 'free',
  status             subscription_status not null default 'none',
  amount_zar         numeric(10,2),
  payfast_token      text,                         -- PayFast subscription token (needed to cancel)
  payfast_payment_id text,
  next_billing_date  date,
  cancelled_at       timestamptz,
  updated_at         timestamptz not null default now()
);
create trigger subscriptions_updated before update on subscriptions for each row execute function set_updated_at();

-- Usage in the current month (SAST). Counts drive plan limits; cost drives cost tracking.
create or replace view owner_usage_month with (security_invoker = true) as
select
  owner_id,
  count(*) filter (where kind = 'upload')     as uploads,
  count(*) filter (where kind = 'question')   as questions,
  count(*) filter (where kind = 'report')     as reports,
  count(*) filter (where kind = 'report_run') as report_runs,
  count(*) filter (where kind = 'export')     as exports,
  coalesce(sum(cost_usd), 0)                  as llm_cost_usd
from usage_events
where created_at >= ((date_trunc('month', now() at time zone 'Africa/Johannesburg')) at time zone 'Africa/Johannesburg')
group by owner_id;

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table plan_limits      enable row level security;
alter table profiles         enable row level security;
alter table workspaces       enable row level security;
alter table datasets         enable row level security;
alter table dataset_columns  enable row level security;
alter table blocks           enable row level security;
alter table reports          enable row level security;
alter table report_blocks    enable row level security;
alter table report_templates enable row level security;
alter table report_runs      enable row level security;
alter table share_links      enable row level security;
alter table usage_events     enable row level security;
alter table subscriptions    enable row level security;

-- Anyone signed in may read the plan table.
create policy plan_limits_read on plan_limits for select to authenticated using (true);

-- READ-ONLY for signed-in users, scoped to their own rows. There are deliberately NO insert/update/delete
-- policies: every write goes through the server (service-role client, always filtered by owner_id), because
-- plan limits, usage counts, `plan` and `popia_consent_at` must not be writable by a user straight through
-- the Supabase REST API with their own token.
create policy profiles_select         on profiles         for select to authenticated using (id = auth.uid());
create policy workspaces_select       on workspaces       for select to authenticated using (owner_id = auth.uid());
create policy datasets_select         on datasets         for select to authenticated using (owner_id = auth.uid());
create policy dataset_columns_select  on dataset_columns  for select to authenticated using (owner_id = auth.uid());
create policy blocks_select           on blocks           for select to authenticated using (owner_id = auth.uid());
create policy reports_select          on reports          for select to authenticated using (owner_id = auth.uid());
create policy report_blocks_select    on report_blocks    for select to authenticated using (owner_id = auth.uid());
create policy report_templates_select on report_templates for select to authenticated using (owner_id = auth.uid());
create policy report_runs_select      on report_runs      for select to authenticated using (owner_id = auth.uid());
create policy share_links_select      on share_links      for select to authenticated using (owner_id = auth.uid());
create policy usage_events_select     on usage_events     for select to authenticated using (owner_id = auth.uid());
create policy subscriptions_select    on subscriptions    for select to authenticated using (owner_id = auth.uid());

-- ============================================================================
-- Writes, public share links, the PayFast webhook, purge jobs and account
-- deletion use the service-role client in the server and bypass RLS on purpose.
-- Reads for signed-in users use a per-request client carrying the user's JWT,
-- so RLS still protects reads if a route forgets an owner filter.
-- ============================================================================
