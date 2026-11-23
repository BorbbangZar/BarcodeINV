alter table public.barcode_audit_logs
  drop constraint if exists barcode_audit_logs_action_check;
alter table public.barcode_audit_logs
  add constraint barcode_audit_logs_action_check
  check (action in ('import', 'scan', 'unlink', 'close', 'export', 'user_access'));

create or replace function public.barcode_unlink_scan(
  p_item_id uuid,
  p_expected_barcode text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.barcode_items%rowtype;
  v_expected text := regexp_replace(coalesce(p_expected_barcode, ''), '\\s', '', 'g');
  v_name text;
begin
  if not public.barcode_can_use() then raise exception 'BARCODE_PERMISSION_REQUIRED'; end if;

  select i.* into v_item
  from public.barcode_items i
  join public.barcode_batches b on b.id = i.batch_id and b.status = 'active'
  where i.id = p_item_id
  for update of i;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  if v_item.new_barcode is null then
    if coalesce(v_item.current_barcode, '') <> '' then
      raise exception 'BARCODE_NOT_LINKED_BY_TEAM';
    end if;
    raise exception 'BARCODE_ALREADY_UNLINKED';
  end if;
  if v_item.new_barcode <> v_expected then raise exception 'BARCODE_CHANGED'; end if;

  select display_name into v_name from public.profiles where id = auth.uid();
  update public.barcode_items
  set new_barcode = null,
      scanned_at = null,
      scanned_by = null,
      scanned_by_name = null,
      updated_at = now()
  where id = v_item.id;

  insert into public.barcode_audit_logs(
    batch_id, item_id, actor_id, actor_name, action, old_value, new_value, details
  ) values (
    v_item.batch_id, v_item.id, auth.uid(), v_name, 'unlink', v_item.new_barcode, null,
    jsonb_build_object('workingCode', v_item.working_code)
  );

  return jsonb_build_object('ok', true, 'itemId', v_item.id, 'removedBarcode', v_item.new_barcode);
end;
$$;

revoke execute on function public.barcode_unlink_scan(uuid, text) from public, anon;
grant execute on function public.barcode_unlink_scan(uuid, text) to authenticated;
