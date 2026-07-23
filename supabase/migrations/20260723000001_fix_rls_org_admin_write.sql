-- ============================================================
-- Fix: RLS org_admin write access + portfolio policies
-- Phase: Security hardening – org isolation enforcement
-- ============================================================

-- 1. Fix is_org_admin() to recognise 'owner' role alongside 'org_admin'
CREATE OR REPLACE FUNCTION public.is_org_admin(check_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND m.role IN ('org_admin', 'owner', 'super_admin')
        AND coalesce(m.status, 'active') IN ('active', 'owner')
    );
$$;

-- 2. Fix can_write_page() to short-circuit for org admins.
--    Previously this delegated entirely to membership_page_access(), which
--    could return 'read' for org_admin users who had no explicit page_permissions
--    JSONB set, causing INSERT RLS 42501 errors.
CREATE OR REPLACE FUNCTION public.can_write_page(check_org_id UUID, page_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_org_admin(check_org_id)
    OR public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 2;
$$;

-- 3. Rebuild portfolios RLS policies with proper org isolation.
--    - SELECT: members of the org can see the org's portfolios (strict isolation via EXISTS membership check)
--    - INSERT/UPDATE/DELETE: org_admin/owner of that specific org only
DROP POLICY IF EXISTS "portfolios_select" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_insert" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_update" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_delete" ON public.portfolios;

CREATE POLICY "portfolios_select" ON public.portfolios
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = portfolios.org_id
        AND coalesce(m.status, 'active') IN ('active', 'owner')
    )
  );

CREATE POLICY "portfolios_insert" ON public.portfolios
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

CREATE POLICY "portfolios_update" ON public.portfolios
  FOR UPDATE
  USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  )
  WITH CHECK (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

CREATE POLICY "portfolios_delete" ON public.portfolios
  FOR DELETE USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
