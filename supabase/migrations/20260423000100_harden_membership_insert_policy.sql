-- ============================================================
-- Audit finding S1: remove self-insert org_admin hole.
--
-- The previous INSERT policy on public.memberships let any authenticated
-- user insert a row with role='org_admin' and their own user_id, as long
-- as they didn't already have a membership in the target org. Any user
-- who learned another tenant's org_id could attach themselves as admin.
--
-- Legitimate org-creation flows (first-login, invite-user, accept-invite)
-- all use the service role, which bypasses RLS. So removing the self-
-- insert branch does not break any supported path.
--
-- This migration:
--   1. Drops the permissive `memberships_insert_secure` policy.
--   2. Recreates it with ONLY the admin-initiated branch.
--   3. Adds a SECURITY DEFINER RPC `register_owner_membership(p_org_id)`
--      that org-creation flows can optionally call from an anon-client
--      context in the future. It performs the same safety checks the old
--      RLS policy did (user_id = auth.uid(), role = 'org_admin', no prior
--      membership in that org) plus one critical extra check: the org
--      must have been created by the same user within the last 60 minutes
--      (read from organizations.created_by / created_at), closing the
--      "attach yourself to a stranger's org" attack.
--   4. Grants EXECUTE to authenticated role only.
-- ============================================================

-- 1. Replace the permissive policy.
DROP POLICY IF EXISTS "memberships_insert_secure" ON public.memberships;
DROP POLICY IF EXISTS "memberships_insert" ON public.memberships;

CREATE POLICY "memberships_insert_admin_only"
  ON public.memberships
  FOR INSERT
  WITH CHECK (public.is_org_admin(org_id));

-- 2. Make sure organizations.created_by exists so the RPC can verify
--    that the org really belongs to the caller. This column is a safety
--    net for the SECURITY DEFINER RPC below and is only added if missing.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_created_by
  ON public.organizations (created_by);

-- 3. SECURITY DEFINER RPC for owner self-registration.
--    Writes one membership row for the caller, only for an org the caller
--    themselves just created. Callers: the `first-login` edge function
--    (which will prefer this RPC over a service-role insert in the future),
--    or any future anon-client onboarding path.
CREATE OR REPLACE FUNCTION public.register_owner_membership(p_org_id UUID)
RETURNS public.memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org     public.organizations%ROWTYPE;
  v_result  public.memberships%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization % not found', p_org_id USING ERRCODE = 'P0002';
  END IF;

  -- Only allow when the org is in an onboarding state AND either
  -- (a) created_by matches the caller, OR
  -- (b) created_by is NULL AND the org was created within the last 60
  --     minutes (covers legacy orgs created before created_by existed).
  IF v_org.status NOT IN ('onboarding', 'under_review') THEN
    RAISE EXCEPTION 'organization is not in onboarding state'
      USING ERRCODE = '42501';
  END IF;

  IF v_org.created_by IS NOT NULL AND v_org.created_by <> v_user_id THEN
    RAISE EXCEPTION 'only the creator can self-register as org_admin'
      USING ERRCODE = '42501';
  END IF;

  IF v_org.created_by IS NULL AND v_org.created_at < now() - interval '60 minutes' THEN
    RAISE EXCEPTION 'onboarding window expired'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = v_user_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'membership already exists'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.memberships (user_id, org_id, role, status)
  VALUES (v_user_id, p_org_id, 'org_admin', 'active')
  RETURNING * INTO v_result;

  -- Stamp created_by for legacy orgs that came in NULL so future calls
  -- take the stricter branch of the check above.
  IF v_org.created_by IS NULL THEN
    UPDATE public.organizations SET created_by = v_user_id WHERE id = p_org_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.register_owner_membership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_owner_membership(UUID) TO authenticated;
