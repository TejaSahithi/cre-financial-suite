-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-A schema
-- foundation: multi-pool-per-lease authority, double-recovery prevention,
-- explicit prior-adjustment states, and materializer identity hardening.
--
-- Product decisions this migration encodes (see Phase 3B instructions):
--   1. A lease may participate in multiple pools; nothing here forces a
--      single-pool resolution — recovery_pool_lease_participants is
--      additive, not exclusive.
--   2. Pool resolution authority chain: this migration adds the missing
--      link — EXPLICIT lease/premises participation
--      (recovery_pool_lease_participants) — so the engine can stop
--      inferring participation from building/unit spatial overlap alone.
--      Spatial/category matching remains available as a RECOMMENDATION
--      surface (not implemented as schema here — the engine layer computes
--      it) but never as financial authority.
--   3. Gross-up: recovery_pools.default_gross_up_target_pct is the pool
--      default; a lease's own GROSS_UP_VARIABLE policy step (already
--      existing) is the override. No new column needed for the override
--      itself.
--   4. cam_prior_period_adjustments: explicit KNOWN_ZERO/KNOWN_AMOUNT/
--      UNKNOWN/NOT_APPLICABLE states, never a bare nullable numeric.
--   5. materializer_version folded into the canonical identity tuple.
--   6. effective_date_confidence added; lease-commencement fallback
--      restricted at the RPC layer (migration 17) using
--      lease_amendments.effective_date as the "conflicting evidence" check.
--
-- Also closes a real, previously-flagged gap: Phase 1's hardening comment
-- called balanced pool-assignment enforcement "planned transactional
-- enforcement" — it was never actually implemented. This migration adds
-- the real trigger.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Pool-level gross-up default (product decision 3)
-- ---------------------------------------------------------------------------
ALTER TABLE public.recovery_pools
  ADD COLUMN IF NOT EXISTS default_gross_up_target_pct NUMERIC;

-- ---------------------------------------------------------------------------
-- Explicit lease-to-pool participation authority (product decisions 1 and 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recovery_pool_lease_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pool_id UUID NOT NULL REFERENCES public.recovery_pools(id) ON DELETE RESTRICT,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  -- 'explicit': an operator/approver deliberately enrolled this lease in
  -- this pool. 'legacy_backfill': produced by the Phase 3B-C backfill from
  -- spatial inference — still authoritative once created (this table IS the
  -- authority), but tagged so a reviewer can find and confirm/reject rows
  -- that were never explicitly decided by a human.
  source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'legacy_backfill')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A lease cannot have two overlapping active participation windows in the
-- SAME pool (that would be an ambiguous double-grant, not a legitimate
-- multi-pool scenario — multi-pool means DIFFERENT pools, not duplicate
-- rows for the same pool). Ended rows are excluded so a corrected
-- (superseded) window doesn't block the new one.
ALTER TABLE public.recovery_pool_lease_participants
  ADD CONSTRAINT recovery_pool_lease_participants_no_overlap
  EXCLUDE USING gist (
    pool_id WITH =,
    lease_id WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  ) WHERE (status = 'active');

CREATE INDEX IF NOT EXISTS idx_recovery_pool_lease_participants_lease
  ON public.recovery_pool_lease_participants(org_id, lease_id, status);
CREATE INDEX IF NOT EXISTS idx_recovery_pool_lease_participants_pool
  ON public.recovery_pool_lease_participants(org_id, pool_id, status);

ALTER TABLE public.recovery_pool_lease_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "recovery_pool_lease_participants_select" ON public.recovery_pool_lease_participants
  FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY "recovery_pool_lease_participants_insert" ON public.recovery_pool_lease_participants FOR INSERT WITH CHECK (false);
CREATE POLICY "recovery_pool_lease_participants_update" ON public.recovery_pool_lease_participants FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "recovery_pool_lease_participants_delete" ON public.recovery_pool_lease_participants FOR DELETE USING (false);

