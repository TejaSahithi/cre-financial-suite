-- 1. Add missing columns to audit_logs
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS actor_email TEXT,
  ADD COLUMN IF NOT EXISTS actor_role TEXT,
  ADD COLUMN IF NOT EXISTS target_user_id UUID,
  ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'frontend',
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS before JSONB,
  ADD COLUMN IF NOT EXISTS after JSONB,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 2. Add CHECK constraints
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_severity_check 
  CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
  ADD CONSTRAINT audit_logs_source_check 
  CHECK (source IN ('frontend', 'edge_function', 'webhook', 'system'));

-- 3. Update RLS read policy (super_admin all, org_admin own org, regular users none)
-- Drop existing select policies
DROP POLICY IF EXISTS "audit_logs_select_admin" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;

CREATE POLICY "audit_logs_select" ON public.audit_logs
FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
        SELECT 1 FROM public.memberships m 
        WHERE m.user_id = auth.uid() 
        AND m.org_id = audit_logs.org_id
        AND m.role = 'org_admin'
    )
);

-- 4. Update RLS write policy (enforce actor_user_id = auth.uid(), source = 'frontend', block severity='critical')
DROP POLICY IF EXISTS "audit_logs_insert" ON public.audit_logs;

CREATE POLICY "audit_logs_insert" ON public.audit_logs
FOR INSERT WITH CHECK (
    -- Frontend inserts must be by the authenticated user for themselves
    actor_user_id = auth.uid()
    AND source = 'frontend'
    AND severity != 'critical'
    -- And they must be a member of the org they are logging for
    AND EXISTS (
        SELECT 1 FROM public.memberships m
        WHERE m.user_id = auth.uid()
        AND m.org_id = audit_logs.org_id
    )
);

-- Note: Edge functions using the service_role key bypass RLS, so they can insert
-- with source = 'edge_function' or 'webhook' and severity = 'critical'.

-- 5. Confirm immutability (no UPDATE/DELETE policies exist, but let's drop them just in case)
DROP POLICY IF EXISTS "audit_logs_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_update" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_delete" ON public.audit_logs;

-- We don't create any UPDATE or DELETE policies, ensuring immutability.
