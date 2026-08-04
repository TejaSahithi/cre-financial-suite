-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 1 (hardened),
-- migration 3 of 3: CAM run ledger, calculation lines, exceptions,
-- estimates, statements, and charge exports (blueprint section 6.4).
--
-- Identifier history: see migration 1 of 3's header (20269900000008_cam_blueprint_premises_area_foundation.sql) for the full
-- rationale. cam_calculations is NOT altered or replaced.
--
-- Hardening applied on top of the original version (dropped and rewritten;
-- no real data existed):
--   2. Numeric precision + rounding metadata: internal ledger amounts
--      (pool results, lease results, calculation lines) are NUMERIC(18,6)
--      per ADR-CAM-011; final billed/exported amounts (estimate schedules,
--      charge exports — real dollars a tenant is actually charged) are
--      NUMERIC(14,2), the cent-rounded presentation form. cam_runs gains a
--      rounding_policy JSONB column (decimal places + residual-allocation
--      method), matching the blueprint's own CamRunInput.rounding_policy.
--   3. FK delete behavior: every ledger child table's cam_run_id/lease_id/
--      pool_id/recovery_period_id FK is now ON DELETE RESTRICT, not
--      CASCADE. Deleting a cam_run, recovery_period, pool, or lease must
--      never silently cascade-wipe the financial ledger built on top of
--      it — voiding/archival is the only sanctioned path, and that's a
--      status change, not a delete.
--   4. Corrected uniqueness dimensions: the "one active run per series"
--      index now partitions by run_type too, not just
--      (org, period, scope). Without this, a posted 'standard' run would
--      have blocked ever creating an 'adjustment' or 'restatement' run for
--      the same period/scope — but those are meant to coexist alongside
--      the run they correct, not replace its slot.
--   9. Immutability + valid status transitions: a BEFORE UPDATE trigger on
--      cam_runs enforces the status graph below and makes 'posted' fully
--      immutable except for the single posted -> superseded transition
--      (ADR-CAM-005: corrections are new runs, never edits to a posted
--      one). A second trigger, attached to every ledger child table
--      (pool/lease results, calculation lines, exceptions), blocks
--      UPDATE/DELETE once the parent run is posted/superseded/voided —
--      this matters because RPCs run as SECURITY DEFINER and would
--      otherwise bypass the RLS-only protection.
--
--   Status graph:
--     draft            -> readiness_failed | ready | voided
--     readiness_failed -> ready | draft | voided
--     ready            -> calculating | readiness_failed | voided
--     calculating      -> calculated | readiness_failed
--     calculated       -> under_review | calculating | voided
--     under_review     -> submitted | calculated | voided
--     submitted        -> approved | under_review | voided
--     approved         -> posted | under_review | voided
--     posted           -> superseded (ONLY; every other field is frozen)
--     superseded, voided -> (terminal, no further changes at all)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.cam_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- RESTRICT: deleting a recovery_period must never silently cascade-void
  -- an entire CAM run history built on top of it.
  recovery_period_id UUID NOT NULL REFERENCES public.recovery_periods(id) ON DELETE RESTRICT,
  -- scope_type/scope_id intentionally polymorphic, same precedent as
  -- computation_snapshots.scope_id and recovery_pools.scope_id elsewhere
  -- in this migration set.
  scope_type TEXT NOT NULL DEFAULT 'property' CHECK (scope_type IN ('property', 'building', 'custom')),
  scope_id UUID,
  run_number INT NOT NULL DEFAULT 1,
  run_type TEXT NOT NULL DEFAULT 'standard' CHECK (run_type IN ('standard', 'adjustment', 'restatement', 'preview')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'readiness_failed', 'ready', 'calculating', 'calculated',
    'under_review', 'submitted', 'approved', 'posted', 'superseded', 'voided'
  )),
  engine_version TEXT,
  input_hash TEXT,
  -- ADR-CAM-011: internal calculation precision vs. final ledger rounding
  -- are two distinct concerns, configured per run rather than hard-coded.
  rounding_policy JSONB NOT NULL DEFAULT '{"internal_decimal_places": 6, "ledger_decimal_places": 2, "residual_allocation": "largest_remainder"}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cam_runs_period_scope
  ON public.cam_runs(org_id, recovery_period_id, scope_type, scope_id);
