-- Part W2: one AI-planned dashboard per dataset (GET/POST /datasets/:id/dashboard, POST /datasets/:id/dashboard/data).
-- plan holds { reading, filters, widgets } (api-types DashboardReading, DashboardFilter[], DashboardWidget[]); results are never
-- stored, they are computed by the server on every data request. Same RLS style as the other tables: signed-in users may read
-- their own rows; every write goes through the server (service-role client, always filtered by owner_id).

create table dashboards (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  dataset_id    uuid not null unique references datasets(id) on delete cascade,
  status        text not null default 'planning' check (status in ('planning', 'ready', 'failed')),
  fallback      boolean not null default false,
  error_message text,                                -- short, user-safe
  plan          jsonb not null default '{"reading": {"text": "", "date_column": null}, "filters": [], "widgets": []}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index dashboards_owner on dashboards(owner_id);
create trigger dashboards_updated before update on dashboards for each row execute function set_updated_at();

alter table dashboards enable row level security;
create policy dashboards_select on dashboards for select to authenticated using (owner_id = auth.uid());
