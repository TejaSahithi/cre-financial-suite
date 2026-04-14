-- ============================================================
-- CONSOLIDATED MIGRATION — run this in Supabase SQL Editor
-- Applies all pending migrations in the correct order.
-- Safe to run multiple times (all statements are idempotent).
-- ============================================================

-- ── 1. SuperAdmin RLS fix ─────────────────────────────────────────────────
-- Fix can_write_org_data: super_admins can write to any org
CREATE OR REPLACE FUNCTION public.can_write_org_data(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND (
        role = 'super_admin'
        OR (org_id = check_org_id AND role IN ('org_admin', 'manager', 'editor'))
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Rebuild RLS policies for all core tables with super_admin bypass
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'portfolios','properties','buildings','units',
    'tenants','leases','expenses','budgets','vendors','invoices'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);

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
    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.can_write_org_data(org_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.can_write_org_data(org_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.is_org_admin(org_id))',
      t, t
    );
  END LOOP;
END $$;

-- ── 2. computation_snapshots — unique indexes + latest_snapshots view ─────
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique_property
  ON public.computation_snapshots (org_id, property_id, engine_type, fiscal_year)
  WHERE property_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique_org
  ON public.computation_snapshots (org_id, engine_type, fiscal_year)
  WHERE property_id IS NULL;

CREATE OR REPLACE VIEW public.latest_snapshots AS
SELECT DISTINCT ON (org_id, property_id, engine_type, fiscal_year)
  id, org_id, property_id, engine_type, fiscal_year, month,
  inputs, outputs, status, computed_at, computed_by, created_at
FROM public.computation_snapshots
ORDER BY org_id, property_id, engine_type, fiscal_year, computed_at DESC;

GRANT SELECT ON public.latest_snapshots TO authenticated;

-- RLS super_admin bypass on computation_snapshots
DROP POLICY IF EXISTS "computation_snapshots_select" ON public.computation_snapshots;
CREATE POLICY "computation_snapshots_select" ON public.computation_snapshots
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.org_id = computation_snapshots.org_id
    )
  );

DROP POLICY IF EXISTS "computation_snapshots_insert" ON public.computation_snapshots;
CREATE POLICY "computation_snapshots_insert" ON public.computation_snapshots
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "computation_snapshots_update" ON public.computation_snapshots;
CREATE POLICY "computation_snapshots_update" ON public.computation_snapshots
  FOR UPDATE USING (public.can_write_org_data(org_id));

-- ── 3. Pipeline status columns ────────────────────────────────────────────
ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS progress_percentage INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_step TEXT;

UPDATE public.uploaded_files SET progress_percentage =
  CASE status
    WHEN 'uploaded'   THEN 5
    WHEN 'parsing'    THEN 15
    WHEN 'parsed'     THEN 30
    WHEN 'pdf_parsed' THEN 35
    WHEN 'validating' THEN 45
    WHEN 'validated'  THEN 60
    WHEN 'storing'    THEN 70
    WHEN 'stored'     THEN 80
    WHEN 'computing'  THEN 90
    WHEN 'completed'  THEN 100
    WHEN 'processed'  THEN 100
    ELSE 0
  END
WHERE progress_percentage = 0 OR progress_percentage IS NULL;

-- Normalise legacy 'processed' → 'completed'
UPDATE public.uploaded_files SET status = 'completed' WHERE status = 'processed';

CREATE INDEX IF NOT EXISTS idx_uploaded_files_status_org
  ON public.uploaded_files (org_id, status, created_at DESC);

-- ── 4. property_id on uploaded_files ─────────────────────────────────────
ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_property
  ON public.uploaded_files (org_id, property_id)
  WHERE property_id IS NOT NULL;
