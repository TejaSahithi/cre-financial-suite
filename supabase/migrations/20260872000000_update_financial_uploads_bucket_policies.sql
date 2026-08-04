-- Migration: 20260872000000_update_financial_uploads_bucket_policies.sql
-- Description: Configure the financial-uploads storage bucket and drop/recreate storage object policies with organization gating.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'financial-uploads',
  'financial-uploads',
  false,
  52428800,
  array[
    'text/csv',
    'text/plain',
    'text/tab-separated-values',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/tiff',
    'image/webp',
    'image/gif',
    'image/bmp'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload files to their org folder" on storage.objects;
drop policy if exists "Users can read files from their org folder" on storage.objects;
drop policy if exists "Users can update files in their org folder" on storage.objects;
drop policy if exists "Users can delete files from their org folder" on storage.objects;
drop policy if exists "Authenticated users can upload files" on storage.objects;
drop policy if exists "Authenticated users can read files" on storage.objects;
drop policy if exists "Authenticated users can update files" on storage.objects;
drop policy if exists "Authenticated users can delete files" on storage.objects;
drop policy if exists financial_uploads_insert on storage.objects;
drop policy if exists financial_uploads_select on storage.objects;
drop policy if exists financial_uploads_update on storage.objects;
drop policy if exists financial_uploads_delete on storage.objects;

create policy financial_uploads_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'financial-uploads'
    and (
      public.is_super_admin()
      or (storage.foldername(name))[1] in (select unnest(public.get_my_org_ids())::text)
    )
  );

create policy financial_uploads_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'financial-uploads'
    and (
      public.is_super_admin()
      or (storage.foldername(name))[1] in (select unnest(public.get_my_org_ids())::text)
    )
  );

create policy financial_uploads_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'financial-uploads'
    and (
      public.is_super_admin()
      or (storage.foldername(name))[1] in (select unnest(public.get_my_org_ids())::text)
    )
  )
  with check (
    bucket_id = 'financial-uploads'
    and (
      public.is_super_admin()
      or (storage.foldername(name))[1] in (select unnest(public.get_my_org_ids())::text)
    )
  );

create policy financial_uploads_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'financial-uploads'
    and (
      public.is_super_admin()
      or (storage.foldername(name))[1] in (select unnest(public.get_my_org_ids())::text)
    )
  );
