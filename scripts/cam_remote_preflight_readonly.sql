-- ===========================================================================
-- CAM canonical-category deployment — PREFLIGHT (READ-ONLY)
--
-- Run BEFORE migrations 037-040. Safe to run in the Supabase SQL Editor.
--
-- CONTAINS NO CREDENTIALS. PERFORMS NO WRITES.
--   * Every statement is a SELECT.
--   * No INSERT / UPDATE / DELETE / ALTER / DROP / CREATE anywhere.
--   * No function in here mutates state.
--   * Requires only read access to the `public` schema and its catalogs.
--     No elevated privileges are needed. (If a section returns zero rows
--     because RLS hides them, re-run as a role that can read the tables —
--     see the note on section 3.)
--
-- Save the entire output to the deployment ticket.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Migration state — are 037-040 already applied?
-- ---------------------------------------------------------------------------
select
  '1. migration_ledger' as section,
  v.version,
  case when m.version is null then 'PENDING' else 'APPLIED' end as state
from (values
  ('20269900000037'), ('20269900000038'), ('20269900000039'), ('20269900000040')
) as v(version)
left join supabase_migrations.schema_migrations m on m.version = v.version
order by v.version;

-- ---------------------------------------------------------------------------
-- 2. cam_profiles — existence and row count.
--    STOP CONDITION: migration 038 drops this table and deliberately ABORTS
--    if it has any rows. A non-zero count here means the whole push fails.
-- ---------------------------------------------------------------------------
-- Note: the row count is obtained through query_to_xml() rather than a direct
-- `select count(*) from public.cam_profiles`. PostgreSQL resolves table names
-- at PARSE time, so a direct reference fails outright when the table has
-- already been dropped — even inside a CASE or EXISTS guard. query_to_xml
-- evaluates the inner statement dynamically and is strictly read-only.
with existence as (
  select to_regclass('public.cam_profiles') is not null as table_exists
),
counted as (
  select
    e.table_exists,
    case when e.table_exists then
      (xpath('/row/cnt/text()',
             query_to_xml('select count(*) as cnt from public.cam_profiles', false, true, '')
      ))[1]::text::bigint
    else 0::bigint end as row_count
  from existence e
)
select
  '2. cam_profiles' as section,
  c.table_exists,
  c.row_count,
  case
    when not c.table_exists then 'OK - already absent'
    when c.row_count = 0    then 'OK - present but empty, 038 will drop it'
    else 'STOP - table has rows; 038 will abort the push'
  end as verdict
from counted c;

-- ---------------------------------------------------------------------------
-- 3. Does the canonical column already exist?
--    (Determines whether sections 5-7 can report anything meaningful.)
-- ---------------------------------------------------------------------------
select
  '3. canonical_column' as section,
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cam_expense_inputs'
       and column_name = 'expense_category_id'
  ) as expense_category_id_exists;

-- ---------------------------------------------------------------------------
-- 4. CAM input rows and amounts by organization and property.
--    This is the financial baseline. Record it verbatim.
-- ---------------------------------------------------------------------------
select
  '4. inputs_by_org_property' as section,
  ei.org_id,
  o.name as org_name,
  ei.property_id,
  p.name as property_name,
  ei.publication_status,
  count(*) as row_count,
  round(sum(coalesce(ei.amount, 0)), 2) as total_amount,
  round(sum(case when coalesce(ei.amount, 0) = 0 then 0 else coalesce(ei.amount, 0) end), 2) as nonzero_amount,
  count(*) filter (where coalesce(ei.amount, 0) = 0) as zero_amount_rows
from public.cam_expense_inputs ei
left join public.organizations o on o.id = ei.org_id
left join public.properties p on p.id = ei.property_id
group by ei.org_id, o.name, ei.property_id, p.name, ei.publication_status
order by o.name nulls first, p.name nulls first, ei.publication_status;

