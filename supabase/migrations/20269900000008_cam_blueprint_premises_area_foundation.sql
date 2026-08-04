-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 1 (hardened),
-- migration 1 of 3: premises, area, and occupancy foundation (blueprint
-- section 6.1).
--
-- Identifier history: originally 20260908000000 ("September 8, 2026" —
-- future-dated relative to 2026-08-03), first renamed to 20260907000001
-- (still future-dated: the anchor it sorted after, 20260907000000, was
-- itself a fake September date from earlier the same session). Renamed a
-- second time, together with the 12 other migrations created this session
-- (20260901000000-20260907000006), to the current 202699000000{01-13}
-- scheme: month "99" is not a real calendar month, so it cannot be
-- misread as a future date at any digit position, while the trailing
-- counter preserves the correct creation order. None of these 13
-- migrations were ever deployed outside the local environment, so both
-- renames were safe. Internal cross-references between these files were
-- updated in the same pass; comments in unrelated files that mention an
-- old timestamp for historical context were intentionally left as-is.
--
-- Hardening applied on top of the original version (which applied cleanly
-- but had no real data and was never depended on by anything, so it was
-- dropped and rewritten rather than patched):
--   1. Overlap prevention: EXCLUDE ... USING gist constraints stop two
--      non-superseded effective-dated rows from covering the same instant
--      for the same partition key (lease+premises_type, scope+area_type,
--      premises+area_basis, scope alone for occupancy). Requires
--      btree_gist for the equality-plus-range exclusion.
--   2. Numeric precision: area_sqft columns are NUMERIC(14,2) — square
--      footage doesn't need sub-cent precision, but was unconstrained
--      before.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.lease_premises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  -- A premises record may derive from the approved base lease abstract
  -- version or from a later approved amendment (expansion/contraction/
  -- relocation/surrender) — at most one of the two is expected to be set,
  -- but this is advisory metadata, not enforced by a CHECK, since a
  -- premises record with neither (the original, un-amended lease) is the
  -- common case.
  lease_version_id UUID REFERENCES public.lease_abstract_versions(id) ON DELETE SET NULL,
  lease_amendment_id UUID REFERENCES public.lease_amendments(id) ON DELETE SET NULL,
  premises_type TEXT NOT NULL DEFAULT 'primary'
    CHECK (premises_type IN ('primary', 'expansion', 'contraction', 'relocation', 'storage', 'parking', 'other')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lease_premises_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A lease cannot have two overlapping ACTIVE premises records of the
  -- same type (e.g. two concurrent "primary" premises). Different types
  -- (primary + storage) may legitimately coexist. Superseded rows are
  -- excluded so an amendment can open a new overlapping record the instant
  -- the old one is marked superseded, without a two-phase dance.
  CONSTRAINT lease_premises_no_overlap
    EXCLUDE USING gist (
      lease_id WITH =,
      premises_type WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    ) WHERE (status <> 'superseded')
);

