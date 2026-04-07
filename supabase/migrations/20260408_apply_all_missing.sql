-- ============================================================
-- APPLY ALL MISSING — run this once in Supabase SQL Editor
-- Covers everything shown as MISSING in the verification report.
-- All statements are idempotent (safe to re-run).
-- ============================================================

-- ── 1. uploaded_files + computation_snapshots tables ─────────────────────
-- These tables exist in your local migration files but weren't run yet.

CREATE TABLE IF NOT EXISTS public.uploaded_files (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  module_type             TEXT NOT NULL,
  file_name               TEXT NOT NULL,
  file_url                TEXT NOT NULL,
  file_size               INT,
  mime_type               TEXT,
  uploaded_by             TEXT,
  status                  TEXT NOT NULL DEFAULT 'uploaded',
  error_message           TEXT,
  failed_step             TEXT,
  progress_percentage     INT DEFAULT 0,
  row_count               INT DEFAULT 0,
  valid_count             INT DEFAULT 0,
  error_count             INT DEFAULT 0,
  parsed_data             JSONB DEFAULT '[]',
  valid_data              JSONB DEFAULT '[]',
  validation_errors       JSONB DEFAULT '[]',
  computed_results        JSONB DEFAULT '{}',
  property_id             UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  portfolio_id            UUID REFERENCES public.portfolios(id) ON DELETE SET NULL,
  processing_started_at   TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.uploaded_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uploaded_files_select" ON public.uploaded_files;
DROP POLICY IF EXISTS "uploaded_files_insert" ON public.uploaded_files;
DROP POLICY IF EXISTS "uploaded_files_update" ON public.uploaded_files;
DROP POLICY IF EXISTS "uploaded_files_delete" ON public.uploaded_files;

CREATE POLICY "uploaded_files_select" ON public.uploaded_files
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = uploaded_files.org_id)
  );
CREATE POLICY "uploaded_files_insert" ON public.uploaded_files
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "uploaded_files_update" ON public.uploaded_files
  FOR UPDATE USING (public.can_write_org_data(org_id));
CREATE POLICY "uploaded_files_delete" ON public.uploaded_files
  FOR DELETE USING (public.is_org_admin(org_id));

CREATE INDEX IF NOT EXISTS idx_uploaded_files_org      ON public.uploaded_files(org_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_module   ON public.uploaded_files(module_type);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_status   ON public.uploaded_files(status);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_property ON public.uploaded_files(org_id, property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uploaded_files_status_org ON public.uploaded_files(org_id, status, created_at DESC);

-- If table already existed, add missing columns safely
ALTER TABLE public.uploaded_files ADD COLUMN IF NOT EXISTS failed_step TEXT;
ALTER TABLE public.uploaded_files ADD COLUMN IF NOT EXISTS progress_percentage INT DEFAULT 0;
ALTER TABLE public.uploaded_files ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL;
ALTER TABLE public.uploaded_files ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES public.portfolios(id) ON DELETE SET NULL;

-- Back-fill progress_percentage for existing rows
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


-- ── 2. computation_snapshots table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.computation_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  engine_type TEXT NOT NULL,
  fiscal_year INT,
  month       INT,
  input_hash  TEXT,
  inputs      JSONB NOT NULL DEFAULT '{}',
  outputs     JSONB NOT NULL DEFAULT '{}',
  status      TEXT DEFAULT 'completed',
  computed_at TIMESTAMPTZ DEFAULT now(),
  computed_by TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.computation_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "computation_snapshots_select" ON public.computation_snapshots;
DROP POLICY IF EXISTS "computation_snapshots_insert" ON public.computation_snapshots;
DROP POLICY IF EXISTS "computation_snapshots_update" ON public.computation_snapshots;

CREATE POLICY "computation_snapshots_select" ON public.computation_snapshots
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = computation_snapshots.org_id)
  );
