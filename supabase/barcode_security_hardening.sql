-- Security and performance hardening after advisor review.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- A counter must never be able to self-enable or grant permissions.
drop policy if exists "profiles own update" on public.profiles;

drop policy if exists "profiles own read" on public.profiles;
create policy "profiles own read"
  on public.profiles for select to authenticated
  using ((id = (select auth.uid())) or public.is_admin());

drop policy if exists "audit own insert" on public.audit_logs;
create policy "audit own insert"
  on public.audit_logs for insert to authenticated
  with check (actor_id = (select auth.uid()));

create index if not exists barcode_batches_imported_by_idx
  on public.barcode_batches(imported_by);
create index if not exists barcode_items_scanned_by_idx
  on public.barcode_items(scanned_by);
create index if not exists barcode_audit_batch_idx
  on public.barcode_audit_logs(batch_id);
create index if not exists barcode_audit_item_idx
  on public.barcode_audit_logs(item_id);
create index if not exists barcode_audit_actor_idx
  on public.barcode_audit_logs(actor_id);
