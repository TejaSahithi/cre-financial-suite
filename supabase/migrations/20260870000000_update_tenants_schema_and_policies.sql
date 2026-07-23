-- Migration: 20260870000000_update_tenants_schema_and_policies.sql
-- Description: Enable pgcrypto, recreate the tenants table with updated schema, RLS, and policies.

create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  company text,
  contact_name text,
  email text,
  phone text,
  industry text,
  credit_rating text,
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenants_org_id_idx on public.tenants(org_id);
create index if not exists tenants_org_name_idx on public.tenants(org_id, name);

alter table public.tenants enable row level security;

grant select, insert, update, delete on public.tenants to authenticated;

drop policy if exists tenants_select on public.tenants;
create policy tenants_select
  on public.tenants
  for select
  to authenticated
  using (
    public.is_super_admin()
    or org_id in (select public.get_my_org_ids())
  );

drop policy if exists tenants_insert on public.tenants;
create policy tenants_insert
  on public.tenants
  for insert
  to authenticated
  with check (public.is_super_admin() or public.is_org_admin(org_id));

drop policy if exists tenants_update on public.tenants;
create policy tenants_update
  on public.tenants
  for update
  to authenticated
  using (public.is_super_admin() or public.is_org_admin(org_id))
  with check (public.is_super_admin() or public.is_org_admin(org_id));

drop policy if exists tenants_delete on public.tenants;
create policy tenants_delete
  on public.tenants
  for delete
  to authenticated
  using (public.is_super_admin() or public.is_org_admin(org_id));

notify pgrst, 'reload schema';
