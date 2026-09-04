-- =============================================================================
-- Hui Management System — Initial Schema
-- Pehiāweri B1B Ahu Whenua Trust
--
-- Apply this file manually via the Supabase SQL Editor:
--   1. Open your Supabase project → SQL Editor → New query
--   2. Paste the entire contents of this file
--   3. Click "Run"
--
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS where possible.
-- =============================================================================

-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- hui table
create table if not exists hui (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  scheduled_at timestamptz not null,
  location text,
  zoom_link text,
  zoom_passcode text,
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- documents table
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  hui_id uuid references hui(id) on delete cascade,
  name text not null,
  url text not null,
  type text not null check (type in ('agenda', 'document')),
  created_at timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

create index if not exists hui_scheduled_at_idx on hui (scheduled_at);
create index if not exists hui_status_idx on hui (status);
create index if not exists documents_hui_id_idx on documents (hui_id);

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists hui_set_updated_at on hui;
create trigger hui_set_updated_at
  before update on hui
  for each row
  execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table hui enable row level security;
alter table documents enable row level security;

-- Public read: anyone (anon) can read published hui.
drop policy if exists "Public can read published hui" on hui;
create policy "Public can read published hui"
  on hui
  for select
  to anon, authenticated
  using (status = 'published');

-- Public read: documents belonging to a published hui.
drop policy if exists "Public can read documents of published hui" on documents;
create policy "Public can read documents of published hui"
  on documents
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from hui
      where hui.id = documents.hui_id
        and hui.status = 'published'
    )
  );

-- Authenticated full access on hui (admin).
drop policy if exists "Authenticated can read all hui" on hui;
create policy "Authenticated can read all hui"
  on hui
  for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can insert hui" on hui;
create policy "Authenticated can insert hui"
  on hui
  for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update hui" on hui;
create policy "Authenticated can update hui"
  on hui
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated can delete hui" on hui;
create policy "Authenticated can delete hui"
  on hui
  for delete
  to authenticated
  using (true);

-- Authenticated full access on documents (admin).
drop policy if exists "Authenticated can read all documents" on documents;
create policy "Authenticated can read all documents"
  on documents
  for select
  to authenticated
  using (true);

drop policy if exists "Authenticated can insert documents" on documents;
create policy "Authenticated can insert documents"
  on documents
  for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated can update documents" on documents;
create policy "Authenticated can update documents"
  on documents
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated can delete documents" on documents;
create policy "Authenticated can delete documents"
  on documents
  for delete
  to authenticated
  using (true);

-- NOTE: The Cloudflare Worker uses the SERVICE ROLE key, which bypasses RLS.
-- These policies protect direct anon/authenticated access (e.g. the browser
-- reading published hui directly, or the admin uploading files to Storage).

-- -----------------------------------------------------------------------------
-- Storage bucket for agendas & documents
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('hui-documents', 'hui-documents', true)
on conflict (id) do nothing;

-- Public can read files in the bucket.
drop policy if exists "Public can read hui documents" on storage.objects;
create policy "Public can read hui documents"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'hui-documents');

-- Authenticated (admin) can upload / update / delete files.
drop policy if exists "Authenticated can upload hui documents" on storage.objects;
create policy "Authenticated can upload hui documents"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'hui-documents');

drop policy if exists "Authenticated can update hui documents" on storage.objects;
create policy "Authenticated can update hui documents"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'hui-documents')
  with check (bucket_id = 'hui-documents');

drop policy if exists "Authenticated can delete hui documents" on storage.objects;
create policy "Authenticated can delete hui documents"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'hui-documents');
