-- ============================================================
-- CRE Financial Suite — Configuration Tables
-- property_config: Property-level business rules
-- lease_config: Lease-specific overrides
-- ============================================================

-- Property Configuration Table
CREATE TABLE IF NOT EXISTS public.property_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_calculation_method TEXT DEFAULT 'pro_rata' CHECK (cam_calculation_method IN ('pro_rata', 'fixed', 'capped')),
  expense_recovery_method TEXT DEFAULT 'base_year' CHECK (expense_recovery_method IN ('base_year', 'full', 'none')),
  fiscal_year_start INTEGER DEFAULT 1 CHECK (fiscal_year_start BETWEEN 1 AND 12),
  config_values   JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(property_id)
);

-- Lease Configuration Table
CREATE TABLE IF NOT EXISTS public.lease_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id        UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_cap         NUMERIC(12,2),
  base_year       INTEGER,
  excluded_expenses TEXT[],
  config_values   JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lease_id)
);

-- Enable Row Level Security
ALTER TABLE public.property_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_config ENABLE ROW LEVEL SECURITY;

-- RLS Policies for property_config
CREATE POLICY "property_config_select" ON public.property_config
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "property_config_insert" ON public.property_config
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE POLICY "property_config_update" ON public.property_config
  FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE POLICY "property_config_delete" ON public.property_config
  FOR DELETE USING (public.is_org_admin(org_id));

-- RLS Policies for lease_config
CREATE POLICY "lease_config_select" ON public.lease_config
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "lease_config_insert" ON public.lease_config
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE POLICY "lease_config_update" ON public.lease_config
  FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE POLICY "lease_config_delete" ON public.lease_config
  FOR DELETE USING (public.is_org_admin(org_id));

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_property_config_org ON public.property_config(org_id);
CREATE INDEX IF NOT EXISTS idx_property_config_property ON public.property_config(property_id);

CREATE INDEX IF NOT EXISTS idx_lease_config_org ON public.lease_config(org_id);
CREATE INDEX IF NOT EXISTS idx_lease_config_lease ON public.lease_config(lease_id);