-- ---------------------------------------------------------------------------
-- 5. Overall totals (single-row summary of section 4).
-- ---------------------------------------------------------------------------
select
  '5. totals' as section,
  count(*) as all_rows,
  count(*) filter (where publication_status = 'published') as published_rows,
  round(sum(coalesce(amount, 0)) filter (where publication_status = 'published'), 2) as published_amount,
  count(distinct org_id) as organizations,
  count(distinct property_id) as properties
from public.cam_expense_inputs;

-- ---------------------------------------------------------------------------
-- 6. Canonical category coverage.
--    Before 039 is applied the column does not exist, so this reports 'n/a'
--    rather than failing. After 039 it is the key coverage number.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cam_expense_inputs'
       and column_name = 'expense_category_id'
  ) then
    raise notice 'Section 6: expense_category_id exists — run the query below.';
  else
    raise notice 'Section 6: expense_category_id does NOT exist yet (pre-039). Coverage is 0%% by definition.';
  end if;
end $$;

-- Run this only when section 3 reported true:
-- select
--   '6. canonical_coverage' as section,
--   org_id, property_id,
--   count(*) filter (where expense_category_id is not null) as with_canonical,
--   count(*) filter (where expense_category_id is null)     as without_canonical,
--   round(sum(coalesce(amount,0)) filter (where expense_category_id is null), 2) as unresolved_amount
-- from public.cam_expense_inputs
-- where publication_status = 'published'
-- group by org_id, property_id
-- order by unresolved_amount desc nulls last;

-- ---------------------------------------------------------------------------
-- 7. Missing / invalid service periods on published inputs.
--    A published input with no service period cannot be prorated and blocks
--    calculation (EXPENSE_SERVICE_PERIOD_MISSING).
-- ---------------------------------------------------------------------------
select
  '7. service_periods' as section,
  org_id,
  property_id,
  count(*) filter (where service_period_start is null or service_period_end is null) as missing_service_period,
  count(*) filter (where service_period_start is not null and service_period_end is not null
                     and service_period_end < service_period_start) as inverted_service_period,
  count(*) filter (where fiscal_year is null
                     and (service_period_start is null or service_period_end is null)) as no_period_identity_at_all,
  round(sum(coalesce(amount, 0)) filter (where service_period_start is null or service_period_end is null), 2) as amount_missing_period
from public.cam_expense_inputs
where publication_status = 'published'
group by org_id, property_id
having count(*) filter (where service_period_start is null or service_period_end is null) > 0
    or count(*) filter (where service_period_start is not null and service_period_end is not null
                          and service_period_end < service_period_start) > 0
order by amount_missing_period desc nulls last;

-- ---------------------------------------------------------------------------
-- 8. Category labels: ambiguous vs unique vs unknown, computed WITHOUT the
--    039 helper functions (so this works pre-deployment).
--
--    A label is:
--      UNIQUE    -> matches exactly one active category (auto-resolvable)
--      AMBIGUOUS -> matches more than one (needs an explicit human decision)
--      UNKNOWN   -> matches none
--      MISSING   -> the label itself is null/blank
--
--    Match rules mirror resolve_expense_category_id(): exact, case-insensitive,
--    trimmed, against category_name / normalized_key / subcategory_name, with
--    organization-owned categories taking precedence over system defaults.
-- ---------------------------------------------------------------------------
with published as (
  select ei.id, ei.org_id, ei.property_id, ei.amount,
         nullif(btrim(coalesce(ei.category, '')), '') as label
    from public.cam_expense_inputs ei
   where ei.publication_status = 'published'
),
matched as (
  select p.id, p.org_id, p.property_id, p.amount, p.label,
         (select count(*) from public.expense_categories c
           where c.is_active is not false
             and c.org_id = p.org_id
             and (lower(btrim(c.category_name))    = lower(p.label)
               or lower(btrim(c.normalized_key))   = lower(p.label)
               or lower(btrim(c.subcategory_name)) = lower(p.label))) as org_matches,
         (select count(*) from public.expense_categories c
           where c.is_active is not false
             and c.org_id is null
             and (lower(btrim(c.category_name))    = lower(p.label)
               or lower(btrim(c.normalized_key))   = lower(p.label)
               or lower(btrim(c.subcategory_name)) = lower(p.label))) as system_matches
    from published p
),
classified as (
  select m.*,
         case
           when m.label is null then 'MISSING'
           when m.org_matches = 1 then 'UNIQUE'
           when m.org_matches > 1 then 'AMBIGUOUS'
           when m.system_matches = 1 then 'UNIQUE'
           when m.system_matches > 1 then 'AMBIGUOUS'
           else 'UNKNOWN'
         end as label_state
    from matched m
)
select
  '8. label_resolution' as section,
  org_id,
  property_id,
  label_state,
  count(*) as row_count,
  round(sum(coalesce(amount, 0)), 2) as total_amount
