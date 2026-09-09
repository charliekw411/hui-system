-- Additive Google/trustee authorization. Apply ONCE before deploying the new
-- Worker; safe to reapply. DO NOT rerun 001_initial.sql.
--
-- Run as the trusted postgres migration owner. No auth users/identities, legacy
-- policies, existing portal grants, existing rows, or bucket settings are changed.
-- All five trustee roles have identical, full existing portal capabilities.
--
-- The Worker must validate the bearer token with getUser(token), short-circuit
-- the pinned break-glass UUID BEFORE this RPC, and authorize every other request
-- with the caller's JWT through current_portal_access(). service_role bypasses
-- RLS, so a permissive/old Worker would defeat these database safeguards.
--
-- RLS does not govern TRUNCATE or privileged direct SQL. Existing table grants
-- (including any broader privileges) are intentionally preserved; do not expose
-- direct database credentials or a privileged SQL RPC to browser users.
--
-- Google must be the only enabled social provider. In addition to signed
-- session AMR, the helper rejects accounts linked to other social providers.
-- app_metadata.provider is NOT a session-provider signal, and user_metadata is
-- NOT trusted. Disabling Google does NOT invalidate already-issued sessions.
--
-- Manual safe fallback: manual/safe_breakglass_fallback.sql. It keeps the guards
-- and original policies; reapply THIS file to restore trustee authorization.

begin;

do $preflight$
begin
  if not exists (
    select 1 from auth.users
    where id = '0a84ad22-04a1-4778-8c2e-84c87c297461'::pg_catalog.uuid
  ) then
    raise exception 'Required existing break-glass user UUID is missing; no migration applied';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'hui-documents' and public is true
  ) then
    raise exception 'Existing hui-documents public bucket is required; no bucket changes are made';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where (n.nspname, c.relname) in (
      ('public', 'hui'), ('public', 'documents'), ('storage', 'objects')
    ) and c.relrowsecurity
  ) <> 3 then
    raise exception 'Existing hui, documents and storage.objects must already have RLS enabled';
  end if;

  -- Never replace an original permissive policy, even on a name collision.
  if exists (
    select 1
    from pg_catalog.pg_policy as p
    where p.polrelid in (
      'public.hui'::pg_catalog.regclass,
      'public.documents'::pg_catalog.regclass,
      'storage.objects'::pg_catalog.regclass
    )
      and p.polname like 'portal_trustee_guard_%'
      and p.polpermissive
  ) then
    raise exception 'Guard namespace collides with a permissive policy; manual review required';
  end if;
end;
$preflight$;

create schema if not exists portal_private authorization postgres;
alter schema portal_private owner to postgres;
revoke all on schema portal_private from public, anon, authenticated, service_role;
grant usage on schema portal_private to authenticated;

-- Membership UUIDs are generated independently of auth.users, permitting
-- pre-seeding before signup. Maintenance must supply lower(trim(email)).
create table if not exists public.trustees (
  id pg_catalog.uuid primary key default pg_catalog.gen_random_uuid(),
  email pg_catalog.text not null unique,
  name pg_catalog.text not null,
  role pg_catalog.text not null,
  active pg_catalog.bool not null default true,
  constraint trustees_email_normalized check (
    email <> '' and email = pg_catalog.lower(pg_catalog.btrim(email))
  ),
  constraint trustees_name_not_blank check (pg_catalog.btrim(name) <> ''),
  constraint trustees_role_recognized check (
    role in ('Chair', 'Secretary', 'Admin', 'Treasurer', 'Trustee')
  )
);
alter table public.trustees owner to postgres;
alter table public.trustees enable row level security;

-- No browser membership listing or CRUD. There are deliberately no membership
-- RLS policies. Only this SECURITY DEFINER and trusted service maintenance read it.
revoke all on table public.trustees from public, anon, authenticated;
grant select, insert, update, delete on table public.trustees to service_role;

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
  normalized_email pg_catalog.text;
  claims pg_catalog.jsonb;
  membership record;
