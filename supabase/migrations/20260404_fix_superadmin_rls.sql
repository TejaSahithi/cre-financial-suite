-- ============================================================
-- Fix SuperAdmin RLS access
--
-- Problems fixed:
-- 1. get_my_org_ids() returns empty for super_admins → they can't SELECT any data
-- 2. can_write_org_data() requires org_id match → super_admins can't INSERT/UPDATE
-- 3. is_org_admin() already handles super_admin correctly (no change needed)
-- ============================================================

-- Fix 1: get_my_org_ids() — super_admins get ALL org_ids
DROP FUNCTION IF EXISTS public.get_my_org_ids();
CREATE OR REPLACE FUNCTION public.get_my_org_ids()
RETURNS SETOF UUID AS $$
  SELECT CASE
    -- Super admin: return all org_ids
    WHEN EXISTS (
      SELECT 1 FROM public.memberships
      WHERE user_id = auth.uid() AND role = 'super_admin'
    )
    THEN (SELECT id FROM public.organizations)
    -- Regular user: return their own org_ids
    ELSE (
      SELECT org_id FROM public.memberships
      WHERE user_id = auth.uid() AND org_id IS NOT NULL
    )
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Fix 2: can_write_org_data() — super_admins can write to any org
CREATE OR REPLACE FUNCTION public.can_write_org_data(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND (
        -- Super admin can write to any org
        role = 'super_admin'
        OR
        -- Regular users need to be in the specific org with write role
        (org_id = check_org_id AND role IN ('org_admin', 'manager', 'editor'))
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Fix 3: is_org_admin() — already correct but ensure super_admin works
CREATE OR REPLACE FUNCTION public.is_org_admin(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND (role = 'super_admin' OR (role = 'org_admin' AND org_id = check_org_id))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Fix 4: is_super_admin() — unchanged but ensure it's correct
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid() AND role = 'super_admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;