from classified
group by org_id, property_id, label_state
order by org_id, property_id,
         case label_state when 'AMBIGUOUS' then 1 when 'UNKNOWN' then 2 when 'MISSING' then 3 else 4 end;

-- ---------------------------------------------------------------------------
-- 9. The specific ambiguous / unknown labels, so they can be triaged by name.
-- ---------------------------------------------------------------------------
with published as (
  select ei.org_id, ei.amount,
         nullif(btrim(coalesce(ei.category, '')), '') as label
    from public.cam_expense_inputs ei
   where ei.publication_status = 'published'
)
select
  '9. labels_needing_decisions' as section,
  p.org_id,
  p.label,
  count(*) as row_count,
  round(sum(coalesce(p.amount, 0)), 2) as total_amount,
  (select count(*) from public.expense_categories c
    where c.is_active is not false
      and (c.org_id = p.org_id or c.org_id is null)
      and (lower(btrim(c.category_name))    = lower(p.label)
        or lower(btrim(c.normalized_key))   = lower(p.label)
        or lower(btrim(c.subcategory_name)) = lower(p.label))) as candidate_count
from published p
where p.label is not null
group by p.org_id, p.label
having (select count(*) from public.expense_categories c
         where c.is_active is not false
           and (c.org_id = p.org_id or c.org_id is null)
           and (lower(btrim(c.category_name))    = lower(p.label)
             or lower(btrim(c.normalized_key))   = lower(p.label)
             or lower(btrim(c.subcategory_name)) = lower(p.label))) <> 1
order by total_amount desc
limit 200;

-- ---------------------------------------------------------------------------
-- 10. CAM runs that will be affected, by status.
--     Approved/posted runs are IMMUTABLE — any of these appearing here means a
--     restatement must be planned, not an in-place correction.
-- ---------------------------------------------------------------------------
select
  '10. affected_runs' as section,
  r.org_id,
  r.status,
  count(*) as run_count,
  min(r.created_at) as oldest,
  max(r.created_at) as newest
from public.cam_runs r
group by r.org_id, r.status
order by r.org_id,
         case r.status when 'posted' then 1 when 'approved' then 2 else 3 end;

-- ---------------------------------------------------------------------------
-- 11. Runs whose period contains an input that currently has no canonical
--     category (post-039 only). These are the runs remediation will disturb.
--     Reported for planning; nothing is written.
-- ---------------------------------------------------------------------------
-- Run this only when section 3 reported true:
-- select
--   '11. runs_touching_unresolved_inputs' as section,
--   r.id as cam_run_id, r.org_id, r.status, r.recovery_period_id,
--   count(distinct ei.id) as unresolved_inputs
-- from public.cam_runs r
-- join public.recovery_pools rp on rp.period_id = r.recovery_period_id
-- join public.cam_input_pool_assignments a on a.recovery_pool_id = rp.id
-- join public.cam_expense_inputs ei on ei.id = a.cam_expense_input_id
-- where ei.expense_category_id is null
--   and ei.publication_status = 'published'
--   and coalesce(ei.amount, 0) <> 0
-- group by r.id, r.org_id, r.status, r.recovery_period_id
-- order by case r.status when 'posted' then 1 when 'approved' then 2 else 3 end, unresolved_inputs desc;
