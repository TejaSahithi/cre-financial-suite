-- Compatibility fix for the get_my_org_ids() local/remote divergence
-- discovered when pushing 20260706130000_lease_abstract_versions.sql:
-- local's get_my_org_ids() RETURNS SETOF uuid (used via
-- org_id IN (SELECT public.get_my_org_ids())), while the linked remote
-- project's live get_my_org_ids() RETURNS uuid[] (used via its 24 existing
-- policies as org_id = ANY(public.get_my_org_ids())) -- two divergent,
-- internally self-consistent contracts that predate this repo's migration
-- history on remote. Changing get_my_org_ids() itself on either side would
-- mean either a DROP FUNCTION + rewriting remote's 24 live policies, or
-- rewriting all 47 local call sites -- out of scope here.
--
-- Instead, this adds one new, narrow helper neither environment has yet:
-- a plain boolean-returning function with no array/set ambiguity, so it is
-- valid identically on local, remote, and a future Azure Postgres instance.
-- It does not touch, replace, or depend on get_my_org_ids() at all.
CREATE OR REPLACE FUNCTION public.is_member_of_org(check_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_super_admin() OR EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid() AND org_id = check_org_id
  );
$$;
