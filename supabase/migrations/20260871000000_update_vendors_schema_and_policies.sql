-- Migration: 20260871000000_update_vendors_schema_and_policies.sql
-- Description: Enable pgcrypto, recreate the vendors table with updated schema, RLS, and policies.

create extension if not exists pgcrypto;

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  company text,
  contact_name text,
  email text,
  phone text,
  category text,
  payment_terms text not null default 'net_30',
  tax_id text,
  status text not null default 'active',
  rating numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendors_org_id_idx on public.vendors(org_id);
create index if not exists vendors_org_name_idx on public.vendors(org_id, name);

alter table public.vendors enable row level security;

grant select, insert, update, delete on public.vendors to authenticated;

drop policy if exists vendors_select on public.vendors;
create policy vendors_select
  on public.vendors
  for select
  to authenticated
  using (
    public.is_super_admin()
    or org_id in (select public.get_my_org_ids())
  );

drop policy if exists vendors_insert on public.vendors;
create policy vendors_insert
  on public.vendors
  for insert
  to authenticated
  with check (public.is_super_admin() or public.is_org_admin(org_id));

drop policy if exists vendors_update on public.vendors;
create policy vendors_update
  on public.vendors
  for update
  to authenticated
  using (public.is_super_admin() or public.is_org_admin(org_id))
  with check (public.is_super_admin() or public.is_org_admin(org_id));

drop policy if exists vendors_delete on public.vendors;
create policy vendors_delete
  on public.vendors
  for delete
  to authenticated
  using (public.is_super_admin() or public.is_org_admin(org_id));

notify pgrst, 'reload schema';