-- ADR-CAM-005 (posted results are immutable) + blueprint stage 1 ("reject
-- duplicate active run unless preview"): at most one non-voided,
-- non-superseded run PER RUN TYPE per (org, period, scope). run_type is a
-- real partition dimension, not just a WHERE filter — a posted 'standard'
-- run and an in-flight 'adjustment' run for the same period/scope are
-- meant to coexist (the adjustment corrects the standard run, it doesn't
-- replace its slot). History is never deleted — a rerun supersedes,
-- matching the same pattern already used for
-- cam_expense_inputs.publication_status and computation_snapshots.status.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cam_runs_one_active_per_series
  ON public.cam_runs(org_id, recovery_period_id, scope_type, scope_id, run_type)
  WHERE run_type <> 'preview' AND status NOT IN ('voided', 'superseded');

CREATE OR REPLACE FUNCTION public.enforce_cam_run_immutability_and_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.status IN ('superseded', 'voided') THEN
    RAISE EXCEPTION 'CAM run % is in terminal status % and cannot be modified', OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'posted' THEN
    IF NEW.status IS DISTINCT FROM 'superseded' THEN
      RAISE EXCEPTION 'Posted CAM run % is immutable; only a transition to superseded is permitted (attempted status: %)', OLD.id, NEW.status;
    END IF;
    IF NEW.recovery_period_id IS DISTINCT FROM OLD.recovery_period_id
      OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
      OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
      OR NEW.run_number IS DISTINCT FROM OLD.run_number
      OR NEW.run_type IS DISTINCT FROM OLD.run_type
      OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
      OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
      OR NEW.rounding_policy IS DISTINCT FROM OLD.rounding_policy
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN
      RAISE EXCEPTION 'Posted CAM run % is immutable; only status may change (to superseded)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status IN ('readiness_failed', 'ready', 'voided')) OR
      (OLD.status = 'readiness_failed' AND NEW.status IN ('ready', 'draft', 'voided')) OR
      (OLD.status = 'ready' AND NEW.status IN ('calculating', 'readiness_failed', 'voided')) OR
      (OLD.status = 'calculating' AND NEW.status IN ('calculated', 'readiness_failed')) OR
      (OLD.status = 'calculated' AND NEW.status IN ('under_review', 'calculating', 'voided')) OR
      (OLD.status = 'under_review' AND NEW.status IN ('submitted', 'calculated', 'voided')) OR
      (OLD.status = 'submitted' AND NEW.status IN ('approved', 'under_review', 'voided')) OR
      (OLD.status = 'approved' AND NEW.status IN ('posted', 'under_review', 'voided'))
    ) THEN
      RAISE EXCEPTION 'Invalid CAM run status transition % -> % for run %', OLD.status, NEW.status, OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cam_runs_enforce_transitions ON public.cam_runs;
CREATE TRIGGER cam_runs_enforce_transitions
  BEFORE UPDATE ON public.cam_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_cam_run_immutability_and_transitions();

-- Shared guard for every ledger child table below: once the parent run is
-- posted/superseded/voided, none of its detail rows may be updated or
-- deleted either. This is enforced as a real trigger (not just RLS)
-- because RPCs run SECURITY DEFINER and would otherwise bypass an
-- RLS-only protection.
CREATE OR REPLACE FUNCTION public.enforce_cam_run_ledger_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run_status TEXT;
  v_run_id UUID := COALESCE(NEW.cam_run_id, OLD.cam_run_id);
BEGIN
  SELECT status INTO v_run_status FROM public.cam_runs WHERE id = v_run_id;
  IF v_run_status IN ('posted', 'superseded', 'voided') THEN
    RAISE EXCEPTION 'Cannot modify %: parent CAM run % is in immutable status %', TG_TABLE_NAME, v_run_id, v_run_status;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.cam_run_input_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_run_id UUID NOT NULL REFERENCES public.cam_runs(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  source_version TEXT,
  source_updated_at TIMESTAMPTZ,
  payload_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cam_run_input_snapshots_run ON public.cam_run_input_snapshots(cam_run_id);
DROP TRIGGER IF EXISTS cam_run_input_snapshots_immutable ON public.cam_run_input_snapshots;
CREATE TRIGGER cam_run_input_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.cam_run_input_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_run_ledger_immutability();

CREATE TABLE IF NOT EXISTS public.cam_run_pool_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_run_id UUID NOT NULL REFERENCES public.cam_runs(id) ON DELETE RESTRICT,
  pool_id UUID NOT NULL REFERENCES public.recovery_pools(id) ON DELETE RESTRICT,
  actual_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  excluded_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  gross_up_adjustment NUMERIC(18,6) NOT NULL DEFAULT 0,
  amortization NUMERIC(18,6) NOT NULL DEFAULT 0,
  adjusted_pool NUMERIC(18,6) NOT NULL DEFAULT 0,
  denominator_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cam_run_id, pool_id)
);

CREATE INDEX IF NOT EXISTS idx_cam_run_pool_results_run ON public.cam_run_pool_results(cam_run_id);
DROP TRIGGER IF EXISTS cam_run_pool_results_immutable ON public.cam_run_pool_results;
CREATE TRIGGER cam_run_pool_results_immutable
  BEFORE UPDATE OR DELETE ON public.cam_run_pool_results
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_run_ledger_immutability();

