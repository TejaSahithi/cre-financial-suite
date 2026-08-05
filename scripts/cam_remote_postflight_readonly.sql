-- ===========================================================================
-- CAM canonical-category deployment — POSTFLIGHT VERIFICATION (READ-ONLY)
--
-- Run AFTER migrations 037-040 and after remediation.
-- Safe to run in the Supabase SQL Editor.
--
-- CONTAINS NO CREDENTIALS. PERFORMS NO WRITES.
--   * Every statement is a SELECT against tables or system catalogs.
--   * No INSERT / UPDATE / DELETE / ALTER / DROP / CREATE anywhere.
--   * No elevated privileges required; read access to `public` is enough.
--
-- Every section prints a PASS / FAIL / REVIEW verdict. Attach the full output
-- to the deployment ticket.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Migrations applied.
-- ---------------------------------------------------------------------------
select
  '1. migrations' as section,
  v.version,
  case when m.version is null then 'FAIL - not applied' else 'PASS' end as verdict
from (values
  ('20269900000037'), ('20269900000038'), ('20269900000039'), ('20269900000040')
) as v(version)
left join supabase_migrations.schema_migrations m on m.version = v.version
order by v.version;

-- ---------------------------------------------------------------------------
-- 2. Schema objects created by 039/040 exist.
-- ---------------------------------------------------------------------------
select '2. objects' as section, kind, name,
       case when present then 'PASS' else 'FAIL - missing' end as verdict
from (
  select 'column' as kind, 'cam_expense_inputs.expense_category_id' as name,
         exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='cam_expense_inputs'
                    and column_name='expense_category_id') as present
  union all select 'foreign key', 'expense_category_id -> expense_categories(id)',
         exists (select 1 from pg_constraint
                  where conrelid='public.cam_expense_inputs'::regclass and contype='f'
                    and pg_get_constraintdef(oid) ilike '%expense_categories%')
  union all select 'index', 'idx_cam_expense_inputs_expense_category',
         exists (select 1 from pg_indexes where tablename='cam_expense_inputs'
                  and indexname='idx_cam_expense_inputs_expense_category')
  union all select 'trigger', 'trg_cam_expense_inputs_canonical_category',
         exists (select 1 from pg_trigger
                  where tgrelid='public.cam_expense_inputs'::regclass
                    and tgname='trg_cam_expense_inputs_canonical_category' and not tgisinternal)
  union all select 'function', 'resolve_expense_category_id',
         exists (select 1 from pg_proc where proname='resolve_expense_category_id')
  union all select 'function', 'cam_expense_inputs_set_canonical_category',
         exists (select 1 from pg_proc where proname='cam_expense_inputs_set_canonical_category')
  union all select 'function', 'remediate_cam_input_category_ids',
         exists (select 1 from pg_proc where proname='remediate_cam_input_category_ids')
  union all select 'function', 'list_expense_category_candidates',
         exists (select 1 from pg_proc where proname='list_expense_category_candidates')
  union all select 'function', 'get_cam_input_category_candidates',
         exists (select 1 from pg_proc where proname='get_cam_input_category_candidates')
  union all select 'function', 'resolve_cam_input_category',
         exists (select 1 from pg_proc where proname='resolve_cam_input_category')
  union all select 'column', 'cam_runs.stale',
         exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='cam_runs' and column_name='stale')
) t
order by kind, name;

-- ---------------------------------------------------------------------------
-- 3. cam_profiles is gone (migration 038).
-- ---------------------------------------------------------------------------
select
  '3. cam_profiles_removed' as section,
  case when exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='cam_profiles')
       then 'FAIL - table still present' else 'PASS - absent' end as verdict;

-- ---------------------------------------------------------------------------
-- 4. Canonical category coverage, by organization and property.
--    REVIEW (not FAIL) when rows remain unresolved: ambiguous and unknown
--    labels are legitimately left NULL until a human decides. They must,
--    however, be visible and owned.
-- ---------------------------------------------------------------------------
select
  '4. coverage' as section,
  ei.org_id,
  o.name as org_name,
  ei.property_id,
  p.name as property_name,
  count(*) as published_rows,
  count(*) filter (where ei.expense_category_id is not null) as canonical_rows,
  count(*) filter (where ei.expense_category_id is null)     as unresolved_rows,
  round(sum(coalesce(ei.amount,0)), 2) as published_amount,
  round(sum(coalesce(ei.amount,0)) filter (where ei.expense_category_id is null), 2) as unresolved_amount,
  round(100.0 * count(*) filter (where ei.expense_category_id is not null) / nullif(count(*),0), 2) as coverage_pct,
  case when count(*) filter (where ei.expense_category_id is null
                               and coalesce(ei.amount,0) <> 0) = 0
       then 'PASS - full coverage of material rows'
       else 'REVIEW - material rows still unresolved' end as verdict
from public.cam_expense_inputs ei
left join public.organizations o on o.id = ei.org_id
left join public.properties p on p.id = ei.property_id
where ei.publication_status = 'published'
group by ei.org_id, o.name, ei.property_id, p.name
order by unresolved_amount desc nulls last;

-- ---------------------------------------------------------------------------
-- 5. Remaining unresolved rows, with the reason, so each has an owner.
-- ---------------------------------------------------------------------------
select
  '5. unresolved_detail' as section,
  ei.org_id,
  ei.property_id,
  ei.category as label,
  count(*) as row_count,
  round(sum(coalesce(ei.amount,0)), 2) as total_amount,
  public.resolve_expense_category_id(ei.org_id, ei.category) ->> 'unresolved_reason' as reason
