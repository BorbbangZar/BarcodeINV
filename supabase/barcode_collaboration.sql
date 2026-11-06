-- INVC Barcode Collaboration
-- Isolated from the existing stocktake tables by the barcode_ prefix.

alter table public.profiles
  add column if not exists can_barcode boolean not null default true;

create table if not exists public.barcode_batches (
  id uuid primary key default gen_random_uuid(),
  source_batch_id text not null unique,
  schema_version text not null default 'invc-barcode-work/v1',
  source_exported_at timestamptz,
  warehouse text not null,
  warehouse_label text not null,
  transfer_token text not null,
  source_operator text,
  status text not null default 'importing'
    check (status in ('importing', 'active', 'closed')),
  item_count integer not null default 0 check (item_count >= 0),
  imported_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.barcode_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.barcode_batches(id) on delete cascade,
  trade_record_number bigint not null,
  working_code text not null,
  drug_name text not null,
  trade_name text,
  dosage_form text,
  sale_unit text,
  pack_ratio numeric,
  location text,
  vendor_code text,
  vendor_name text,
  manufacturer_code text,
  manufacturer_name text,
  current_barcode text,
  new_barcode text,
  transfer_proof text not null,
  lots jsonb not null default '[]'::jsonb,
  lot_count integer not null default 0 check (lot_count >= 0),
  scanned_at timestamptz,
  scanned_by uuid references auth.users(id),
  scanned_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, trade_record_number),
  check (current_barcode is null or current_barcode ~ '^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$'),
  check (new_barcode is null or new_barcode ~ '^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$')
);

create index if not exists barcode_items_batch_name_idx
  on public.barcode_items (batch_id, drug_name, working_code);
create index if not exists barcode_items_batch_location_idx
  on public.barcode_items (batch_id, location);
create index if not exists barcode_items_batch_status_idx
  on public.barcode_items (batch_id, new_barcode, current_barcode);

create table if not exists public.barcode_audit_logs (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.barcode_batches(id) on delete cascade,
  item_id uuid references public.barcode_items(id) on delete set null,
  actor_id uuid not null references auth.users(id),
  actor_name text,
  action text not null check (action in ('import', 'scan', 'close', 'export', 'user_access')),
  old_value text,
  new_value text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.barcode_batches enable row level security;
alter table public.barcode_items enable row level security;
alter table public.barcode_audit_logs enable row level security;

create or replace function public.barcode_can_use()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and coalesce(p.active, p.is_active, false)
      and (p.role = 'admin' or coalesce(p.can_barcode, false))
  );
$$;

create or replace function public.barcode_can_import()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and coalesce(p.active, p.is_active, false)
      and (p.role = 'admin' or coalesce(p.can_import, false))
  );
$$;

drop policy if exists "barcode batches read" on public.barcode_batches;
create policy "barcode batches read"
  on public.barcode_batches for select to authenticated
  using (public.barcode_can_use());

drop policy if exists "barcode items read" on public.barcode_items;
create policy "barcode items read"
  on public.barcode_items for select to authenticated
  using (public.barcode_can_use());

drop policy if exists "barcode audit admin read" on public.barcode_audit_logs;
create policy "barcode audit admin read"
  on public.barcode_audit_logs for select to authenticated
  using (public.is_admin());

revoke all on public.barcode_batches from anon, authenticated;
revoke all on public.barcode_items from anon, authenticated;
revoke all on public.barcode_audit_logs from anon, authenticated;
grant select on public.barcode_batches to authenticated;
grant select on public.barcode_items to authenticated;
grant select on public.barcode_audit_logs to authenticated;