CREATE POLICY "computation_snapshots_insert" ON public.computation_snapshots
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "computation_snapshots_update" ON public.computation_snapshots
  FOR UPDATE USING (public.can_write_org_data(org_id));

-- Add updated_at if table already existed without it
ALTER TABLE public.computation_snapshots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_snapshots_org      ON public.computation_snapshots(org_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_property ON public.computation_snapshots(property_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_engine   ON public.computation_snapshots(engine_type, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_snapshots_latest   ON public.computation_snapshots(org_id, property_id, engine_type, fiscal_year, computed_at DESC);

-- Drop old unique indexes that blocked history (replaced by supersede pattern)
DROP INDEX IF EXISTS idx_snapshots_unique_property;
DROP INDEX IF EXISTS idx_snapshots_unique_org;

-- latest_snapshots view — always returns the most recent completed snapshot per key
CREATE OR REPLACE VIEW public.latest_snapshots AS
SELECT DISTINCT ON (org_id, property_id, engine_type, fiscal_year)
  id, org_id, property_id, engine_type, fiscal_year, month,
  inputs, outputs, status, computed_at, computed_by, created_at, updated_at
FROM public.computation_snapshots
WHERE status = 'completed'
ORDER BY org_id, property_id, engine_type, fiscal_year, computed_at DESC;

GRANT SELECT ON public.latest_snapshots TO authenticated;


-- ── 3. can_write_org_data — super_admin fix ───────────────────────────────
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

-- Rebuild all table RLS policies with super_admin bypass
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
        OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = %I.org_id)
      )', t, t, t);

    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.can_write_org_data(org_id))',
      t, t);

    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.can_write_org_data(org_id))',
      t, t);

    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.is_org_admin(org_id))',
      t, t);
  END LOOP;
END $$;


-- ── 4. pipeline_logs table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pipeline_logs (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id   UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  org_id    UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step      TEXT NOT NULL,
  level     TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message   TEXT NOT NULL,
  metadata  JSONB NOT NULL DEFAULT '{}',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pipeline_logs_select" ON public.pipeline_logs;
DROP POLICY IF EXISTS "pipeline_logs_insert" ON public.pipeline_logs;

CREATE POLICY "pipeline_logs_select" ON public.pipeline_logs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = pipeline_logs.org_id)
  );
CREATE POLICY "pipeline_logs_insert" ON public.pipeline_logs
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_file  ON public.pipeline_logs(file_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_org   ON public.pipeline_logs(org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_level ON public.pipeline_logs(org_id, level) WHERE level IN ('warn', 'error');


-- ── 5. Enterprise schema — user_access + extend portfolios/buildings/units ─

-- portfolios: add missing columns
ALTER TABLE public.portfolios ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.portfolios ADD COLUMN IF NOT EXISTS total_properties INT DEFAULT 0;
ALTER TABLE public.portfolios ADD COLUMN IF NOT EXISTS total_sqft      NUMERIC DEFAULT 0;
ALTER TABLE public.portfolios ADD COLUMN IF NOT EXISTS created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_portfolios_org    ON public.portfolios(org_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_status ON public.portfolios(org_id, status);
CREATE INDEX IF NOT EXISTS idx_properties_portfolio ON public.properties(portfolio_id) WHERE portfolio_id IS NOT NULL;

-- buildings: add missing columns
ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS address     TEXT;
ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS year_built  INT;
ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_buildings_org      ON public.buildings(org_id);
CREATE INDEX IF NOT EXISTS idx_buildings_property ON public.buildings(property_id);

-- units: add missing columns
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS floor            INT;
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS unit_type        TEXT;
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS occupancy_status TEXT NOT NULL DEFAULT 'vacant';
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS lease_id         UUID REFERENCES public.leases(id) ON DELETE SET NULL;
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS monthly_rent     NUMERIC DEFAULT 0;
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS lease_start      DATE;
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS lease_end        DATE;
ALTER TABLE public.units ADD COLUMN IF NOT EXISTS notes            TEXT;

CREATE INDEX IF NOT EXISTS idx_units_org       ON public.units(org_id);
CREATE INDEX IF NOT EXISTS idx_units_property  ON public.units(property_id);
CREATE INDEX IF NOT EXISTS idx_units_building  ON public.units(building_id) WHERE building_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_units_occupancy ON public.units(org_id, occupancy_status);

-- user_access table
CREATE TABLE IF NOT EXISTS public.user_access (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('portfolio', 'property')),
  scope_id   UUID NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'manager')),
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, scope_id)
);

