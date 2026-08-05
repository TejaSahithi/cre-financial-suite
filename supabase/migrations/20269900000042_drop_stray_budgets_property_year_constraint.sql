-- Drop the pre-scope UNIQUE(org_id, property_id, budget_year) constraint on
-- budgets, under whichever name it actually has in a given environment.
--
-- Root cause found in production (verified via `supabase db query --linked`
-- against cjwdwuqqdokblakheyjb 2026-08-05): 20269900000003_budget_scope_columns.sql
-- dropped this constraint as `budgets_org_property_year_key`, the name given to
-- it by 20260706160000_budgets_org_property_year_unique.sql. But the
-- constraint actually live on remote is named `budgets_org_prop_year_unique` --
-- a name that does not appear in any migration file in this repo's history
-- (created out-of-band, not migration-tracked). Because the names didn't
-- match, that DROP CONSTRAINT IF EXISTS was a silent no-op, and the old
-- constraint is still enforced today.
--
-- Effect while this stood: a building- or unit-scoped budget cannot coexist
-- with the property's own budget for the same year -- exactly the scenario
-- the scope/period PR was written to allow -- because both rows share the
-- same (org_id, property_id, budget_year) and the old constraint uses
-- NULLS NOT DISTINCT, so it still collides even before reaching the new
-- (org_id, scope, scope_id, budget_year) constraint.
--
-- This migration drops both possible names so it is correct regardless of
-- which one a given environment actually has (fresh local reset vs. the
-- drifted remote).

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_org_property_year_key;
ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_org_prop_year_unique;

-- Guard: the intended replacement must already exist. If it doesn't, the
-- scope/period migration never ran on this environment and dropping the old
-- constraint here would remove the only uniqueness guarantee on the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.budgets'::regclass
      AND conname = 'budgets_org_scope_scope_id_year_key'
  ) THEN
    RAISE EXCEPTION
      'budgets_org_scope_scope_id_year_key is missing -- run 20269900000003_budget_scope_columns.sql before this migration.';
  END IF;
END $$;
