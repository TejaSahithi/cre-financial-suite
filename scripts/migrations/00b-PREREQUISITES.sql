-- =====================================================================
-- PREREQUISITE HELPERS — run this AFTER 00-DIAGNOSE-FIRST and BEFORE any
-- numbered migration. Creates the helper functions that the bundle's
-- CREATE TRIGGER and CREATE POLICY statements depend on.
--
-- Safe to re-run: every CREATE uses OR REPLACE.
-- =====================================================================

-- 1. set_workflow_updated_at — used by every workflow table's
--    BEFORE UPDATE trigger to refresh the updated_at column.
CREATE OR REPLACE FUNCTION public.set_workflow_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- 2. can_write_any_page — used by RLS policies on rent_schedules,
--    lease_expense_rule_sets, etc. Falls back to can_write_page.
CREATE OR REPLACE FUNCTION public.can_write_any_page(check_org_id UUID, page_names TEXT[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(page_names, ARRAY[]::TEXT[])) AS page_name
    WHERE public.can_write_page(check_org_id, page_name)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 3. Confirm both are now present (return 2 rows on success).
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('set_workflow_updated_at', 'can_write_any_page')
ORDER BY routine_name;
