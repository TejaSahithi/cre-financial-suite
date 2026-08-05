-- ===========================================================================
-- CAM canonical-category deployment — REMEDIATION DRY RUN (READ-ONLY)
--
-- Run AFTER migration 039 is applied, BEFORE any apply-mode remediation.
-- Safe to run in the Supabase SQL Editor.
--
-- CONTAINS NO CREDENTIALS. PERFORMS NO WRITES.
--   * Every statement is a SELECT.
--   * The only function called, public.remediate_cam_input_category_ids(...),
--     is invoked with p_dry_run := true, which reports and returns without
--     issuing any UPDATE. (Section 5 is commented out precisely because
--     calling it with p_dry_run := false WOULD write.)
--   * PRIVILEGE NOTE: remediate_cam_input_category_ids is granted to
--     service_role only. In the Supabase SQL Editor you are normally
--     postgres/owner, which satisfies this. A plain `authenticated` role
--     cannot execute it. Sections 1-4 need only read access and work for any
--     role that can read the tables.
--
-- Buckets reported:
--   ALREADY_CANONICAL   expense_category_id is already set
--   AUTO_RESOLVABLE     label resolves to exactly one active category
--   AMBIGUOUS           label matches more than one -> human decision required
--   UNKNOWN             label matches no category
--   MISSING             no label at all
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Guard: this script requires migration 039.
-- ---------------------------------------------------------------------------
select
  '0. prerequisite' as section,
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cam_expense_inputs'
       and column_name = 'expense_category_id'
  ) as migration_039_applied,
  exists (
    select 1 from pg_proc where proname = 'resolve_expense_category_id'
  ) as resolver_present;

-- ---------------------------------------------------------------------------
-- 1. Bucket classification with counts and monetary totals, per organization
--    and property. This is the number the approval gate reviews.
-- ---------------------------------------------------------------------------
with published as (
  select ei.id, ei.org_id, ei.property_id, ei.amount, ei.expense_category_id,
         nullif(btrim(coalesce(ei.category, '')), '') as label
    from public.cam_expense_inputs ei
   where ei.publication_status = 'published'
),
classified as (
  select p.*,
         case
           when p.expense_category_id is not null then 'ALREADY_CANONICAL'
           when p.label is null then 'MISSING'
           when (public.resolve_expense_category_id(p.org_id, p.label) ->> 'expense_category_id') is not null
             then 'AUTO_RESOLVABLE'
           when (public.resolve_expense_category_id(p.org_id, p.label) ->> 'unresolved_reason') = 'CATEGORY_AMBIGUOUS'
             then 'AMBIGUOUS'
           else 'UNKNOWN'
         end as bucket
    from published p
)
select
  '1. buckets' as section,
  c.org_id,
  o.name as org_name,
  c.property_id,
  pr.name as property_name,
  c.bucket,
  count(*) as row_count,
  round(sum(coalesce(c.amount, 0)), 2) as total_amount
from classified c
left join public.organizations o on o.id = c.org_id
left join public.properties pr on pr.id = c.property_id
group by c.org_id, o.name, c.property_id, pr.name, c.bucket
order by o.name nulls first, pr.name nulls first,
         case c.bucket
           when 'AMBIGUOUS' then 1 when 'UNKNOWN' then 2 when 'MISSING' then 3
           when 'AUTO_RESOLVABLE' then 4 else 5 end;

-- ---------------------------------------------------------------------------
-- 2. Single-row grand total across every organization.
-- ---------------------------------------------------------------------------
with published as (
  select ei.org_id, ei.amount, ei.expense_category_id,
         nullif(btrim(coalesce(ei.category, '')), '') as label
    from public.cam_expense_inputs ei
   where ei.publication_status = 'published'
),
classified as (
  select p.*,
         case
           when p.expense_category_id is not null then 'ALREADY_CANONICAL'
           when p.label is null then 'MISSING'
           when (public.resolve_expense_category_id(p.org_id, p.label) ->> 'expense_category_id') is not null
             then 'AUTO_RESOLVABLE'
           when (public.resolve_expense_category_id(p.org_id, p.label) ->> 'unresolved_reason') = 'CATEGORY_AMBIGUOUS'
             then 'AMBIGUOUS'
           else 'UNKNOWN'
         end as bucket
    from published p
)
select
  '2. grand_total' as section,
  bucket,
  count(*) as row_count,
  round(sum(coalesce(amount, 0)), 2) as total_amount,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_rows
from classified
group by bucket
order by case bucket
           when 'AMBIGUOUS' then 1 when 'UNKNOWN' then 2 when 'MISSING' then 3
           when 'AUTO_RESOLVABLE' then 4 else 5 end;

-- ---------------------------------------------------------------------------
-- 3. Row-level detail for everything that will NOT resolve automatically.
--    These are the rows requiring an explicit human decision in section 7b of
--    the runbook. Capped at 500 rows.
-- ---------------------------------------------------------------------------
select
  '3. needs_human_decision' as section,
  ei.id as cam_expense_input_id,
  ei.org_id,
  ei.property_id,
  ei.category as label,
  round(coalesce(ei.amount, 0), 2) as amount,
  ei.service_period_start,
  ei.service_period_end,
  public.resolve_expense_category_id(ei.org_id, ei.category) ->> 'unresolved_reason' as unresolved_reason,
  coalesce(array_length(public.list_expense_category_candidates(ei.org_id, ei.category), 1), 0) as candidate_count
from public.cam_expense_inputs ei
where ei.publication_status = 'published'
  and ei.expense_category_id is null
  and coalesce(ei.amount, 0) <> 0
  and (public.resolve_expense_category_id(ei.org_id, ei.category) ->> 'expense_category_id') is null
order by coalesce(ei.amount, 0) desc
limit 500;

-- ---------------------------------------------------------------------------
-- 4. Canonical dry-run report straight from the shipped RPC, per organization.
--    p_dry_run := true -> reports only, writes nothing.
--    Returns: counts {inspected, resolvable, unresolved, applied} plus a row
--    array carrying old_label, proposed_value, method, confidence and
--    unresolved_reason for every inspected row.
-- ---------------------------------------------------------------------------
select
  '4. rpc_dry_run' as section,
  o.id as org_id,
  o.name as org_name,
  public.remediate_cam_input_category_ids(p_org_id := o.id, p_dry_run := true) as report
from public.organizations o
where exists (
  select 1 from public.cam_expense_inputs ei
   where ei.org_id = o.id and ei.expense_category_id is null
)
order by o.name;

-- ---------------------------------------------------------------------------
-- 5. APPLY MODE — DELIBERATELY COMMENTED OUT.
--
--    The statement below WRITES. It is not part of this read-only script and
--    must only be run after the human approval gate in the runbook (section 6),
--    with an authorized database administrator present.
--
--    Requires service_role (or owner) privileges.
-- ---------------------------------------------------------------------------
-- select public.remediate_cam_input_category_ids(
--          p_org_id := '<ORG_UUID>',
--          p_dry_run := false,
--          p_property_id := null   -- optional narrowing
--        );
