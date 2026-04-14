-- ============================================================
-- Enterprise Schema Extension
-- Extends existing portfolios, buildings, units with missing
-- production-ready fields, adds user_access and pipeline_logs.
--
-- Safe to run on existing DB — all changes are additive.
-- ============================================================

-- ── 1. PORTFOLIOS — add missing fields ───────────────────────────────────
ALTER TABLE public.portfolios
  ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'active',  -- active | archived
  ADD COLUMN IF NOT EXISTS total_properties INT DEFAULT 0,                  -- denormalized count, updated by trigger
  ADD COLUMN IF NOT EXISTS total_sqft       NUMERIC DEFAULT 0,              -- denormalized, updated by trigger
  ADD COLUMN IF NOT EXISTS created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Ensure RLS is on (may already be enabled)
ALTER TABLE public.portfolios ENABLE ROW LEVEL SECURITY;

-- Drop and recreate policies with super_admin bypass
DROP POLICY IF EXISTS "portfolios_select" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_insert" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_update" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_delete" ON public.portfolios;

CREATE POLICY "portfolios_select" ON public.portfolios
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.org_id = portfolios.org_id
    )
  );

CREATE POLICY "portfolios_insert" ON public.portfolios
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE POLICY "portfolios_update" ON public.portfolios
  FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE POLICY "portfolios_delete" ON public.portfolios
  FOR DELETE USING (public.is_org_admin(org_id));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_portfolios_org    ON public.portfolios (org_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_status ON public.portfolios (org_id, status);


-- ── 2. PROPERTIES — ensure portfolio_id FK exists ────────────────────────
-- (already added in 20260322_add_core_tables.sql, this is a safety net)
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES public.portfolios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_properties_portfolio ON public.properties (portfolio_id)
  WHERE portfolio_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_properties_org_portfolio ON public.properties (org_id, portfolio_id);


-- ── 3. BUILDINGS — add missing production fields ──────────────────────────
ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS address         TEXT,
  ADD COLUMN IF NOT EXISTS year_built      INT,
  ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'active',  -- active | inactive | under_construction
  ADD COLUMN IF NOT EXISTS description     TEXT;

ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "buildings_select" ON public.buildings;
DROP POLICY IF EXISTS "buildings_insert" ON public.buildings;
DROP POLICY IF EXISTS "buildings_update" ON public.buildings;
DROP POLICY IF EXISTS "buildings_delete" ON public.buildings;

CREATE POLICY "buildings_select" ON public.buildings
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.org_id = buildings.org_id
    )
  );

CREATE POLICY "buildings_insert" ON public.buildings
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE POLICY "buildings_update" ON public.buildings
  FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE POLICY "buildings_delete" ON public.buildings
  FOR DELETE USING (public.is_org_admin(org_id));

CREATE INDEX IF NOT EXISTS idx_buildings_org      ON public.buildings (org_id);
CREATE INDEX IF NOT EXISTS idx_buildings_property ON public.buildings (property_id);


-- ── 4. UNITS — add missing production fields ─────────────────────────────
ALTER TABLE public.units
  ADD COLUMN IF NOT EXISTS floor              INT,
  ADD COLUMN IF NOT EXISTS unit_type          TEXT,                          -- office | retail | industrial | residential | storage
  ADD COLUMN IF NOT EXISTS occupancy_status   TEXT NOT NULL DEFAULT 'vacant', -- vacant | leased | owner_occupied | pre_lease | under_construction
  ADD COLUMN IF NOT EXISTS lease_id           UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS monthly_rent       NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_start        DATE,
  ADD COLUMN IF NOT EXISTS lease_end          DATE,
  ADD COLUMN IF NOT EXISTS notes              TEXT;

-- Rename status → occupancy_status if status column exists and occupancy_status doesn't
-- (handled above with ADD COLUMN IF NOT EXISTS — status column from original schema stays)

ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "units_select" ON public.units;
DROP POLICY IF EXISTS "units_insert" ON public.units;
DROP POLICY IF EXISTS "units_update" ON public.units;
DROP POLICY IF EXISTS "units_delete" ON public.units;

CREATE POLICY "units_select" ON public.units
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.org_id = units.org_id
    )
  );

CREATE POLICY "units_insert" ON public.units
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE POLICY "units_update" ON public.units
  FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE POLICY "units_delete" ON public.units
  FOR DELETE USING (public.is_org_admin(org_id));

CREATE INDEX IF NOT EXISTS idx_units_org          ON public.units (org_id);
CREATE INDEX IF NOT EXISTS idx_units_property     ON public.units (property_id);
CREATE INDEX IF NOT EXISTS idx_units_building     ON public.units (building_id) WHERE building_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_units_occupancy    ON public.units (org_id, occupancy_status);
CREATE INDEX IF NOT EXISTS idx_units_lease        ON public.units (lease_id) WHERE lease_id IS NOT NULL;


