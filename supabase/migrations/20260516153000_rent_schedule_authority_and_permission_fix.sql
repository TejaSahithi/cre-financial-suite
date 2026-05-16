-- Authoritative approved rent schedules for lease projection plus a
-- compatibility repair for page-write permission checks used by compute-lease.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS rent_commencement_date DATE;

CREATE OR REPLACE FUNCTION public.can_write_any_page(check_org_id UUID, page_names TEXT[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(page_names, ARRAY[]::TEXT[])) AS page_name
    WHERE public.can_write_page(check_org_id, page_name)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS public.rent_schedules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id          UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id       UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id       UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  unit_id           UUID REFERENCES public.units(id) ON DELETE SET NULL,
  abstract_version  INT NOT NULL DEFAULT 1,
  row_type          TEXT NOT NULL DEFAULT 'base_rent',      -- base_rent | ground_rent | percentage_rent | abatement | renewal_base_rent | holdover_rent | manual
  phase             TEXT NOT NULL DEFAULT 'contracted',     -- contracted | approved_renewal | assumed_renewal | holdover
  charge_frequency  TEXT NOT NULL DEFAULT 'monthly',        -- monthly | annual | one_time
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  monthly_amount    NUMERIC,
  annual_amount     NUMERIC,
  rent_per_sf       NUMERIC,
  rsf               NUMERIC,
  proration_method  TEXT DEFAULT 'actual_days',
  is_abatement      BOOLEAN NOT NULL DEFAULT FALSE,
  abatement_percent NUMERIC,
  escalation_type   TEXT,
  escalation_rate   NUMERIC,
  escalation_amount NUMERIC,
  escalation_index  TEXT,
  status            TEXT NOT NULL DEFAULT 'approved',       -- draft | approved | superseded | archived
  approved_at       TIMESTAMPTZ,
  approved_by       TEXT,
  source            TEXT NOT NULL DEFAULT 'approved_abstract',
  assumption_reason TEXT,
  notes             TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_schedules_period_check CHECK (period_end >= period_start)
);

COMMENT ON TABLE public.rent_schedules IS
  'Approved rent schedule rows used as the authoritative source for rent projection. Rows may be contracted, approved renewal, or modeled assumptions.';

CREATE INDEX IF NOT EXISTS idx_rent_schedules_lease
  ON public.rent_schedules (org_id, lease_id, abstract_version, status);
CREATE INDEX IF NOT EXISTS idx_rent_schedules_scope
  ON public.rent_schedules (org_id, property_id, building_id, unit_id, status);
CREATE INDEX IF NOT EXISTS idx_rent_schedules_period
  ON public.rent_schedules (lease_id, period_start, period_end);

ALTER TABLE public.rent_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rent_schedules_select" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_insert" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_update" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_delete" ON public.rent_schedules;

CREATE POLICY "rent_schedules_select" ON public.rent_schedules
  FOR SELECT USING (
    public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids())
  );

CREATE POLICY "rent_schedules_insert" ON public.rent_schedules
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "rent_schedules_update" ON public.rent_schedules
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "rent_schedules_delete" ON public.rent_schedules
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP TRIGGER IF EXISTS set_rent_schedules_updated_at ON public.rent_schedules;
CREATE TRIGGER set_rent_schedules_updated_at
  BEFORE UPDATE ON public.rent_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();