CREATE TABLE IF NOT EXISTS public.cam_run_lease_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_run_id UUID NOT NULL REFERENCES public.cam_runs(id) ON DELETE RESTRICT,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  premises_period_id UUID REFERENCES public.lease_premises_area_periods(id) ON DELETE SET NULL,
  final_recovery NUMERIC(18,6) NOT NULL DEFAULT 0,
  estimates_billed NUMERIC(18,6) NOT NULL DEFAULT 0,
  amount_due_credit NUMERIC(18,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'reviewed', 'posted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cam_run_id, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_cam_run_lease_results_run ON public.cam_run_lease_results(cam_run_id);
CREATE INDEX IF NOT EXISTS idx_cam_run_lease_results_lease ON public.cam_run_lease_results(org_id, lease_id);
DROP TRIGGER IF EXISTS cam_run_lease_results_immutable ON public.cam_run_lease_results;
CREATE TRIGGER cam_run_lease_results_immutable
  BEFORE UPDATE OR DELETE ON public.cam_run_lease_results
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_run_ledger_immutability();

-- Immutable explainability ledger (blueprint section 9 / ADR-CAM requires
-- every material operation to be reproducible without reading TypeScript).
-- line_type is intentionally free TEXT, not a narrow CHECK enum — the
-- blueprint's own catalog (POOL_SOURCE, GROSS_UP, TENANT_SHARE, BASE_YEAR,
-- CAP, ADMIN_FEE, ESTIMATE_RECON, ...) is illustrative, not exhaustive.
CREATE TABLE IF NOT EXISTS public.cam_run_calculation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_run_id UUID NOT NULL REFERENCES public.cam_runs(id) ON DELETE RESTRICT,
  lease_result_id UUID REFERENCES public.cam_run_lease_results(id) ON DELETE RESTRICT,
  pool_result_id UUID REFERENCES public.cam_run_pool_results(id) ON DELETE SET NULL,
  sequence INT NOT NULL,
  line_type TEXT NOT NULL,
  category TEXT,
  formula_code TEXT,
  input_amount NUMERIC(18,6),
  output_amount NUMERIC(18,6),
  adjustment NUMERIC(18,6),
  policy_step_id UUID REFERENCES public.lease_recovery_policy_steps(id) ON DELETE SET NULL,
  explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cam_run_calculation_lines_run ON public.cam_run_calculation_lines(cam_run_id);
CREATE INDEX IF NOT EXISTS idx_cam_run_calculation_lines_lease_result
  ON public.cam_run_calculation_lines(lease_result_id, sequence);
DROP TRIGGER IF EXISTS cam_run_calculation_lines_immutable ON public.cam_run_calculation_lines;
CREATE TRIGGER cam_run_calculation_lines_immutable
  BEFORE UPDATE OR DELETE ON public.cam_run_calculation_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_run_ledger_immutability();

CREATE TABLE IF NOT EXISTS public.cam_run_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_run_id UUID NOT NULL REFERENCES public.cam_runs(id) ON DELETE RESTRICT,
  severity TEXT NOT NULL DEFAULT 'blocking' CHECK (severity IN ('blocking', 'review_required', 'warning', 'info')),
  code TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  message TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'resolved', 'waived')),
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cam_run_exceptions_run ON public.cam_run_exceptions(cam_run_id, resolution_status);
DROP TRIGGER IF EXISTS cam_run_exceptions_immutable ON public.cam_run_exceptions;
CREATE TRIGGER cam_run_exceptions_immutable
  BEFORE UPDATE OR DELETE ON public.cam_run_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_run_ledger_immutability();

CREATE TABLE IF NOT EXISTS public.cam_estimate_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  -- RESTRICT: a recovery_period with real billed estimate history attached
  -- must not be silently deletable.
  recovery_period_id UUID NOT NULL REFERENCES public.recovery_periods(id) ON DELETE RESTRICT,
  month_date DATE NOT NULL,
  -- Real, cent-precision billed dollars — not internal calculation
  -- precision.
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'imported', 'generated_from_budget')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'billed', 'collected', 'void')),
  exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, recovery_period_id, month_date)
);

CREATE INDEX IF NOT EXISTS idx_cam_estimate_schedules_lease
  ON public.cam_estimate_schedules(org_id, lease_id, recovery_period_id);

CREATE TABLE IF NOT EXISTS public.cam_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_run_id UUID NOT NULL REFERENCES public.cam_runs(id) ON DELETE RESTRICT,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  statement_version INT NOT NULL DEFAULT 1,
  storage_path TEXT,
  issued_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cam_run_id, lease_id, statement_version)
);