begin
  if caller_id is null then
    return 'null'::pg_catalog.jsonb;
  end if;

  -- IMMUTABLE escape hatch: UUID only, before provider checks or ANY reference
  -- to trustees. The existing trust@pehiaweri.local account is never mutated.
  -- PL/pgSQL does not plan the later membership query on this branch.
  if caller_id = '0a84ad22-04a1-4778-8c2e-84c87c297461'::pg_catalog.uuid then
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
  end if;

  select u.email into current_email
  from auth.users as u
  where u.id = caller_id and u.email_confirmed_at is not null;
  if not found or current_email is null then
    return 'null'::pg_catalog.jsonb;
  end if;
  normalized_email := pg_catalog.lower(pg_catalog.btrim(current_email));

  -- GoTrue's signed AMR is session-scoped. A password session on a Google-linked
  -- account must NOT inherit access merely because a Google identity exists.
  claims := auth.jwt();
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(claims -> 'amr') = 'array'
        then claims -> 'amr' else '[]'::pg_catalog.jsonb end
    ) as amr(entry)
    where amr.entry ->> 'method' = 'oauth'
  ) then
    return 'null'::pg_catalog.jsonb;
  end if;

  -- AMR says OAuth, not WHICH social provider. Deny ambiguous linked accounts
  -- rather than accepting a non-Google OAuth session through a Google identity.
  if exists (
    select 1 from auth.identities as i
    where i.user_id = caller_id
      and (i.provider is null or i.provider not in ('google', 'email'))
  ) or not exists (
    select 1 from auth.identities as i
    where i.user_id = caller_id and i.provider = 'google'
      and i.identity_data -> 'email_verified' = 'true'::pg_catalog.jsonb
      and pg_catalog.lower(pg_catalog.btrim(i.identity_data ->> 'email')) = normalized_email
  ) then
    return 'null'::pg_catalog.jsonb;
  end if;

  select t.name, t.role into membership
  from public.trustees as t
  where t.email = normalized_email and t.active is true
    and t.role in ('Chair', 'Secretary', 'Admin', 'Treasurer', 'Trustee');
  if not found then
    return 'null'::pg_catalog.jsonb;
  end if;

  return pg_catalog.jsonb_build_object(
    'userId', caller_id,
    'email', current_email,
    'name', membership.name,
    'role', membership.role,
    'isBreakGlass', false
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

-- No arguments. Denial is JSON null (not an object with a nullable role).
-- Supabase/PostgREST returns the jsonb value directly, not a table/array.
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

-- Only OUR restrictive guards are replaced on reapplication, atomically.
-- All legacy permissive policies, including *_authenticated_all USING true,
-- remain untouched. Restrictive policies AND with their permissive result.
--
-- Separate anon SELECT guards avoid giving anon EXECUTE on private helpers.
drop policy if exists portal_trustee_guard_hui_select_anon on public.hui;
create policy portal_trustee_guard_hui_select_anon on public.hui
  as restrictive for select to anon
  using (status = 'published');
drop policy if exists portal_trustee_guard_hui_select_authenticated on public.hui;
create policy portal_trustee_guard_hui_select_authenticated on public.hui
  as restrictive for select to authenticated
  using (status = 'published' or (select portal_private.is_portal_authorized()));
drop policy if exists portal_trustee_guard_hui_insert on public.hui;
create policy portal_trustee_guard_hui_insert on public.hui
  as restrictive for insert to authenticated
  with check ((select portal_private.is_portal_authorized()));
drop policy if exists portal_trustee_guard_hui_update on public.hui;
create policy portal_trustee_guard_hui_update on public.hui
  as restrictive for update to authenticated
  using ((select portal_private.is_portal_authorized()))
  with check ((select portal_private.is_portal_authorized()));
drop policy if exists portal_trustee_guard_hui_delete on public.hui;
create policy portal_trustee_guard_hui_delete on public.hui
  as restrictive for delete to authenticated
  using ((select portal_private.is_portal_authorized()));

drop policy if exists portal_trustee_guard_documents_select_anon on public.documents;
create policy portal_trustee_guard_documents_select_anon on public.documents
  as restrictive for select to anon
  using (exists (
    select 1 from public.hui as h
    where h.id = documents.hui_id and h.status = 'published'
  ));
drop policy if exists portal_trustee_guard_documents_select_authenticated on public.documents;
create policy portal_trustee_guard_documents_select_authenticated on public.documents
  as restrictive for select to authenticated
  using (
    (select portal_private.is_portal_authorized()) or exists (
      select 1 from public.hui as h
      where h.id = documents.hui_id and h.status = 'published'
    )
  );
drop policy if exists portal_trustee_guard_documents_insert on public.documents;
create policy portal_trustee_guard_documents_insert on public.documents
  as restrictive for insert to authenticated
  with check ((select portal_private.is_portal_authorized()));
drop policy if exists portal_trustee_guard_documents_update on public.documents;
create policy portal_trustee_guard_documents_update on public.documents
  as restrictive for update to authenticated
  using ((select portal_private.is_portal_authorized()))
  with check ((select portal_private.is_portal_authorized()));
drop policy if exists portal_trustee_guard_documents_delete on public.documents;
create policy portal_trustee_guard_documents_delete on public.documents
  as restrictive for delete to authenticated
  using ((select portal_private.is_portal_authorized()));

-- No storage SELECT guard: hui-documents remains an EXISTING PUBLIC bucket.
-- Public URLs remain public even for documents of a draft/unpublished hui.
-- Guard both OLD and NEW bucket_id on UPDATE; other buckets are unaffected.
drop policy if exists portal_trustee_guard_storage_insert on storage.objects;
create policy portal_trustee_guard_storage_insert on storage.objects
  as restrictive for insert to authenticated
  with check (
    bucket_id is distinct from 'hui-documents'
    or (select portal_private.is_portal_authorized())
  );
drop policy if exists portal_trustee_guard_storage_update on storage.objects;
create policy portal_trustee_guard_storage_update on storage.objects
  as restrictive for update to authenticated
  using (
    bucket_id is distinct from 'hui-documents'
    or (select portal_private.is_portal_authorized())
  )
  with check (
    bucket_id is distinct from 'hui-documents'
    or (select portal_private.is_portal_authorized())
  );
drop policy if exists portal_trustee_guard_storage_delete on storage.objects;
create policy portal_trustee_guard_storage_delete on storage.objects
  as restrictive for delete to authenticated
  using (
    bucket_id is distinct from 'hui-documents'
    or (select portal_private.is_portal_authorized())
  );

notify pgrst, 'reload schema';
commit;
