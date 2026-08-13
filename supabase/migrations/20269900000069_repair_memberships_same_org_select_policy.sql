-- Repair Team Management membership visibility.
--
-- Team Management lists members by selecting public.memberships for the active
-- organization. The older same-org SELECT policy depends on get_my_org_ids(),
-- whose return shape has drifted between environments. When that policy fails
-- to match, Supabase silently returns only the caller's own membership row via
-- memberships_select_own, so org admins can see themselves but not active team
-- members such as property_manager users.

CREATE OR REPLACE FUNCTION public.is_member_of_org(check_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_super_admin() OR EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE user_id = auth.uid()
      AND org_id = check_org_id
  );
$$;

DROP POLICY IF EXISTS "memberships_select_org" ON public.memberships;
CREATE POLICY "memberships_select_org" ON public.memberships
  FOR SELECT
  USING (public.is_member_of_org(org_id));
