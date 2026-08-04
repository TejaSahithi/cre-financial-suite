-- Migration: 20260874000000_update_expenses_and_audit_logs.sql
-- Description: Alter memberships, recreate expenses and audit_logs tables with updated schema, RLS, policies, and define permission and expense workflow functions.

create extension if not exists pgcrypto;

alter table public.memberships
  add column if not exists page_permissions jsonb not null default '{}'::jsonb;

create or replace function public.can_write_page(check_org_id uuid, page_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = auth.uid()
      and coalesce(m.status, 'active') in ('active', 'owner')
      and (m.role = 'super_admin' or m.org_id = check_org_id)
      and (
        m.role in ('super_admin', 'org_admin', 'owner')
        or lower(coalesce(m.page_permissions ->> page_name, 'none'))
          in ('write', 'edit', 'full', 'admin')
      )
  );
$$;

create or replace function public.can_write_any_page(check_org_id uuid, page_names text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from unnest(coalesce(page_names, array[]::text[])) as requested_page(page_name)
    where public.can_write_page(check_org_id, requested_page.page_name)
  );
$$;

grant execute on function public.can_write_page(uuid, text) to authenticated;
grant execute on function public.can_write_any_page(uuid, text[]) to authenticated;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  lease_id uuid references public.leases(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete set null,
  tenant_name text,
  category text not null,
  expense_subcategory text,
  amount numeric not null default 0,
  classification text,
  vendor text not null,
  vendor_name text,
  vendor_id uuid references public.vendors(id) on delete set null,
  gl_code text,
  fiscal_year integer,
  month integer,
  date date not null,
  expense_date date,
  billing_period_start date,
  billing_period_end date,
  service_period_start date,
  service_period_end date,
  source text not null default 'manual',
  source_type text,
  description text,
  invoice_number text,
  attachment_url text,
  approval_status text not null default 'approved',
  review_status text,
  recovery_status text,
  recoverability_result text,
  recovery_reason text,
  recovery_method text,
  rule_source text,
  cam_eligible boolean,
  confidence_score numeric,
  evidence_text text,
  evidence_page_number integer,
  notes text,
  is_controllable boolean not null default true,
  created_by text,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  entity_type text not null,
  entity_id text,
  action text not null,
  actor_user_id uuid,
  actor_email text,
  target_user_id uuid,
  severity text not null default 'info',
  source text not null default 'frontend',
  before jsonb,
  after jsonb,
  metadata jsonb,
  "timestamp" timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists expenses_org_id_idx on public.expenses(org_id);
create index if not exists expenses_property_id_idx on public.expenses(property_id);
create index if not exists expenses_date_idx on public.expenses(date);
create index if not exists audit_logs_org_id_idx on public.audit_logs(org_id);

alter table public.expenses enable row level security;
alter table public.audit_logs enable row level security;

grant select on public.expenses, public.audit_logs to authenticated;

drop policy if exists expenses_select on public.expenses;
create policy expenses_select
  on public.expenses
  for select
  to authenticated
  using (public.is_super_admin() or org_id in (select unnest(public.get_my_org_ids())));

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select
  on public.audit_logs
  for select
  to authenticated
  using (
    public.is_super_admin()
    or org_id is null
    or org_id in (select unnest(public.get_my_org_ids()))
  );

drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs
  for insert to authenticated
  with check (
    public.is_super_admin()
    or org_id in (select unnest(public.get_my_org_ids()))
  );

create or replace function public.create_expense_workflow(
  p_org_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_expense jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expense public.expenses%rowtype;
  v_audit_log_id uuid;
  v_property_id uuid;
  v_key text;
  v_allowed_keys text[] := array[
    'date', 'amount', 'category', 'vendor', 'vendor_id', 'description', 'classification',
    'portfolio_id', 'property_id', 'building_id', 'unit_id', 'attachment_url',
    'lease_id', 'tenant_id', 'source', 'fiscal_year', 'approval_status', 'review_status',
    'service_period_start', 'service_period_end'
  ];
begin
  if p_org_id is null or p_actor_user_id is null then
    raise exception 'organization and actor are required';
  end if;
  if jsonb_typeof(coalesce(p_expense, 'null'::jsonb)) is distinct from 'object' then
    raise exception 'expense must be an object';
  end if;

  for v_key in select jsonb_object_keys(p_expense) loop
    if not (v_key = any(v_allowed_keys)) then
      raise exception 'field % is not permitted', v_key;
    end if;
  end loop;

  if nullif(trim(coalesce(p_expense ->> 'date', '')), '') is null then
    raise exception 'date is required';
  end if;
  if p_expense ->> 'amount' is null then
    raise exception 'amount is required';
  end if;
  if nullif(trim(coalesce(p_expense ->> 'category', '')), '') is null then
    raise exception 'category is required';
  end if;
  if nullif(trim(coalesce(p_expense ->> 'vendor', '')), '') is null then
    raise exception 'vendor is required';
  end if;

  v_property_id := nullif(p_expense ->> 'property_id', '')::uuid;
  if v_property_id is null or not exists (
    select 1 from public.properties p where p.id = v_property_id and p.org_id = p_org_id
  ) then
    raise exception 'Property not found for this organization';
  end if;

  insert into public.expenses (
    org_id, property_id, category, amount, classification, vendor, vendor_id,
    fiscal_year, date, source, description, portfolio_id, building_id, unit_id,
    lease_id, tenant_id, attachment_url, approval_status, review_status,
    service_period_start, service_period_end
  ) values (
    p_org_id,
    v_property_id,
    p_expense ->> 'category',
    (p_expense ->> 'amount')::numeric,
    nullif(p_expense ->> 'classification', ''),
    p_expense ->> 'vendor',
    nullif(p_expense ->> 'vendor_id', '')::uuid,
    nullif(p_expense ->> 'fiscal_year', '')::integer,
    (p_expense ->> 'date')::date,
    coalesce(nullif(p_expense ->> 'source', ''), 'manual'),
    nullif(p_expense ->> 'description', ''),
    nullif(p_expense ->> 'portfolio_id', '')::uuid,
    nullif(p_expense ->> 'building_id', '')::uuid,
    nullif(p_expense ->> 'unit_id', '')::uuid,
    nullif(p_expense ->> 'lease_id', '')::uuid,
    nullif(p_expense ->> 'tenant_id', '')::uuid,
    nullif(p_expense ->> 'attachment_url', ''),
    coalesce(nullif(p_expense ->> 'approval_status', ''), 'approved'),
    nullif(p_expense ->> 'review_status', ''),
    nullif(p_expense ->> 'service_period_start', '')::date,
    nullif(p_expense ->> 'service_period_end', '')::date
  )
  returning * into v_expense;

  insert into public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, after, metadata
  ) values (
    p_org_id, v_expense.property_id, 'Expense', v_expense.id::text, 'expense_created',
    p_actor_user_id, p_actor_email, 'info', 'edge_function', to_jsonb(v_expense),
    jsonb_build_object('source', v_expense.source)
  )
  returning id into v_audit_log_id;

  return jsonb_build_object(
    'expense', to_jsonb(v_expense),
    'audit_log_id', v_audit_log_id
  );
end;
$$;

revoke all on function public.create_expense_workflow(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_expense_workflow(uuid, uuid, text, jsonb)
  to service_role;

notify pgrst, 'reload schema';