ALTER TABLE public.user_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_access_select" ON public.user_access;
DROP POLICY IF EXISTS "user_access_insert" ON public.user_access;
DROP POLICY IF EXISTS "user_access_update" ON public.user_access;
DROP POLICY IF EXISTS "user_access_delete" ON public.user_access;

CREATE POLICY "user_access_select" ON public.user_access
  FOR SELECT USING (public.is_super_admin() OR user_id = auth.uid() OR public.is_org_admin(org_id));
CREATE POLICY "user_access_insert" ON public.user_access
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "user_access_update" ON public.user_access
  FOR UPDATE USING (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "user_access_delete" ON public.user_access
  FOR DELETE USING (public.is_super_admin() OR public.is_org_admin(org_id));

CREATE INDEX IF NOT EXISTS idx_user_access_user   ON public.user_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_access_org    ON public.user_access(org_id);
CREATE INDEX IF NOT EXISTS idx_user_access_scope  ON public.user_access(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_user_access_active ON public.user_access(user_id, is_active) WHERE is_active = TRUE;


-- ── 6. Helper functions for user_access ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_access_portfolio(p_portfolio_id UUID)
RETURNS BOOLEAN AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      JOIN public.portfolios pf ON pf.org_id = m.org_id
      WHERE m.user_id = auth.uid() AND pf.id = p_portfolio_id
    )
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE ua.user_id = auth.uid()
        AND ua.scope = 'portfolio' AND ua.scope_id = p_portfolio_id
        AND ua.is_active = TRUE AND (ua.expires_at IS NULL OR ua.expires_at > now())
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.can_access_property(p_property_id UUID)
RETURNS BOOLEAN AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      JOIN public.properties pr ON pr.org_id = m.org_id
      WHERE m.user_id = auth.uid() AND pr.id = p_property_id
    )
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE ua.user_id = auth.uid()
        AND ua.scope = 'property' AND ua.scope_id = p_property_id
        AND ua.is_active = TRUE AND (ua.expires_at IS NULL OR ua.expires_at > now())
    )
    OR EXISTS (
      SELECT 1 FROM public.properties pr
      WHERE pr.id = p_property_id AND pr.portfolio_id IS NOT NULL
        AND public.can_access_portfolio(pr.portfolio_id)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_accessible_property_ids(p_org_id UUID)
RETURNS SETOF UUID AS $$
  SELECT id FROM public.properties
  WHERE org_id = p_org_id
    AND (public.is_super_admin() OR EXISTS (
      SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = p_org_id
    ))
  UNION
  SELECT ua.scope_id FROM public.user_access ua
  WHERE ua.user_id = auth.uid() AND ua.org_id = p_org_id
    AND ua.scope = 'property' AND ua.is_active = TRUE
    AND (ua.expires_at IS NULL OR ua.expires_at > now())
  UNION
  SELECT pr.id FROM public.properties pr
  JOIN public.user_access ua ON ua.scope_id = pr.portfolio_id
  WHERE ua.user_id = auth.uid() AND ua.org_id = p_org_id
    AND ua.scope = 'portfolio' AND ua.is_active = TRUE
    AND (ua.expires_at IS NULL OR ua.expires_at > now());
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- auto-update updated_at on user_access
CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_user_access_updated_at ON public.user_access;
CREATE TRIGGER tr_user_access_updated_at
  BEFORE UPDATE ON public.user_access
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
