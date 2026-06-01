-- Protect memberships table against privilege escalation

-- Drop any previous versions of these restrictive policies
DROP POLICY IF EXISTS "prevent_escalation_insert" ON public.memberships;
DROP POLICY IF EXISTS "prevent_escalation_update" ON public.memberships;

-- Add a restrictive INSERT policy
-- This applies alongside permissive policies. Even if a permissive policy evaluates to true,
-- this restrictive policy MUST ALSO evaluate to true for the INSERT to succeed.
CREATE POLICY "prevent_escalation_insert" ON public.memberships
AS RESTRICTIVE FOR INSERT
TO public
WITH CHECK (
  role != 'super_admin' OR public.is_super_admin()
);

-- Add a restrictive UPDATE policy
-- Same logic as INSERT: prevents any user from updating an existing membership to super_admin
CREATE POLICY "prevent_escalation_update" ON public.memberships
AS RESTRICTIVE FOR UPDATE
TO public
WITH CHECK (
  role != 'super_admin' OR public.is_super_admin()
);
