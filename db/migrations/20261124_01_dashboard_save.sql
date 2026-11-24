-- Part W3: save the dashboard to a report.
-- Blocks made from dashboard widgets have source 'dashboard' and carry the filters in force when they were saved, in
-- the server's resolved form: [{ filter_id, kind, column, label, from, to, values }] (column = sql_name). The API shows
-- them as DashboardFilterValue[]; source rows rebuild the same bound-parameter predicate from them.
-- The whole file can run at once: the new enum value is only used when the function is called, after the commit.

alter type block_source add value if not exists 'dashboard';

alter table blocks add column if not exists filters jsonb;   -- source 'dashboard': resolved filters ([] = none); null otherwise

-- Inserts the dashboard blocks and either creates a report with them (p_report_id null) or appends them after the
-- report's current answers. One call is one transaction: any error leaves no block and no report behind.
-- p_blocks is a JSON array, in report order, of { title, sql, columns, rows, row_count, truncated, chart, narrative,
-- checks, status, filters }. Called only by the server with the service-role key, after its own checks; ownership,
-- the workspace rule and the 30-answer limit are checked again here.
create or replace function save_dashboard_blocks(
  p_owner_id   uuid,
  p_dataset_id uuid,
  p_report_id  uuid,
  p_title      text,
  p_blocks     jsonb
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_workspace uuid;
  v_report    uuid;
  v_next      int;
  v_count     int;
  v_block     uuid;
  r           record;
begin
  v_count := coalesce(jsonb_array_length(p_blocks), 0);
  if v_count = 0 then
    raise exception 'report_blocks_empty' using errcode = '22023';
  end if;
  select workspace_id into v_workspace from datasets where id = p_dataset_id and owner_id = p_owner_id;
  if not found then
    raise exception 'dataset_not_found' using errcode = 'P0002';
  end if;

  if p_report_id is null then
    if v_count > 30 then
      raise exception 'report_full' using errcode = '22023';
    end if;
    insert into reports (owner_id, workspace_id, title) values (p_owner_id, v_workspace, p_title) returning id into v_report;
    v_next := 0;
  else
    -- Lock the report so a concurrent edit or save applies one after the other.
    perform 1 from reports where id = p_report_id and owner_id = p_owner_id for update;
    if not found then
      raise exception 'report_not_found' using errcode = 'P0002';
    end if;
    if not exists (select 1 from reports where id = p_report_id and workspace_id = v_workspace) then
      raise exception 'report_other_workspace' using errcode = '22023';
    end if;
    select count(*), coalesce(max(position) + 1, 0) into v_count, v_next from report_blocks where report_id = p_report_id and owner_id = p_owner_id;
    if v_count + jsonb_array_length(p_blocks) > 30 then
      raise exception 'report_full' using errcode = '22023';
    end if;
    update reports set updated_at = now() where id = p_report_id and owner_id = p_owner_id;
    v_report := p_report_id;
  end if;

  for r in select e, (ord - 1)::int as i from jsonb_array_elements(p_blocks) with ordinality as t(e, ord) loop
    insert into blocks (owner_id, dataset_id, question, title, sql, columns, rows, row_count, truncated, chart,
                        narrative_template, narrative, follow_ups, checks, status, source, filters)
    values (p_owner_id, p_dataset_id, r.e->>'title', r.e->>'title', r.e->>'sql', r.e->'columns', r.e->'rows',
            (r.e->>'row_count')::int, (r.e->>'truncated')::boolean, r.e->'chart', r.e->>'narrative', r.e->>'narrative',
            '[]'::jsonb, r.e->'checks', (r.e->>'status')::block_status, 'dashboard', r.e->'filters')
    returning id into v_block;
    insert into report_blocks (report_id, block_id, owner_id, position) values (v_report, v_block, p_owner_id, v_next + r.i);
  end loop;

  return v_report;
end $$;

revoke all on function save_dashboard_blocks(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function save_dashboard_blocks(uuid, uuid, uuid, text, jsonb) to service_role;
