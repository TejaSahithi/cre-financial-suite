-- ============================================================
-- Fix SuperAdmin RLS access — correct approach
--
-- The problem: super_admin has org_id = NULL in memberships,
-- so get_my_org_ids() returns nothing for them → 403 on all tables.
--
-- The solution: keep get_my_org_ids() returning SETOF UUID (required
-- for ANY() in policies), but add a super_admin bypass to each policy
-- using the existing is_super_admin() boolean function.
--
-- We do NOT change get_my_org_ids() return type (that breaks policies).
-- We DO fix can_write_org_data() to allow super_admins.
-- ============================================================

-- Fix can_write_org_data: super_admins can write to any org
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

-- Rebuild all table RLS policies with super_admin bypass
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'portfolios','properties','buildings','units',
    'tenants','leases','expenses','budgets','vendors','invoices'
  ])
  LOOP
    -- Drop existing policies
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);

    -- SELECT: org members OR super_admin
    -- Use EXISTS subquery instead of ANY(SETOF) to avoid the set-returning error
    EXECUTE format(
      'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (
        public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.memberships m
          WHERE m.user_id = auth.uid() AND m.org_id = %I.org_id
        )
      )',
      t, t, t
    );

    -- INSERT: can_write_org_data already handles super_admin
    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.can_write_org_data(org_id))',
      t, t
    );

    -- UPDATE: can_write_org_data already handles super_admin
    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.can_write_org_data(org_id))',
      t, t
    );

    -- DELETE: is_org_admin already handles super_admin
    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.is_org_admin(org_id))',
      t, t
    );
  END LOOP;
END $$;
