-- MANUAL SAFE FALLBACK ONLY; exclude this subdirectory from migration runners.
-- Apply after 002_trustee_google_auth.sql as postgres.
--
-- Keeps all users, identities, data, trustees, grants and original policies.
-- Keeps every restrictive guard. Only the pinned break-glass UUID retains
-- private portal access; public published-hui reads and public downloads remain.
-- Reapply 002_trustee_google_auth.sql to restore active Google trustee access.
--
-- NEVER revert to the old permissive Worker while Google/user sessions exist:
-- service_role bypasses RLS. Disabling Google alone does NOT invalidate sessions.
-- Retain the Worker's getUser(token), pinned UUID escape hatch, and per-request
-- current_portal_access() checks. No automatic full uninstall is provided.

begin;

do $preflight$
begin
  if not exists (
    select 1 from auth.users
    where id = '0a84ad22-04a1-4778-8c2e-84c87c297461'::pg_catalog.uuid
  ) then
    raise exception 'Required existing break-glass user UUID is missing';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where (n.nspname, c.relname) in (
      ('public', 'hui'), ('public', 'documents'), ('storage', 'objects')
    ) and c.relrowsecurity
  ) <> 3 then
    raise exception 'RLS must remain enabled on all three protected tables';
  end if;

  -- A rollback without guards would reopen the original permissive policies.
  if exists (
    select 1
    from (values
      ('public.hui', 'portal_trustee_guard_hui_select_anon', 'r', 'anon'),
      ('public.hui', 'portal_trustee_guard_hui_select_authenticated', 'r', 'authenticated'),
      ('public.hui', 'portal_trustee_guard_hui_insert', 'a', 'authenticated'),
      ('public.hui', 'portal_trustee_guard_hui_update', 'w', 'authenticated'),
      ('public.hui', 'portal_trustee_guard_hui_delete', 'd', 'authenticated'),
      ('public.documents', 'portal_trustee_guard_documents_select_anon', 'r', 'anon'),
      ('public.documents', 'portal_trustee_guard_documents_select_authenticated', 'r', 'authenticated'),
      ('public.documents', 'portal_trustee_guard_documents_insert', 'a', 'authenticated'),
      ('public.documents', 'portal_trustee_guard_documents_update', 'w', 'authenticated'),
      ('public.documents', 'portal_trustee_guard_documents_delete', 'd', 'authenticated'),
      ('storage.objects', 'portal_trustee_guard_storage_insert', 'a', 'authenticated'),
      ('storage.objects', 'portal_trustee_guard_storage_update', 'w', 'authenticated'),
      ('storage.objects', 'portal_trustee_guard_storage_delete', 'd', 'authenticated')
    ) as expected(table_name, policy_name, command, role_name)
    left join pg_catalog.pg_policy as p
      on p.polrelid = expected.table_name::pg_catalog.regclass
      and p.polname = expected.policy_name
    where p.oid is null or p.polpermissive
      or p.polcmd::pg_catalog.text <> expected.command
      or p.polroles <> array[(expected.role_name::pg_catalog.regrole)::pg_catalog.oid]
  ) then
    raise exception 'Complete restrictive guards are required; first reapply 002_trustee_google_auth.sql';
  end if;
end;
$preflight$;

-- Deliberately no reference to trustees, providers, identities or mutable email
-- metadata. Even a broken/missing membership table cannot disable this branch.
create or replace function portal_private.current_portal_access()
returns pg_catalog.jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_id pg_catalog.uuid := auth.uid();
  current_email pg_catalog.text;
begin
  if caller_id is null
    or caller_id <> '0a84ad22-04a1-4778-8c2e-84c87c297461'::pg_catalog.uuid then
    return 'null'::pg_catalog.jsonb;
  end if;

  select u.email into current_email
  from auth.users as u where u.id = caller_id;
  if not found then
    return 'null'::pg_catalog.jsonb;
  end if;

  return pg_catalog.jsonb_build_object(
    'userId', caller_id,
    'email', current_email,
    'name', 'Trust administrator',
    'role', 'Admin',
    'isBreakGlass', true
  );
end;
$function$;

create or replace function portal_private.is_portal_authorized()
returns pg_catalog.bool
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_typeof(portal_private.current_portal_access()) = 'object',
    false
  );
$function$;

create or replace function public.current_portal_access()
returns pg_catalog.jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select portal_private.current_portal_access();
$function$;

alter function portal_private.current_portal_access() owner to postgres;
alter function portal_private.is_portal_authorized() owner to postgres;
alter function public.current_portal_access() owner to postgres;
revoke all on function portal_private.current_portal_access() from public, anon, authenticated, service_role;
revoke all on function portal_private.is_portal_authorized() from public, anon, authenticated, service_role;
revoke all on function public.current_portal_access() from public, anon, authenticated, service_role;
grant execute on function portal_private.current_portal_access() to authenticated;
grant execute on function portal_private.is_portal_authorized() to authenticated;
grant execute on function public.current_portal_access() to authenticated;

notify pgrst, 'reload schema';
commit;
