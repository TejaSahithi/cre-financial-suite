-- Migration: 20260869000000_update_units_schema_and_policies.sql
-- Description: Enable pgcrypto, recreate the units table with updated schema, RLS, and policies.

create extension if not exists pgcrypto;

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  building_id uuid not null references public.buildings(id) on delete cascade,
  unit_id_code text,
  unit_number text not null,
  bedroom_bathroom text,
  floor integer,
  square_footage numeric default 0,
  unit_type text,
  occupancy_status text not null default 'vacant',
  status text not null default 'vacant',
  tenant_id uuid,
  lease_id uuid,
  monthly_rent numeric default 0,
  lease_start date,
  lease_end date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.units enable row level security;

grant select, insert, update, delete on public.units to authenticated;

drop policy if exists units_select on public.units;
create policy units_select on public.units
  for select to authenticated
  using (
    public.is_super_admin()
    or org_id in (select unnest(public.get_my_org_ids()))
  );

drop policy if exists units_insert on public.units;
create policy units_insert on public.units
  for insert to authenticated
  with check (
    public.is_org_admin(org_id)
    and exists (
      select 1
      from public.buildings b
      where b.id = units.building_id
        and b.property_id = units.property_id
        and b.org_id = units.org_id
    )
  );

drop policy if exists units_update on public.units;
create policy units_update on public.units
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (
    public.is_org_admin(org_id)
    and exists (
      select 1
      from public.buildings b
      where b.id = units.building_id
        and b.property_id = units.property_id
        and b.org_id = units.org_id
    )
  );

drop policy if exists units_delete on public.units;
create policy units_delete on public.units
  for delete to authenticated
  using (public.is_org_admin(org_id));

create index if not exists idx_units_org on public.units(org_id);
create index if not exists idx_units_property on public.units(property_id);
create index if not exists idx_units_building on public.units(building_id);

notify pgrst, 'reload schema';
