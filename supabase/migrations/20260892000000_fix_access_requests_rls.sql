-- Migration: Fix access_requests RLS so super admins can see & approve requests
-- Problem: The access_requests table had no SELECT policy for authenticated super admins,
-- so new requests submitted via the public form never appeared in SuperAdmin panel.
-- 
-- Policy design:
--   INSERT  -> anon/authenticated (public form submissions)
--   SELECT  -> super_admin sees all; authenticated user sees their own row by email
--   UPDATE  -> super_admin only (approve/reject/revoke)
--   DELETE  -> super_admin only

-- 1. Enable RLS if not already enabled (idempotent)
ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

-- 2. Drop any existing stale policies to start clean
DROP POLICY IF EXISTS "access_requests_insert_public"    ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_insert"           ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_select_admin"     ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_select_own"       ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_select"           ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_update_admin"     ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_update"           ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_delete_admin"     ON public.access_requests;
DROP POLICY IF EXISTS "access_requests_delete"           ON public.access_requests;
DROP POLICY IF EXISTS "Public insert access_requests"    ON public.access_requests;
DROP POLICY IF EXISTS "Super admin read access_requests" ON public.access_requests;

-- 3. INSERT: allow anonymous (public form) and authenticated users
CREATE POLICY "access_requests_insert_public" ON public.access_requests
  FOR INSERT
  WITH CHECK (true);

-- 4a. SELECT: Super admins see all rows
CREATE POLICY "access_requests_select_admin" ON public.access_requests
  FOR SELECT
  USING (public.is_super_admin());

-- 4b. SELECT: Authenticated users can see their own row (by email match)
CREATE POLICY "access_requests_select_own" ON public.access_requests
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(p.email) = lower(access_requests.email)
    )
  );

-- 5. UPDATE: super admin only (approve, reject, revoke)
CREATE POLICY "access_requests_update_admin" ON public.access_requests
  FOR UPDATE
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- 6. DELETE: super admin only
CREATE POLICY "access_requests_delete_admin" ON public.access_requests
  FOR DELETE
  USING (public.is_super_admin());

-- 7. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_access_requests_email  ON public.access_requests (lower(email));
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON public.access_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_requests_type   ON public.access_requests (request_type, status);
