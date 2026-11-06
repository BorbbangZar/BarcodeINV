-- Allow safe retry of an interrupted import and accept legacy source barcodes.

alter table public.barcode_items
  drop constraint if exists barcode_items_current_barcode_check;

create or replace function public.barcode_create_batch(p_meta jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_source_batch_id text := btrim(p_meta->>'batchId');
begin
  if not public.barcode_can_import() then raise exception 'IMPORT_PERMISSION_REQUIRED'; end if;
  if coalesce(p_meta->>'schema', '') <> 'invc-barcode-work/v1' then raise exception 'INVALID_SCHEMA'; end if;
  if nullif(v_source_batch_id, '') is null then raise exception 'BATCH_ID_REQUIRED'; end if;
  if nullif(btrim(p_meta->>'transferToken'), '') is null then raise exception 'TRANSFER_TOKEN_REQUIRED'; end if;

  delete from public.barcode_batches
  where source_batch_id = v_source_batch_id and status = 'importing';

  if exists(select 1 from public.barcode_batches where source_batch_id = v_source_batch_id) then
    raise exception 'BATCH_ALREADY_EXISTS';
  end if;

  insert into public.barcode_batches (
    source_batch_id, schema_version, source_exported_at, warehouse,
    warehouse_label, transfer_token, source_operator, imported_by
  ) values (
    v_source_batch_id, p_meta->>'schema', nullif(p_meta->>'exportedAt', '')::timestamptz,
    coalesce(nullif(btrim(p_meta->>'warehouse'), ''), 'inventory'),
    coalesce(nullif(btrim(p_meta->>'warehouseLabel'), ''), 'คลังที่นำเข้า'),
    p_meta->>'transferToken', nullif(btrim(p_meta->>'operator'), ''), auth.uid()
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.barcode_create_batch(jsonb) from public, anon;
grant execute on function public.barcode_create_batch(jsonb) to authenticated;