-- ── 5. USER_ACCESS — fine-grained access below org level ─────────────────
--
-- Hierarchy: org_admin → portfolio_user → property_user
--
-- scope values:
--   'portfolio' → scope_id = portfolios.id
--   'property'  → scope_id = properties.id
--
-- role values:
--   'viewer'  → read-only
--   'editor'  → can upload files and trigger compute
--   'manager' → can approve budgets, manage leases
--
CREATE TABLE IF NOT EXISTS public.user_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL CHECK (scope IN ('portfolio', 'property')),
  scope_id     UUID NOT NULL,
  role         TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'manager')),
  granted_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,                          -- NULL = no expiry
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One role per user per scope object
  UNIQUE (user_id, scope, scope_id)
);

ALTER TABLE public.user_access ENABLE ROW LEVEL SECURITY;

-- Users can see their own access grants; org_admins can see all in their org
CREATE POLICY "user_access_select" ON public.user_access
  FOR SELECT USING (
    public.is_super_admin()
    OR user_id = auth.uid()
    OR public.is_org_admin(org_id)
  );

-- Only org_admins and super_admins can grant access
CREATE POLICY "user_access_insert" ON public.user_access
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

CREATE POLICY "user_access_update" ON public.user_access
  FOR UPDATE USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

CREATE POLICY "user_access_delete" ON public.user_access
  FOR DELETE USING (
    public.is_super_admin()
    OR public.is_org_admin(org_id)
  );

CREATE INDEX IF NOT EXISTS idx_user_access_user     ON public.user_access (user_id);
CREATE INDEX IF NOT EXISTS idx_user_access_org      ON public.user_access (org_id);
CREATE INDEX IF NOT EXISTS idx_user_access_scope    ON public.user_access (scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_user_access_active   ON public.user_access (user_id, is_active) WHERE is_active = TRUE;


-- ── 6. PIPELINE_LOGS — per-step structured log for every file run ─────────
CREATE TABLE IF NOT EXISTS public.pipeline_logs (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id   UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  org_id    UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step      TEXT NOT NULL,                          -- upload | parse | validate | store | compute | compute-lease | etc.
  level     TEXT NOT NULL DEFAULT 'info'            -- info | warn | error
            CHECK (level IN ('info', 'warn', 'error')),
  message   TEXT NOT NULL,
  metadata  JSONB NOT NULL DEFAULT '{}',            -- row counts, error details, property_ids, etc.
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pipeline_logs_select" ON public.pipeline_logs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.org_id = pipeline_logs.org_id
    )
  );

CREATE POLICY "pipeline_logs_insert" ON public.pipeline_logs
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

-- Logs are immutable — no UPDATE or DELETE for regular users
-- (super_admin can delete via service role if needed)

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_file      ON public.pipeline_logs (file_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_org       ON public.pipeline_logs (org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_level     ON public.pipeline_logs (org_id, level) WHERE level IN ('warn', 'error');


-- ── 7. HELPER FUNCTIONS for user_access ──────────────────────────────────

-- Returns TRUE if the current user has any active access grant for a portfolio
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
        AND ua.scope = 'portfolio'
        AND ua.scope_id = p_portfolio_id
        AND ua.is_active = TRUE
        AND (ua.expires_at IS NULL OR ua.expires_at > now())
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Returns TRUE if the current user has any active access grant for a property
-- (direct grant OR via portfolio membership OR via org membership)
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
        AND ua.scope = 'property'
        AND ua.scope_id = p_property_id
        AND ua.is_active = TRUE
        AND (ua.expires_at IS NULL OR ua.expires_at > now())
    )
    OR EXISTS (
      SELECT 1 FROM public.properties pr
      WHERE pr.id = p_property_id
        AND pr.portfolio_id IS NOT NULL
        AND public.can_access_portfolio(pr.portfolio_id)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Returns all property_ids the current user can access within an org
CREATE OR REPLACE FUNCTION public.get_accessible_property_ids(p_org_id UUID)
RETURNS SETOF UUID AS $$
  -- Org members get all properties
  SELECT id FROM public.properties
  WHERE org_id = p_org_id
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.memberships m
        WHERE m.user_id = auth.uid() AND m.org_id = p_org_id
      )
    )
  UNION
  -- Direct property grants
  SELECT ua.scope_id FROM public.user_access ua
  WHERE ua.user_id = auth.uid()
    AND ua.org_id = p_org_id
    AND ua.scope = 'property'
    AND ua.is_active = TRUE
    AND (ua.expires_at IS NULL OR ua.expires_at > now())
  UNION
  -- Portfolio grants → all properties in those portfolios
  SELECT pr.id FROM public.properties pr
  JOIN public.user_access ua ON ua.scope_id = pr.portfolio_id
  WHERE ua.user_id = auth.uid()
    AND ua.org_id = p_org_id
    AND ua.scope = 'portfolio'
    AND ua.is_active = TRUE
    AND (ua.expires_at IS NULL OR ua.expires_at > now());
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- ── 8. AUTO-UPDATE updated_at on user_access ─────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_user_access_updated_at ON public.user_access;
CREATE TRIGGER tr_user_access_updated_at
  BEFORE UPDATE ON public.user_access
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