create or replace function public.barcode_ensure_profile(p_display_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_is_first boolean;
  v_profile public.profiles%rowtype;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  lock table public.profiles in share row exclusive mode;
  select not exists(select 1 from public.profiles) into v_is_first;

  insert into public.profiles (
    id, display_name, username, role, active, is_active,
    can_drug, can_medical_supply, can_stocktake, can_reports,
    can_import, can_manage_users, can_barcode
  ) values (
    v_uid,
    nullif(btrim(p_display_name), ''),
    null,
    case when v_is_first then 'admin' else 'counter' end,
    v_is_first,
    v_is_first,
    true, true, true, true,
    v_is_first, v_is_first, true
  )
  on conflict (id) do update set
    display_name = coalesce(nullif(public.profiles.display_name, ''), excluded.display_name),
    updated_at = now();

  select * into v_profile from public.profiles where id = v_uid;
  return jsonb_build_object(
    'id', v_profile.id,
    'displayName', v_profile.display_name,
    'role', v_profile.role,
    'active', coalesce(v_profile.active, v_profile.is_active, false),
    'canImport', coalesce(v_profile.can_import, false),
    'canBarcode', coalesce(v_profile.can_barcode, false),
    'canManageUsers', coalesce(v_profile.can_manage_users, false)
  );
end;
$$;

create or replace function public.barcode_set_user_access(
  p_user_id uuid,
  p_active boolean,
  p_can_import boolean default false,
  p_can_barcode boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_user_id = auth.uid() and not p_active then raise exception 'CANNOT_DISABLE_SELF'; end if;

  update public.profiles
  set active = p_active,
      is_active = p_active,
      can_import = p_can_import,
      can_barcode = p_can_barcode,
      updated_at = now()
  where id = p_user_id;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  select display_name into v_actor from public.profiles where id = auth.uid();
  return jsonb_build_object('ok', true, 'userId', p_user_id, 'active', p_active,
    'canImport', p_can_import, 'canBarcode', p_can_barcode, 'actor', v_actor);
end;
$$;

create or replace function public.barcode_checksum_valid(p_barcode text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_length integer := length(p_barcode);
  v_sum integer := 0;
  v_i integer;
  v_check integer;
begin
  if p_barcode is null or p_barcode !~ '^[0-9]+$' or v_length not in (8, 12, 13) then
    return false;
  end if;
  v_check := substr(p_barcode, v_length, 1)::integer;
  for v_i in 1..v_length - 1 loop
    v_sum := v_sum + substr(p_barcode, v_i, 1)::integer *
      case when mod(v_length - v_i, 2) = 0 then 1 else 3 end;
  end loop;
  return mod(10 - mod(v_sum, 10), 10) = v_check;
end;
$$;

create or replace function public.barcode_create_batch(p_meta jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if not public.barcode_can_import() then raise exception 'IMPORT_PERMISSION_REQUIRED'; end if;
  if coalesce(p_meta->>'schema', '') <> 'invc-barcode-work/v1' then raise exception 'INVALID_SCHEMA'; end if;
  if nullif(btrim(p_meta->>'batchId'), '') is null then raise exception 'BATCH_ID_REQUIRED'; end if;
  if nullif(btrim(p_meta->>'transferToken'), '') is null then raise exception 'TRANSFER_TOKEN_REQUIRED'; end if;

  insert into public.barcode_batches (
    source_batch_id, schema_version, source_exported_at, warehouse,
    warehouse_label, transfer_token, source_operator, imported_by
  ) values (
    btrim(p_meta->>'batchId'), p_meta->>'schema', nullif(p_meta->>'exportedAt', '')::timestamptz,
    coalesce(nullif(btrim(p_meta->>'warehouse'), ''), 'inventory'),
    coalesce(nullif(btrim(p_meta->>'warehouseLabel'), ''), 'คลังที่นำเข้า'),
    p_meta->>'transferToken', nullif(btrim(p_meta->>'operator'), ''), auth.uid()
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'BATCH_ALREADY_EXISTS';
end;
$$;

create or replace function public.barcode_import_items(p_batch_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_count integer := 0;
begin
  if not public.barcode_can_import() then raise exception 'IMPORT_PERMISSION_REQUIRED'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'ITEMS_ARRAY_REQUIRED'; end if;
  if not exists (
    select 1 from public.barcode_batches
    where id = p_batch_id and status = 'importing'
  ) then raise exception 'BATCH_NOT_IMPORTING'; end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.barcode_items (
      batch_id, trade_record_number, working_code, drug_name, trade_name,
      dosage_form, sale_unit, pack_ratio, location, vendor_code, vendor_name,
      manufacturer_code, manufacturer_name, current_barcode, transfer_proof,
      lots, lot_count
    ) values (
      p_batch_id,
      (v_item->>'tradeRecordNumber')::bigint,
      btrim(v_item->>'code'),
      btrim(v_item->>'name'),
      nullif(btrim(v_item->>'tradeName'), ''),
      nullif(btrim(v_item->>'dosageForm'), ''),
      nullif(btrim(v_item->>'unit'), ''),
      nullif(v_item->>'packRatio', '')::numeric,
      nullif(btrim(v_item->>'location'), ''),
      nullif(btrim(v_item->>'vendorCode'), ''),
      nullif(btrim(v_item->>'vendor'), ''),
      nullif(btrim(v_item->>'manufacturerCode'), ''),
      nullif(btrim(v_item->>'manufacturer'), ''),
      nullif(regexp_replace(coalesce(v_item->>'currentBarcode', ''), '\\s', '', 'g'), ''),
      coalesce(v_item->>'transferProof', ''),
      coalesce(v_item->'lots', '[]'::jsonb),
      coalesce(nullif(v_item->>'lotCount', '')::integer, jsonb_array_length(coalesce(v_item->'lots', '[]'::jsonb)))
    )
    on conflict (batch_id, trade_record_number) do update set
      working_code = excluded.working_code,
      drug_name = excluded.drug_name,
      trade_name = excluded.trade_name,
      dosage_form = excluded.dosage_form,
      sale_unit = excluded.sale_unit,
      pack_ratio = excluded.pack_ratio,
      location = excluded.location,
      vendor_code = excluded.vendor_code,
      vendor_name = excluded.vendor_name,
      manufacturer_code = excluded.manufacturer_code,
      manufacturer_name = excluded.manufacturer_name,
      current_barcode = excluded.current_barcode,
      transfer_proof = excluded.transfer_proof,
      lots = excluded.lots,
      lot_count = excluded.lot_count,
      updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.barcode_finalize_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
  v_name text;
begin
  if not public.barcode_can_import() then raise exception 'IMPORT_PERMISSION_REQUIRED'; end if;
  select count(*) into v_count from public.barcode_items where batch_id = p_batch_id;
  if v_count = 0 then raise exception 'EMPTY_BATCH'; end if;

  update public.barcode_batches
  set status = 'active', item_count = v_count
  where id = p_batch_id and status = 'importing';
  if not found then raise exception 'BATCH_NOT_IMPORTING'; end if;
  select display_name into v_name from public.profiles where id = auth.uid();
  insert into public.barcode_audit_logs(batch_id, actor_id, actor_name, action, details)
  values (p_batch_id, auth.uid(), v_name, 'import', jsonb_build_object('itemCount', v_count));
  return jsonb_build_object('ok', true, 'batchId', p_batch_id, 'itemCount', v_count);
end;
$$;

create or replace function public.barcode_save_scan(
  p_item_id uuid,
  p_barcode text,
  p_expected_barcode text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.barcode_items%rowtype;
  v_barcode text := regexp_replace(coalesce(p_barcode, ''), '\\s', '', 'g');
  v_effective text;
  v_name text;
begin
  if not public.barcode_can_use() then raise exception 'BARCODE_PERMISSION_REQUIRED'; end if;
  if not public.barcode_checksum_valid(v_barcode) then raise exception 'INVALID_BARCODE'; end if;

  select i.* into v_item
  from public.barcode_items i
  join public.barcode_batches b on b.id = i.batch_id and b.status = 'active'
  where i.id = p_item_id
  for update of i;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;

  v_effective := coalesce(v_item.new_barcode, v_item.current_barcode, '');
  if v_effective <> coalesce(p_expected_barcode, '') then raise exception 'BARCODE_CHANGED'; end if;
  if v_effective <> '' then
    if v_effective = v_barcode then
      return jsonb_build_object('ok', true, 'unchanged', true, 'barcode', v_effective);
    end if;
    raise exception 'BARCODE_ALREADY_LINKED';
  end if;

  if exists (
    select 1 from public.barcode_items x
    where x.batch_id = v_item.batch_id and x.id <> v_item.id
      and coalesce(x.new_barcode, x.current_barcode, '') = v_barcode
  ) then raise exception 'BARCODE_DUPLICATE'; end if;

  select display_name into v_name from public.profiles where id = auth.uid();
  update public.barcode_items
  set new_barcode = v_barcode,
      scanned_at = now(),
      scanned_by = auth.uid(),
      scanned_by_name = v_name,
      updated_at = now()
  where id = v_item.id;

  insert into public.barcode_audit_logs(
    batch_id, item_id, actor_id, actor_name, action, old_value, new_value
  ) values (
    v_item.batch_id, v_item.id, auth.uid(), v_name, 'scan', null, v_barcode
  );
  return jsonb_build_object('ok', true, 'itemId', v_item.id, 'barcode', v_barcode,
    'scannedAt', now(), 'scannedByName', v_name);
end;
$$;

create or replace function public.barcode_export_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_batch public.barcode_batches%rowtype;
  v_results jsonb;
  v_name text;
begin
  if not public.barcode_can_import() then raise exception 'IMPORT_PERMISSION_REQUIRED'; end if;
  select * into v_batch from public.barcode_batches where id = p_batch_id;
  if not found then raise exception 'BATCH_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'tradeRecordNumber', i.trade_record_number,
    'workingCode', i.working_code,
    'manufacturerCode', coalesce(i.manufacturer_code, ''),
    'packRatio', i.pack_ratio,
    'expectedBarcode', coalesce(i.current_barcode, ''),
    'newBarcode', i.new_barcode,
    'transferProof', i.transfer_proof,
    'scannedAt', i.scanned_at,
    'operator', coalesce(i.scanned_by_name, '')
  ) order by i.trade_record_number), '[]'::jsonb)
  into v_results
  from public.barcode_items i
  where i.batch_id = p_batch_id and i.new_barcode is not null;

  select display_name into v_name from public.profiles where id = auth.uid();
  insert into public.barcode_audit_logs(batch_id, actor_id, actor_name, action, details)
  values (p_batch_id, auth.uid(), v_name, 'export', jsonb_build_object('resultCount', jsonb_array_length(v_results)));

  return jsonb_build_object(
    'schema', 'invc-barcode-result/v1',
    'batchId', v_batch.source_batch_id,
    'sourceExportedAt', v_batch.source_exported_at,
    'warehouse', v_batch.warehouse,
    'warehouseLabel', v_batch.warehouse_label,
    'transferToken', v_batch.transfer_token,
    'exportedAt', now(),
    'operator', coalesce(v_name, ''),
    'resultCount', jsonb_array_length(v_results),
    'results', v_results
  );
end;
$$;

revoke execute on function public.barcode_can_use() from public, anon;
revoke execute on function public.barcode_can_import() from public, anon;
revoke execute on function public.barcode_checksum_valid(text) from public, anon;
revoke execute on function public.barcode_ensure_profile(text) from public, anon;
revoke execute on function public.barcode_set_user_access(uuid, boolean, boolean, boolean) from public, anon;
revoke execute on function public.barcode_create_batch(jsonb) from public, anon;
revoke execute on function public.barcode_import_items(uuid, jsonb) from public, anon;
revoke execute on function public.barcode_finalize_batch(uuid) from public, anon;
revoke execute on function public.barcode_save_scan(uuid, text, text) from public, anon;
revoke execute on function public.barcode_export_batch(uuid) from public, anon;

grant execute on function public.barcode_ensure_profile(text) to authenticated;
grant execute on function public.barcode_set_user_access(uuid, boolean, boolean, boolean) to authenticated;
grant execute on function public.barcode_create_batch(jsonb) to authenticated;
grant execute on function public.barcode_import_items(uuid, jsonb) to authenticated;
grant execute on function public.barcode_finalize_batch(uuid) to authenticated;
grant execute on function public.barcode_save_scan(uuid, text, text) to authenticated;
grant execute on function public.barcode_export_batch(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'barcode_items'
  ) then
    alter publication supabase_realtime add table public.barcode_items;
  end if;
end $$;