CREATE INDEX IF NOT EXISTS idx_lease_premises_lease
  ON public.lease_premises(org_id, lease_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_lease_premises_amendment
  ON public.lease_premises(lease_amendment_id) WHERE lease_amendment_id IS NOT NULL;

-- Links one logical premises record to one or more physical
-- property/building/unit rows (a lease may span multiple units/buildings).
CREATE TABLE IF NOT EXISTS public.lease_premises_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_premises_id UUID NOT NULL REFERENCES public.lease_premises(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id UUID REFERENCES public.buildings(id) ON DELETE CASCADE,
  unit_id UUID REFERENCES public.units(id) ON DELETE CASCADE,
  -- Relative weight, not a 0-100 percentage — e.g. two spaces of a
  -- multi-suite lease might be weighted by their own square footage.
  -- Zero is rejected (a zero-weight space contributes nothing and should
  -- not exist as a row); the upper bound is intentionally unconstrained
  -- since the unit is caller-defined (could be sqft, could be a ratio).
  allocation_weight NUMERIC(14,6) NOT NULL DEFAULT 1 CHECK (allocation_weight > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_premises_spaces_premises
  ON public.lease_premises_spaces(lease_premises_id);
CREATE INDEX IF NOT EXISTS idx_lease_premises_spaces_scope
  ON public.lease_premises_spaces(org_id, property_id, building_id, unit_id);

-- Historical physical/rentable/usable area for a property, building, or
-- unit — independent of any one lease's contractual recovery area.
CREATE TABLE IF NOT EXISTS public.space_area_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('property', 'building', 'unit')),
  scope_id UUID NOT NULL,
  area_type TEXT NOT NULL DEFAULT 'rentable' CHECK (area_type IN ('rentable', 'usable', 'gross', 'physical')),
  standard TEXT,
  area_sqft NUMERIC(14,2) NOT NULL CHECK (area_sqft >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  source_id UUID,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT space_area_measurements_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- At most one active measurement of a given area_type per scope at any
  -- instant — two simultaneous "rentable" measurements for the same unit
  -- would make the denominator ambiguous.
  CONSTRAINT space_area_measurements_no_overlap
    EXCLUDE USING gist (
      scope_type WITH =,
      scope_id WITH =,
      area_type WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS idx_space_area_measurements_scope
  ON public.space_area_measurements(org_id, scope_type, scope_id, effective_from, effective_to);

-- Contractual recovery numerator for a lease premises, independent of the
-- physically measured area above (ADR-CAM-004: "Use approved contractual
-- recovery area for the effective slice unless policy explicitly says
-- current measured area").
CREATE TABLE IF NOT EXISTS public.lease_premises_area_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_premises_id UUID NOT NULL REFERENCES public.lease_premises(id) ON DELETE CASCADE,
  area_basis TEXT NOT NULL DEFAULT 'rentable'
    CHECK (area_basis IN ('rentable', 'usable', 'gross', 'fixed_contractual')),
  contractual_area_sqft NUMERIC(14,2) CHECK (contractual_area_sqft IS NULL OR contractual_area_sqft >= 0),
  recovery_area_sqft NUMERIC(14,2) CHECK (recovery_area_sqft IS NULL OR recovery_area_sqft >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lease_premises_area_periods_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT lease_premises_area_periods_no_overlap
    EXCLUDE USING gist (
      lease_premises_id WITH =,
      area_basis WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS idx_lease_premises_area_periods_premises
  ON public.lease_premises_area_periods(lease_premises_id, effective_from, effective_to);

-- Historical occupancy/vacancy per scope — the direct fix for
-- cam-calculator.ts's non-time-weighted occupied-area sum.
CREATE TABLE IF NOT EXISTS public.space_occupancy_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('property', 'building', 'unit')),
  scope_id UUID NOT NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  occupancy_status TEXT NOT NULL DEFAULT 'occupied'
    CHECK (occupancy_status IN ('occupied', 'vacant', 'owner_use', 'under_construction')),
  occupied_area_sqft NUMERIC(14,2) CHECK (occupied_area_sqft IS NULL OR occupied_area_sqft >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT space_occupancy_periods_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A scope cannot be simultaneously occupied AND vacant (or two different
  -- leases both "occupying" it) at the same instant.
  CONSTRAINT space_occupancy_periods_no_overlap
    EXCLUDE USING gist (
      scope_type WITH =,
      scope_id WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS idx_space_occupancy_periods_scope
  ON public.space_occupancy_periods(org_id, scope_type, scope_id, effective_from, effective_to);

-- RLS: org-scoped read (so future setup/read-only UI and Phase 2/B APIs can
-- work as soon as they exist); ALL writes locked to service_role via
-- SECURITY DEFINER RPCs. Matches this codebase's established pattern for
-- lease_expense_rule_sets / expense_classifications / cam_expense_inputs.
ALTER TABLE public.lease_premises ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_premises_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.space_area_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_premises_area_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.space_occupancy_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY lease_premises_select ON public.lease_premises FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY lease_premises_insert ON public.lease_premises FOR INSERT WITH CHECK (false);
CREATE POLICY lease_premises_update ON public.lease_premises FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY lease_premises_delete ON public.lease_premises FOR DELETE USING (false);

CREATE POLICY lease_premises_spaces_select ON public.lease_premises_spaces FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY lease_premises_spaces_insert ON public.lease_premises_spaces FOR INSERT WITH CHECK (false);
CREATE POLICY lease_premises_spaces_update ON public.lease_premises_spaces FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY lease_premises_spaces_delete ON public.lease_premises_spaces FOR DELETE USING (false);

CREATE POLICY space_area_measurements_select ON public.space_area_measurements FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY space_area_measurements_insert ON public.space_area_measurements FOR INSERT WITH CHECK (false);
CREATE POLICY space_area_measurements_update ON public.space_area_measurements FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY space_area_measurements_delete ON public.space_area_measurements FOR DELETE USING (false);

CREATE POLICY lease_premises_area_periods_select ON public.lease_premises_area_periods FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY lease_premises_area_periods_insert ON public.lease_premises_area_periods FOR INSERT WITH CHECK (false);
CREATE POLICY lease_premises_area_periods_update ON public.lease_premises_area_periods FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY lease_premises_area_periods_delete ON public.lease_premises_area_periods FOR DELETE USING (false);

CREATE POLICY space_occupancy_periods_select ON public.space_occupancy_periods FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY space_occupancy_periods_insert ON public.space_occupancy_periods FOR INSERT WITH CHECK (false);
CREATE POLICY space_occupancy_periods_update ON public.space_occupancy_periods FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY space_occupancy_periods_delete ON public.space_occupancy_periods FOR DELETE USING (false);