from public.cam_expense_inputs ei
where ei.publication_status = 'published'
  and ei.expense_category_id is null
  and coalesce(ei.amount,0) <> 0
group by ei.org_id, ei.property_id, ei.category
order by total_amount desc
limit 200;

-- ---------------------------------------------------------------------------
-- 6. Label integrity: the display label must be PRESERVED, never overwritten
--    by the migration. A row with a canonical id but a null label would mean
--    the audit snapshot was lost.
-- ---------------------------------------------------------------------------
select
  '6. label_preserved' as section,
  count(*) filter (where expense_category_id is not null and nullif(btrim(coalesce(category,'')),'') is null) as canonical_but_no_label,
  case when count(*) filter (where expense_category_id is not null
                               and nullif(btrim(coalesce(category,'')),'') is null) = 0
       then 'PASS - every canonical row kept its display label'
       else 'REVIEW - some canonical rows have no display label' end as verdict
from public.cam_expense_inputs;

-- ---------------------------------------------------------------------------
-- 7. Reconciliation: published = assigned + unassigned, per property.
-- ---------------------------------------------------------------------------
with pub as (
  select org_id, property_id, id, coalesce(amount,0) as amount
    from public.cam_expense_inputs
   where publication_status = 'published'
),
asg as (
  select a.cam_expense_input_id, sum(coalesce(a.amount,0)) as assigned
    from public.cam_input_pool_assignments a
   group by a.cam_expense_input_id
)
select
  '7. published_vs_assigned' as section,
  pub.org_id,
  pub.property_id,
  round(sum(pub.amount), 2) as published_amount,
  round(sum(coalesce(asg.assigned, 0)), 2) as assigned_amount,
  round(sum(pub.amount) - sum(coalesce(asg.assigned, 0)), 2) as unassigned_amount,
  case when sum(coalesce(asg.assigned,0)) > sum(pub.amount) + 0.01
       then 'FAIL - over-assigned (double recovery risk)'
       else 'PASS - assignments never exceed published' end as verdict
from pub
left join asg on asg.cam_expense_input_id = pub.id
group by pub.org_id, pub.property_id
order by unassigned_amount desc nulls last;

-- ---------------------------------------------------------------------------
-- 8. Reconciliation: assigned dollars vs what the latest run's pools recorded.
--    pool actual + pool excluded should equal the dollars assigned to that pool.
-- ---------------------------------------------------------------------------
with latest as (
  select distinct on (org_id, recovery_period_id) id, org_id, recovery_period_id, status, created_at
    from public.cam_runs
   where status in ('calculated','under_review','submitted','approved','posted')
   order by org_id, recovery_period_id, created_at desc
),
pool_side as (
  select pr.cam_run_id, pr.pool_id,
         round(coalesce(pr.actual_amount,0) + coalesce(pr.excluded_amount,0), 2) as pool_source
    from public.cam_run_pool_results pr
),
assign_side as (
  select rp.id as pool_id, round(sum(coalesce(a.amount,0)), 2) as assigned
    from public.recovery_pools rp
    join public.cam_input_pool_assignments a on a.recovery_pool_id = rp.id
   group by rp.id
)
select
  '8. pool_reconciliation' as section,
  l.org_id,
  l.id as cam_run_id,
  l.status,
  ps.pool_id,
  ps.pool_source,
  coalesce(a.assigned, 0) as assigned_to_pool,
  round(ps.pool_source - coalesce(a.assigned, 0), 2) as variance,
  case when abs(ps.pool_source - coalesce(a.assigned, 0)) <= 0.01
       then 'PASS' else 'REVIEW - pool source does not match assignments' end as verdict
from latest l
join pool_side ps on ps.cam_run_id = l.id
left join assign_side a on a.pool_id = ps.pool_id
order by abs(ps.pool_source - coalesce(a.assigned, 0)) desc
limit 200;

-- ---------------------------------------------------------------------------
-- 9. Run health after deployment: stale drafts to recalculate, and immutable
--    runs that may need an explicit restatement.
-- ---------------------------------------------------------------------------
select
  '9. run_health' as section,
  org_id,
  status,
  count(*) as run_count,
  count(*) filter (where stale) as stale_runs,
  case
    when status in ('approved','posted') and count(*) filter (where stale) > 0
      then 'FAIL - an immutable run was mutated'
    when count(*) filter (where stale) > 0
      then 'REVIEW - recalculate these runs'
    else 'PASS' end as verdict
from public.cam_runs
group by org_id, status
order by org_id, case status when 'posted' then 1 when 'approved' then 2 else 3 end;

-- ---------------------------------------------------------------------------
-- 10. Sanity: no pool result is fully collapsed to zero while its pool still
--     has assigned dollars. This is the exact symptom the deployment fixes —
--     a configured pool whose category rules matched nothing sent every dollar
--     to `excluded` and recovered nothing.
-- ---------------------------------------------------------------------------
select
  '10. zero_recovery_check' as section,
  pr.cam_run_id,
  pr.pool_id,
  round(coalesce(pr.actual_amount,0), 2) as actual_amount,
  round(coalesce(pr.excluded_amount,0), 2) as excluded_amount,
  case when coalesce(pr.actual_amount,0) = 0 and coalesce(pr.excluded_amount,0) > 0
       then 'REVIEW - pool recovered nothing while excluding everything'
       else 'PASS' end as verdict
from public.cam_run_pool_results pr
where coalesce(pr.actual_amount,0) = 0 and coalesce(pr.excluded_amount,0) > 0
order by excluded_amount desc
limit 100;
