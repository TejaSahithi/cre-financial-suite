-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 1 (hardened),
-- migration 2 of 3: expense allocation/publication additions (blueprint
-- section 6.2) and recovery setup (blueprint section 6.3).
--
-- Identifier history: see migration 1 of 3's header (20269900000008_cam_blueprint_premises_area_foundation.sql) for the full
-- rationale. cam_expense_inputs, expense_classifications, and
-- lease_expense_rules are NOT altered or replaced.
--
-- Hardening applied on top of the original version (dropped and rewritten;
-- no real data existed):
--   1. Overlap prevention: EXCLUDE constraints on recovery_pool_scope_members
--      (a scope can't be a member of the same pool twice at once) and
--      lease_recovery_policies (a rule can't have two overlapping active
--      policy versions).
--   2. Numeric precision: expense_allocations.amount and
--      cam_input_pool_assignments.amount are NUMERIC(18,6) — internal
--      ledger precision per ADR-CAM-011 ("store at least 6 decimal places
--      internally; round only at configured ledger boundaries").
--      recovery_pools.currency is constrained to a 3-letter ISO-4217-shaped
--      code instead of free text.
--   3. FK delete behavior: recovery_pools.period_id and
--      cam_input_pool_assignments.recovery_pool_id are ON DELETE RESTRICT,
--      not CASCADE — deleting a recovery_period or recovery_pool must never
--      silently wipe out real pool-assignment/pool data.
--   5. Idempotency/natural uniqueness: recovery_calendars, recovery_periods,
--      and recovery_pools get natural-key unique constraints;
--      lease_recovery_policies gets a source_rule_updated_at freshness
--      column plus a uniqueness constraint on (org_id, source_rule_id,
--      source_rule_updated_at) — this is the literal idempotency key Phase
--      2's materialization RPC uses to detect "I already materialized this
--      exact rule version" versus "the rule changed, materialize again."
--      cam_input_pool_assignments gets (org_id, cam_expense_input_id,
--      recovery_pool_id) uniqueness so assigning the same input to the same
--      pool twice is a safe no-op, not a duplicate row.
--   6. Traceability: lease_recovery_policies gains source_evidence JSONB —
--      a FROZEN snapshot of the source rule's page/exact-text/confidence at
--      materialization time (never a live join back to the rule, which
--      could change later), mirroring the frozen-source-manifest principle
--      already used by cam_expense_inputs' source_*_updated_at columns.
--   8. Planned transactional enforcement that finalized allocations balance
--      to their source expense: a trigger on expense_allocations rejects
--      any state where SUM(amount) of 'finalized' rows for one expense_id
--      exceeds that expense's own amount. Under-allocation is a valid,
--      readiness-flaggable state (Phase 2C's "unbalanced allocations"
--      check) — only over-allocation is a hard, transactional error.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 6.3 Recovery setup (created first: later tables in this file reference
-- recovery_pools).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.recovery_calendars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  calendar_type TEXT NOT NULL DEFAULT 'calendar_year'
    CHECK (calendar_type IN ('calendar_year', 'fiscal_year', 'lease_year', 'custom')),
  fiscal_start_month INT NOT NULL DEFAULT 1 CHECK (fiscal_start_month BETWEEN 1 AND 12),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, property_id, name)
);

CREATE INDEX IF NOT EXISTS idx_recovery_calendars_org_property
  ON public.recovery_calendars(org_id, property_id);

CREATE TABLE IF NOT EXISTS public.recovery_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  calendar_id UUID NOT NULL REFERENCES public.recovery_calendars(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'soft_closed', 'locked')),
  soft_closed_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recovery_periods_window_check CHECK (end_date >= start_date),
  UNIQUE (org_id, calendar_id, start_date, end_date)
);

