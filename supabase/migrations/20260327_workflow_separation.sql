-- =============================================================================
-- Migration: 20260327_workflow_separation.sql
-- Separates demo requests from access requests into their own table.
-- This prevents overwriting and allows both workflows to run independently.
-- =============================================================================

-- 1. Create the demo_requests table (completely independent of access_requests)
CREATE TABLE IF NOT EXISTS public.demo_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL,
  email       text NOT NULL,
  phone       text,
  company_name text,
  role        text,
  plan        text,
  notes       text,
  demo_viewed boolean DEFAULT false,
  status      text NOT NULL DEFAULT 'new',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 2. Enable RLS on demo_requests
ALTER TABLE public.demo_requests ENABLE ROW LEVEL SECURITY;

-- 3. Allow public (unauthenticated) inserts — needed for the public-facing form
CREATE POLICY "demo_requests_public_insert"
  ON public.demo_requests
  FOR INSERT
  TO public
  WITH CHECK (true);

-- 4. Allow super_admins to SELECT all demo requests
CREATE POLICY "demo_requests_admin_select"
  ON public.demo_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.role = 'super_admin'
    )
  );

-- 5. Allow super_admins to UPDATE demo requests (e.g. mark as contacted)
CREATE POLICY "demo_requests_admin_update"
  ON public.demo_requests
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.role = 'super_admin'
    )
  );

-- 6. Allow super_admins to DELETE demo requests
CREATE POLICY "demo_requests_admin_delete"
  ON public.demo_requests
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.role = 'super_admin'
    )
  );

-- 7. Relax any unique constraint on email in access_requests if one exists
--    (access_requests may have had a unique email constraint that blocks multiple entries)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conrelid = 'public.access_requests'::regclass 
      AND contype = 'u' 
      AND conname ILIKE '%email%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.access_requests DROP CONSTRAINT ' || conname
      FROM pg_constraint 
      WHERE conrelid = 'public.access_requests'::regclass 
        AND contype = 'u' 
        AND conname ILIKE '%email%'
      LIMIT 1
    );
  END IF;
END;
$$;

-- 8. Performance indexes
CREATE INDEX IF NOT EXISTS idx_access_requests_type ON public.access_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_demo_requests_email  ON public.demo_requests(email);
CREATE INDEX IF NOT EXISTS idx_demo_requests_status ON public.demo_requests(status);
