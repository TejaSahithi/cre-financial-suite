-- Drop the permissive INSERT policies on organizations
-- The first-login Edge Function provisions organizations via the Service Role Key, 
-- bypassing RLS entirely, so the frontend does not need any INSERT capabilities.
DROP POLICY IF EXISTS "orgs_insert_authenticated" ON public.organizations;
DROP POLICY IF EXISTS "orgs_insert" ON public.organizations;