CREATE INDEX IF NOT EXISTS idx_cam_statements_run ON public.cam_statements(cam_run_id);
DROP TRIGGER IF EXISTS cam_statements_immutable ON public.cam_statements;
CREATE TRIGGER cam_statements_immutable
  BEFORE UPDATE OR DELETE ON public.cam_statements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_run_ledger_immutability();

CREATE TABLE IF NOT EXISTS public.cam_charge_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_run_id UUID NOT NULL REFERENCES public.cam_runs(id) ON DELETE RESTRICT,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  charge_type TEXT NOT NULL DEFAULT 'cam_recovery',
  amount NUMERIC(14,2) NOT NULL,
  external_reference TEXT,
  export_status TEXT NOT NULL DEFAULT 'pending' CHECK (export_status IN ('pending', 'exported', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cam_charge_exports_run ON public.cam_charge_exports(cam_run_id);
DROP TRIGGER IF EXISTS cam_charge_exports_immutable ON public.cam_charge_exports;
CREATE TRIGGER cam_charge_exports_immutable
  BEFORE UPDATE OR DELETE ON public.cam_charge_exports
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cam_run_ledger_immutability();

-- RLS: same org-scoped-read / service-role-only-write pattern as
-- migrations 1 and 2 of 3.
ALTER TABLE public.cam_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_run_input_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_run_pool_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_run_lease_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_run_calculation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_run_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_estimate_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_charge_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY cam_runs_select ON public.cam_runs FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_runs_insert ON public.cam_runs FOR INSERT WITH CHECK (false);
CREATE POLICY cam_runs_update ON public.cam_runs FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_runs_delete ON public.cam_runs FOR DELETE USING (false);

CREATE POLICY cam_run_input_snapshots_select ON public.cam_run_input_snapshots FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_run_input_snapshots_insert ON public.cam_run_input_snapshots FOR INSERT WITH CHECK (false);
CREATE POLICY cam_run_input_snapshots_update ON public.cam_run_input_snapshots FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_run_input_snapshots_delete ON public.cam_run_input_snapshots FOR DELETE USING (false);

CREATE POLICY cam_run_pool_results_select ON public.cam_run_pool_results FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_run_pool_results_insert ON public.cam_run_pool_results FOR INSERT WITH CHECK (false);
CREATE POLICY cam_run_pool_results_update ON public.cam_run_pool_results FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_run_pool_results_delete ON public.cam_run_pool_results FOR DELETE USING (false);

CREATE POLICY cam_run_lease_results_select ON public.cam_run_lease_results FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_run_lease_results_insert ON public.cam_run_lease_results FOR INSERT WITH CHECK (false);
CREATE POLICY cam_run_lease_results_update ON public.cam_run_lease_results FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_run_lease_results_delete ON public.cam_run_lease_results FOR DELETE USING (false);

CREATE POLICY cam_run_calculation_lines_select ON public.cam_run_calculation_lines FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_run_calculation_lines_insert ON public.cam_run_calculation_lines FOR INSERT WITH CHECK (false);
CREATE POLICY cam_run_calculation_lines_update ON public.cam_run_calculation_lines FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_run_calculation_lines_delete ON public.cam_run_calculation_lines FOR DELETE USING (false);

CREATE POLICY cam_run_exceptions_select ON public.cam_run_exceptions FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_run_exceptions_insert ON public.cam_run_exceptions FOR INSERT WITH CHECK (false);
CREATE POLICY cam_run_exceptions_update ON public.cam_run_exceptions FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_run_exceptions_delete ON public.cam_run_exceptions FOR DELETE USING (false);

CREATE POLICY cam_estimate_schedules_select ON public.cam_estimate_schedules FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_estimate_schedules_insert ON public.cam_estimate_schedules FOR INSERT WITH CHECK (false);
CREATE POLICY cam_estimate_schedules_update ON public.cam_estimate_schedules FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_estimate_schedules_delete ON public.cam_estimate_schedules FOR DELETE USING (false);

CREATE POLICY cam_statements_select ON public.cam_statements FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_statements_insert ON public.cam_statements FOR INSERT WITH CHECK (false);
CREATE POLICY cam_statements_update ON public.cam_statements FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_statements_delete ON public.cam_statements FOR DELETE USING (false);

CREATE POLICY cam_charge_exports_select ON public.cam_charge_exports FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_charge_exports_insert ON public.cam_charge_exports FOR INSERT WITH CHECK (false);
CREATE POLICY cam_charge_exports_update ON public.cam_charge_exports FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_charge_exports_delete ON public.cam_charge_exports FOR DELETE USING (false);
