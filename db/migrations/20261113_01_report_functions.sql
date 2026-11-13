-- Part 4 (S3): atomic report writes.
-- Supabase's REST client has no multi-statement transactions, so creating a report with its blocks, and replacing a
-- report's blocks, run as SQL functions: each call is one transaction, and any error leaves everything as it was.
-- Called only by the server with the service-role key; signed-in users cannot execute them.
-- The server checks ownership, the workspace rule and lengths before calling; the functions re-check ownership so a
-- block or report of another owner can never be written, whatever the caller passes.

-- Inserts a report and its blocks (positions 0..n-1 in the given order). Returns the new report id.
create or replace function create_report_with_blocks(
  p_owner_id     uuid,
  p_workspace_id uuid,
  p_title        text,
  p_subtitle     text,
  p_period_label text,
  p_block_ids    uuid[]
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_report_id uuid;
  v_owned     int;
begin
  if p_block_ids is null or cardinality(p_block_ids) = 0 then
    raise exception 'report_blocks_empty' using errcode = '22023';
  end if;
  if not exists (select 1 from workspaces where id = p_workspace_id and owner_id = p_owner_id) then
    raise exception 'report_workspace_not_found' using errcode = 'P0002';
  end if;
  select count(distinct id) into v_owned from blocks where id = any(p_block_ids) and owner_id = p_owner_id;
  if v_owned <> cardinality(p_block_ids) then
    raise exception 'report_block_not_found' using errcode = 'P0002';
  end if;

  insert into reports (owner_id, workspace_id, title, subtitle, period_label)
  values (p_owner_id, p_workspace_id, p_title, p_subtitle, p_period_label)
  returning id into v_report_id;

  insert into report_blocks (report_id, block_id, owner_id, position)
  select v_report_id, b.id, p_owner_id, (b.ord - 1)::int
  from unnest(p_block_ids) with ordinality as b(id, ord);

  return v_report_id;
end $$;

-- Updates a report's fields and, when p_blocks is not null, replaces its blocks (membership, order and headings).
-- p_fields holds only the fields to change (title, subtitle, period_label, notes); a key present with JSON null sets
-- the column to null. p_blocks is a JSON array of { block_id, heading_override } in display order, or null to keep
-- the current blocks. Returns false when the report is not the owner's (nothing changed).
create or replace function update_report_with_blocks(
  p_owner_id  uuid,
  p_report_id uuid,
  p_fields    jsonb,
  p_blocks    jsonb
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_count int;
  v_owned int;
begin
  -- Lock the report row so two concurrent edits apply one after the other.
  perform 1 from reports where id = p_report_id and owner_id = p_owner_id for update;
  if not found then
    return false;
  end if;

  update reports set
    title        = case when p_fields ? 'title'        then p_fields->>'title'        else title end,
    subtitle     = case when p_fields ? 'subtitle'     then p_fields->>'subtitle'     else subtitle end,
    period_label = case when p_fields ? 'period_label' then p_fields->>'period_label' else period_label end,
    notes        = case when p_fields ? 'notes'        then p_fields->>'notes'        else notes end,
    updated_at   = now()
  where id = p_report_id and owner_id = p_owner_id;

  if p_blocks is not null then
    v_count := jsonb_array_length(p_blocks);
    if v_count = 0 then
      raise exception 'report_blocks_empty' using errcode = '22023';
    end if;
    select count(distinct b.id) into v_owned
    from blocks b
    where b.owner_id = p_owner_id
      and b.id in (select (e->>'block_id')::uuid from jsonb_array_elements(p_blocks) as e);
    if v_owned <> v_count then
      raise exception 'report_block_not_found' using errcode = 'P0002';
    end if;

    delete from report_blocks where report_id = p_report_id and owner_id = p_owner_id;
    insert into report_blocks (report_id, block_id, owner_id, position, heading_override)
    select p_report_id, (e->>'block_id')::uuid, p_owner_id, (ord - 1)::int, nullif(e->>'heading_override', '')
    from jsonb_array_elements(p_blocks) with ordinality as t(e, ord);
  end if;

  return true;
end $$;

revoke all on function create_report_with_blocks(uuid, uuid, text, text, text, uuid[]) from public, anon, authenticated;
revoke all on function update_report_with_blocks(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function create_report_with_blocks(uuid, uuid, text, text, text, uuid[]) to service_role;
grant execute on function update_report_with_blocks(uuid, uuid, jsonb, jsonb) to service_role;