CREATE INDEX IF NOT EXISTS idx_recovery_periods_calendar
  ON public.recovery_periods(org_id, calendar_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS public.recovery_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- A pool may belong to one concrete recovery_period, OR be a reusable
  -- template (is_template=true, period_id NULL) that a later CAM run
  -- instantiates per period. RESTRICT (not CASCADE): deleting a
  -- recovery_period must never silently wipe its pools, which would in
  -- turn silently wipe any cam_runs referencing that period — a
  -- deliberate archival/void path is required instead.
  period_id UUID REFERENCES public.recovery_periods(id) ON DELETE RESTRICT,
  is_template BOOLEAN NOT NULL DEFAULT false,
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pool_type TEXT NOT NULL DEFAULT 'property' CHECK (pool_type IN ('property', 'building', 'custom')),
  -- scope_type/scope_id intentionally polymorphic (property | building |
  -- custom participant set) — no FK is possible on a polymorphic column,
  -- matching the existing computation_snapshots.scope_id precedent.
  -- Hierarchy validity is enforced by _shared/cam-engine-v2/validation/
  -- hierarchy.ts (Phase 2) at write time.
  scope_type TEXT NOT NULL DEFAULT 'property' CHECK (scope_type IN ('property', 'building', 'custom')),
  scope_id UUID,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recovery_pools_period_or_template_check CHECK (is_template OR period_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_recovery_pools_period ON public.recovery_pools(org_id, period_id);
CREATE INDEX IF NOT EXISTS idx_recovery_pools_property ON public.recovery_pools(org_id, property_id);
-- Natural uniqueness, split by is_template since the two rows mean
-- different things (a reusable template vs. one period's live instance).
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_pools_template_unique
  ON public.recovery_pools(org_id, property_id, name) WHERE is_template;
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_pools_instance_unique
  ON public.recovery_pools(org_id, period_id, property_id, name) WHERE NOT is_template;

CREATE TABLE IF NOT EXISTS public.recovery_pool_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pool_id UUID NOT NULL REFERENCES public.recovery_pools(id) ON DELETE CASCADE,
  expense_category_id UUID NOT NULL REFERENCES public.expense_categories(id) ON DELETE CASCADE,
  inclusion_mode TEXT NOT NULL DEFAULT 'include' CHECK (inclusion_mode IN ('include', 'exclude')),
  -- ADR-CAM-007: variability (gross-up eligibility) and controllability
  -- (cap eligibility) are separate classifications — see cam-calculator.ts's
  -- confirmed shouldGrossUpExpense (958-966), which currently conflates
  -- them via is_controllable. Defaults are 'unknown' so gross-up/caps stay
  -- blocked-with-exception (ADR-CAM-006) rather than silently assumed.
  variability_default TEXT NOT NULL DEFAULT 'unknown'
    CHECK (variability_default IN ('fixed', 'variable', 'semi_variable', 'unknown')),
  controllability_default TEXT NOT NULL DEFAULT 'unknown'
    CHECK (controllability_default IN ('controllable', 'uncontrollable', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pool_id, expense_category_id)
);

CREATE INDEX IF NOT EXISTS idx_recovery_pool_categories_pool ON public.recovery_pool_categories(pool_id);

CREATE TABLE IF NOT EXISTS public.recovery_pool_scope_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pool_id UUID NOT NULL REFERENCES public.recovery_pools(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('building', 'unit')),
  scope_id UUID NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  include_in_denominator BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recovery_pool_scope_members_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A scope cannot be a member of the same pool twice at the same instant.
  CONSTRAINT recovery_pool_scope_members_no_overlap
    EXCLUDE USING gist (
      pool_id WITH =,
      scope_type WITH =,
      scope_id WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS idx_recovery_pool_scope_members_pool
  ON public.recovery_pool_scope_members(pool_id, effective_from, effective_to);

-- Typed, effective-dated, approved recovery policy — the materialized,
-- executable projection of an approved lease_expense_rules row. This is
-- where the "effective-dated lease-rule enforcement" work folds in: a
-- policy is tied to the specific rule/rule-set it was materialized from
-- and, when applicable, to the amendment that produced it, with an
-- explicit supersession chain rather than the legacy row_status='superseded'
-- string convention (kept as-is on lease_expense_rules itself — this table
-- does not touch it).
CREATE TABLE IF NOT EXISTS public.lease_recovery_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  lease_version_id UUID REFERENCES public.lease_abstract_versions(id) ON DELETE SET NULL,
  lease_amendment_id UUID REFERENCES public.lease_amendments(id) ON DELETE SET NULL,
  source_rule_set_id UUID REFERENCES public.lease_expense_rule_sets(id) ON DELETE SET NULL,
  source_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  -- Freshness marker copied from lease_expense_rules.updated_at at
  -- materialization time — the literal idempotency key: re-materializing
  -- the SAME rule version (same updated_at) must be a safe no-op, not a
  -- duplicate row or an error.
  source_rule_updated_at TIMESTAMPTZ,
  -- Frozen snapshot of the source rule's evidence at materialization time
  -- (page, exact text, confidence, who/when approved) — never a live join
  -- back to lease_expense_rules, which could change or be re-approved
  -- later. Mirrors cam_expense_inputs' source_*_updated_at freezing
  -- pattern already established in this codebase.
  source_evidence JSONB,
  policy_type TEXT NOT NULL DEFAULT 'category_recovery'
    CHECK (policy_type IN ('category_recovery', 'pool_participation', 'direct_charge', 'exclusion')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  superseded_by_policy_id UUID REFERENCES public.lease_recovery_policies(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lease_recovery_policies_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A single rule cannot back two overlapping ACTIVE policy versions.
  -- Superseded rows (and manual policies with no source_rule_id) are
  -- excluded — cross-rule category conflicts (a different rule covering
  -- the same category/period) are a POLICY_CONFLICT readiness exception
  -- (Phase 2C), not a hard DB constraint, since detecting them requires
  -- reading policy_steps' category assignments.
  CONSTRAINT lease_recovery_policies_no_overlap
    EXCLUDE USING gist (
      lease_id WITH =,
      source_rule_id WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    ) WHERE (status <> 'superseded' AND source_rule_id IS NOT NULL),
  -- Idempotency key: re-materializing the same rule version must find
  -- this row, not create a duplicate.
  CONSTRAINT lease_recovery_policies_source_rule_version_unique
    UNIQUE (org_id, source_rule_id, source_rule_updated_at)
);

CREATE INDEX IF NOT EXISTS idx_lease_recovery_policies_lease
  ON public.lease_recovery_policies(org_id, lease_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_lease_recovery_policies_source_rule
  ON public.lease_recovery_policies(source_rule_id) WHERE source_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lease_recovery_policies_amendment
  ON public.lease_recovery_policies(lease_amendment_id) WHERE lease_amendment_id IS NOT NULL;

-- Ordered, deterministic policy steps (Appendix A catalog). parameters is
-- JSONB for step-specific config (cap rate, base-year amount, fee %, etc.);
-- source_evidence carries page/clause-text citation, mirroring the
-- page/exact_source_text pattern already used on lease_expense_rules,
-- since this repo does not model lease clauses as a separate table.
CREATE TABLE IF NOT EXISTS public.lease_recovery_policy_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL REFERENCES public.lease_recovery_policies(id) ON DELETE CASCADE,
  sequence INT NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN (
    'INCLUDE_CATEGORY', 'EXCLUDE_CATEGORY', 'DIRECT_ASSIGN', 'GROSS_UP_VARIABLE',
    'ADD_CAPITAL_AMORTIZATION', 'CALCULATE_SHARE', 'APPLY_BASE_YEAR', 'APPLY_EXPENSE_STOP',
    'APPLY_DEDUCTIBLE', 'APPLY_FLOOR', 'APPLY_CAP', 'ADD_MANAGEMENT_FEE', 'ADD_ADMIN_FEE',
    'PRORATE', 'RECONCILE_ESTIMATES'
  )),
  expense_category_id UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  pool_id UUID REFERENCES public.recovery_pools(id) ON DELETE SET NULL,
  selector TEXT,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_lease_recovery_policy_steps_policy
  ON public.lease_recovery_policy_steps(policy_id, sequence);

-- ---------------------------------------------------------------------------
-- 6.2 Expense allocation and publication (expense_allocations is the new
-- balanced-child-line layer beneath expense_classifications;
-- cam_input_pool_assignments reuses the EXISTING cam_expense_inputs table
-- rather than replacing it).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.expense_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'property' CHECK (scope_type IN ('property', 'building', 'unit')),
  scope_id UUID,
  category_id UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  -- Internal ledger precision (ADR-CAM-011) — round only at the final
  -- statement/charge-export boundary (cam_estimate_schedules /
  -- cam_charge_exports use NUMERIC(14,2), the cent-rounded presentation
  -- form).
  amount NUMERIC(18,6) NOT NULL,
  service_start DATE,
  service_end DATE,
  -- ADR-CAM-007: expense variability (gross-up) vs controllability (caps)
  -- as two independent classifications. 'unknown' variability blocks
  -- gross-up per the blueprint's own default product decision (section 19).
  variability TEXT NOT NULL DEFAULT 'unknown' CHECK (variability IN ('fixed', 'variable', 'semi_variable', 'unknown')),
  controllability TEXT NOT NULL DEFAULT 'unknown' CHECK (controllability IN ('controllable', 'uncontrollable', 'unknown')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'excluded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expense_allocations_service_window_check CHECK (service_end IS NULL OR service_start IS NULL OR service_end >= service_start)
);

CREATE INDEX IF NOT EXISTS idx_expense_allocations_expense ON public.expense_allocations(org_id, expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_allocations_scope ON public.expense_allocations(org_id, scope_type, scope_id, service_start, service_end);

-- Item 8: finalized allocations must never exceed their source expense's
-- amount. Under-allocation is a valid, readiness-flaggable state (Phase
-- 2C's "unbalanced allocations" check reads this same data); only
-- over-allocation is a hard, transactional error, since no amount of UI
-- review should ever be able to publish more dollars than the source
-- expense actually contains.
CREATE OR REPLACE FUNCTION public.check_expense_allocations_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_expense_amount NUMERIC;
  v_finalized_total NUMERIC;
  v_expense_id UUID := COALESCE(NEW.expense_id, OLD.expense_id);
BEGIN
  SELECT amount INTO v_expense_amount FROM public.expenses WHERE id = v_expense_id;
  IF v_expense_amount IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_finalized_total
    FROM public.expense_allocations
   WHERE expense_id = v_expense_id AND status = 'finalized';

  IF v_finalized_total > v_expense_amount THEN
    RAISE EXCEPTION 'Finalized expense allocations (%) exceed the source expense amount (%) for expense %',
      v_finalized_total, v_expense_amount, v_expense_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expense_allocations_balance_check ON public.expense_allocations;
CREATE TRIGGER expense_allocations_balance_check
  AFTER INSERT OR UPDATE OF amount, status ON public.expense_allocations
  FOR EACH ROW
  WHEN (NEW.status = 'finalized')
  EXECUTE FUNCTION public.check_expense_allocations_balance();

CREATE TABLE IF NOT EXISTS public.expense_allocation_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  allocation_id UUID NOT NULL REFERENCES public.expense_allocations(id) ON DELETE CASCADE,
  lease_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  recoverability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (recoverability IN ('recoverable', 'not_recoverable', 'conditional', 'unknown')),
  cam_eligible TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cam_eligible IN ('eligible', 'not_eligible', 'conditional', 'unknown')),
  decision_status TEXT NOT NULL DEFAULT 'draft' CHECK (decision_status IN ('draft', 'finalized', 'excluded')),
  reviewer UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_allocation_classifications_allocation
  ON public.expense_allocation_classifications(allocation_id);

-- Allows one published cam_expense_inputs row to split across multiple
-- recovery pools without duplicating the source amount. Reuses the
-- existing cam_expense_inputs table verbatim (per blueprint's own
-- "KEEP AS PUBLICATION LEDGER" verdict) rather than replacing it.
CREATE TABLE IF NOT EXISTS public.cam_input_pool_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cam_expense_input_id UUID NOT NULL REFERENCES public.cam_expense_inputs(id) ON DELETE CASCADE,
  -- RESTRICT (not CASCADE): deleting a pool must never silently discard a
  -- real dollar assignment made against it.
  recovery_pool_id UUID NOT NULL REFERENCES public.recovery_pools(id) ON DELETE RESTRICT,
  amount NUMERIC(18,6) NOT NULL,
  assignment_method TEXT NOT NULL DEFAULT 'automatic' CHECK (assignment_method IN ('automatic', 'manual')),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent assignment: assigning the same published input to the same
  -- pool twice is a safe no-op (upsert target), not a duplicate row.
  UNIQUE (org_id, cam_expense_input_id, recovery_pool_id)
);

CREATE INDEX IF NOT EXISTS idx_cam_input_pool_assignments_input
  ON public.cam_input_pool_assignments(cam_expense_input_id);
CREATE INDEX IF NOT EXISTS idx_cam_input_pool_assignments_pool
  ON public.cam_input_pool_assignments(recovery_pool_id);

-- RLS: same org-scoped-read / service-role-only-write pattern as
-- migration 1 of 3 and as this codebase's existing financial-ledger tables.
ALTER TABLE public.recovery_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_pool_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_pool_scope_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_recovery_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_recovery_policy_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_allocation_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_input_pool_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY recovery_calendars_select ON public.recovery_calendars FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY recovery_calendars_insert ON public.recovery_calendars FOR INSERT WITH CHECK (false);
CREATE POLICY recovery_calendars_update ON public.recovery_calendars FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY recovery_calendars_delete ON public.recovery_calendars FOR DELETE USING (false);

CREATE POLICY recovery_periods_select ON public.recovery_periods FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY recovery_periods_insert ON public.recovery_periods FOR INSERT WITH CHECK (false);
CREATE POLICY recovery_periods_update ON public.recovery_periods FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY recovery_periods_delete ON public.recovery_periods FOR DELETE USING (false);

CREATE POLICY recovery_pools_select ON public.recovery_pools FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY recovery_pools_insert ON public.recovery_pools FOR INSERT WITH CHECK (false);
CREATE POLICY recovery_pools_update ON public.recovery_pools FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY recovery_pools_delete ON public.recovery_pools FOR DELETE USING (false);

CREATE POLICY recovery_pool_categories_select ON public.recovery_pool_categories FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY recovery_pool_categories_insert ON public.recovery_pool_categories FOR INSERT WITH CHECK (false);
CREATE POLICY recovery_pool_categories_update ON public.recovery_pool_categories FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY recovery_pool_categories_delete ON public.recovery_pool_categories FOR DELETE USING (false);

CREATE POLICY recovery_pool_scope_members_select ON public.recovery_pool_scope_members FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY recovery_pool_scope_members_insert ON public.recovery_pool_scope_members FOR INSERT WITH CHECK (false);
CREATE POLICY recovery_pool_scope_members_update ON public.recovery_pool_scope_members FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY recovery_pool_scope_members_delete ON public.recovery_pool_scope_members FOR DELETE USING (false);

CREATE POLICY lease_recovery_policies_select ON public.lease_recovery_policies FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY lease_recovery_policies_insert ON public.lease_recovery_policies FOR INSERT WITH CHECK (false);
CREATE POLICY lease_recovery_policies_update ON public.lease_recovery_policies FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY lease_recovery_policies_delete ON public.lease_recovery_policies FOR DELETE USING (false);

CREATE POLICY lease_recovery_policy_steps_select ON public.lease_recovery_policy_steps FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY lease_recovery_policy_steps_insert ON public.lease_recovery_policy_steps FOR INSERT WITH CHECK (false);
CREATE POLICY lease_recovery_policy_steps_update ON public.lease_recovery_policy_steps FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY lease_recovery_policy_steps_delete ON public.lease_recovery_policy_steps FOR DELETE USING (false);

CREATE POLICY expense_allocations_select ON public.expense_allocations FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY expense_allocations_insert ON public.expense_allocations FOR INSERT WITH CHECK (false);
CREATE POLICY expense_allocations_update ON public.expense_allocations FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY expense_allocations_delete ON public.expense_allocations FOR DELETE USING (false);

CREATE POLICY expense_allocation_classifications_select ON public.expense_allocation_classifications FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY expense_allocation_classifications_insert ON public.expense_allocation_classifications FOR INSERT WITH CHECK (false);
CREATE POLICY expense_allocation_classifications_update ON public.expense_allocation_classifications FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY expense_allocation_classifications_delete ON public.expense_allocation_classifications FOR DELETE USING (false);

CREATE POLICY cam_input_pool_assignments_select ON public.cam_input_pool_assignments FOR SELECT USING (is_super_admin() OR is_member_of_org(org_id));
CREATE POLICY cam_input_pool_assignments_insert ON public.cam_input_pool_assignments FOR INSERT WITH CHECK (false);
CREATE POLICY cam_input_pool_assignments_update ON public.cam_input_pool_assignments FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY cam_input_pool_assignments_delete ON public.cam_input_pool_assignments FOR DELETE USING (false);