-- ---------------------------------------------------------------------------
-- Balanced pool-assignment enforcement (closes the Phase 1 "planned"
-- transactional-balance gap; directly serves "prevent double recovery of
-- the same allocated amount"). A source cam_expense_input's assignments may
-- never sum to MORE than its own amount — under-assignment (unassigned
-- remainder) is allowed and is what golden test "unassigned expense"
-- exercises; over-assignment would let the same dollar be recovered twice
-- from two different pools.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_cam_pool_assignment_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_input_id UUID := COALESCE(NEW.cam_expense_input_id, OLD.cam_expense_input_id);
  v_source_amount NUMERIC;
  v_assigned_total NUMERIC;
BEGIN
  SELECT amount INTO v_source_amount FROM public.cam_expense_inputs WHERE id = v_input_id;
  IF v_source_amount IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_assigned_total
    FROM public.cam_input_pool_assignments
   WHERE cam_expense_input_id = v_input_id;

  -- A small epsilon absorbs NUMERIC(18,6) vs NUMERIC(14,2) rounding between
  -- the source expense and its pool-assignment splits, not a real balance
  -- defect.
  IF v_assigned_total > v_source_amount + 0.01 THEN
    RAISE EXCEPTION 'Pool assignments for cam_expense_input % total % which exceeds its source amount % — an expense input may be split across pools only through balanced assignments that never exceed its own amount (prevents double recovery)', v_input_id, v_assigned_total, v_source_amount;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS cam_input_pool_assignments_enforce_balance ON public.cam_input_pool_assignments;
CREATE CONSTRAINT TRIGGER cam_input_pool_assignments_enforce_balance
  AFTER INSERT OR UPDATE ON public.cam_input_pool_assignments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_pool_assignment_balance();

-- ---------------------------------------------------------------------------
-- Explicit prior-adjustment / prior-credit states (product decision 4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cam_prior_period_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  recovery_period_id UUID NOT NULL REFERENCES public.recovery_periods(id) ON DELETE RESTRICT,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('prior_period_adjustment', 'prior_credit')),
  state TEXT NOT NULL CHECK (state IN ('KNOWN_ZERO', 'KNOWN_AMOUNT', 'UNKNOWN', 'NOT_APPLICABLE')),
  amount NUMERIC(14,2),
  source_reference TEXT,
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- amount is meaningful only in the KNOWN_AMOUNT state; every other state
  -- must not carry a numeric that could be mistaken for real data.
  CHECK ((state = 'KNOWN_AMOUNT' AND amount IS NOT NULL) OR (state <> 'KNOWN_AMOUNT' AND amount IS NULL)),
  UNIQUE (org_id, lease_id, recovery_period_id, adjustment_type)
);

CREATE INDEX IF NOT EXISTS idx_cam_prior_period_adjustments_lease
  ON public.cam_prior_period_adjustments(org_id, lease_id, recovery_period_id);

ALTER TABLE public.cam_prior_period_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cam_prior_period_adjustments_select" ON public.cam_prior_period_adjustments
  FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY "cam_prior_period_adjustments_insert" ON public.cam_prior_period_adjustments FOR INSERT WITH CHECK (false);
CREATE POLICY "cam_prior_period_adjustments_update" ON public.cam_prior_period_adjustments FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "cam_prior_period_adjustments_delete" ON public.cam_prior_period_adjustments FOR DELETE USING (false);

-- ---------------------------------------------------------------------------
-- Materializer identity hardening (product decision 5): materializer_version
-- folds into the canonical uniqueness tuple, not just a stored column. A
-- future mapping-logic version must re-materialize even if the source rule
-- hash is unchanged, rather than silently reusing a policy built by an
-- older, possibly-different mapping.
-- ---------------------------------------------------------------------------
ALTER TABLE public.lease_recovery_policies
  DROP CONSTRAINT IF EXISTS lease_recovery_policies_source_rule_hash_unique;
ALTER TABLE public.lease_recovery_policies
  ADD CONSTRAINT lease_recovery_policies_source_rule_identity_unique
  UNIQUE (org_id, source_rule_id, source_rule_hash, materializer_version);

-- Confidence + derivation-method tracking for effective-date resolution
-- (product decision 6). effective_date_source already records WHICH
-- source won; confidence records how certain that source is, so a
-- lease-commencement fallback (lower certainty than an explicit amendment
-- or an approved manual override) is visibly distinguishable downstream,
-- not silently treated as equally reliable.
ALTER TABLE public.lease_recovery_policies
  ADD COLUMN IF NOT EXISTS effective_date_confidence NUMERIC CHECK (effective_date_confidence IS NULL OR (effective_date_confidence >= 0 AND effective_date_confidence <= 1));

UPDATE public.lease_recovery_policies
   SET effective_date_confidence = CASE effective_date_source
     WHEN 'amendment_effective_date' THEN 1.0
     WHEN 'manual_override' THEN 1.0
     WHEN 'lease_commencement' THEN 0.7
     ELSE NULL
   END
 WHERE effective_date_confidence IS NULL AND effective_date_source IS NOT NULL;
