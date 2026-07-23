-- Migration: 20260873000000_update_leases_schema_and_policies.sql
-- Description: Enable pgcrypto, recreate the leases table with updated schema, RLS, and policies.

create extension if not exists pgcrypto;

create table if not exists public.leases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete set null,
  tenant_name text,
  start_date date,
  end_date date,
  monthly_rent numeric default 0,
  annual_rent numeric,
  rent_per_sf numeric,
  square_footage numeric default 0,
  lease_term_months integer,
  security_deposit numeric,
  cam_amount numeric,
  nnn_amount numeric,
  escalation_rate numeric,
  renewal_options text,
  ti_allowance numeric,
  free_rent_months integer,
  status text not null default 'active',
  lease_type text,
  notes text,
  escalation_type text,
  escalation_timing text,
  renewal_type text,
  renewal_notice_months integer,
  cam_applicable boolean,
  cam_cap numeric,
  cam_cap_type text,
  cam_cap_rate numeric,
  admin_fee_pct numeric,
  management_fee_pct numeric,
  management_fee_basis text,
  gross_up_clause boolean,
  allocation_method text,
  weight_factor numeric,
  base_year_amount numeric,
  expense_stop_amount numeric,
  hvac_responsibility text,
  sales_reporting_frequency text,
  lease_date date,
  property_name text,
  property_address text,
  landlord_address text,
  tenant_contact_name text,
  tenant_address text,
  suite_number text,
  rentable_area_sqft numeric,
  permitted_use text,
  broker_name text,
  lease_term text,
  commencement_date date,
  expiration_date date,
  renewal_notice_days integer,
  renewal_escalation_percent numeric,
  holdover_rent_multiplier numeric,
  base_rent_monthly numeric,
  rent_due_day integer,
  rent_frequency text,
  rent_payment_timing text,
  late_fee_grace_days integer,
  late_fee_percent numeric,
  default_interest_rate_formula text,
  building_rsf numeric,
  tenant_rsf numeric,
  tenant_pro_rata_share numeric,
  floor_plan_reference text,
  parking_rights text,
  common_area_description text,
  extraction_data jsonb,
  confidence_score numeric,
  low_confidence_fields text[] default array[]::text[],
  extracted_fields jsonb,
  signed_by text,
  signed_at timestamptz,
  approval_comments text,
  approval_document_url text,
  abstract_status text,
  abstract_version integer,
  abstract_approved_at timestamptz,
  abstract_approved_by text,
  abstract_snapshot jsonb,
  rent_commencement_date date,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leases_org_id_idx on public.leases(org_id);
create index if not exists leases_property_id_idx on public.leases(property_id);
create index if not exists leases_tenant_id_idx on public.leases(tenant_id);
create index if not exists leases_unit_id_idx on public.leases(unit_id);

alter table public.leases enable row level security;

grant select, insert, update, delete on public.leases to authenticated;

drop policy if exists leases_select on public.leases;
create policy leases_select
  on public.leases
  for select
  to authenticated
  using (
    public.is_super_admin()
    or org_id in (select public.get_my_org_ids())
  );

drop policy if exists leases_insert on public.leases;
create policy leases_insert
  on public.leases
  for insert
  to authenticated
  with check (public.is_super_admin() or public.is_org_admin(org_id));

drop policy if exists leases_update on public.leases;
create policy leases_update
  on public.leases
  for update
  to authenticated
  using (public.is_super_admin() or public.is_org_admin(org_id))
  with check (public.is_super_admin() or public.is_org_admin(org_id));

drop policy if exists leases_delete on public.leases;
create policy leases_delete
  on public.leases
  for delete
  to authenticated
  using (public.is_super_admin() or public.is_org_admin(org_id));

notify pgrst, 'reload schema';
