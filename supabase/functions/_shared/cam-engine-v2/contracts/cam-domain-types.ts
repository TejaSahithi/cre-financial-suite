// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 1 domain
// types. Pure row-shape types for the 24 tables added by the three Phase 1
// migrations (20269900000008 / 20269900000009 / 20269900000010). No runtime
// logic here — this is documentation-as-types for the tables, matching the
// blueprint's proposed supabase/functions/_shared/cam-engine-v2/ layout.
// The calculation engine itself (contracts/cam-input.ts, cam-output.ts,
// policy-types.ts, and everything under time/ pools/ policies/ allocation/
// reconciliation/ ledger/ validation/) is Phase C, not built yet — nothing
// in this file is wired into compute-cam or cam-calculator.ts.

// ---------------------------------------------------------------------------
// 20269900000008 — premises, area, and occupancy foundation
// ---------------------------------------------------------------------------

export type PremisesType = "primary" | "expansion" | "contraction" | "relocation" | "storage" | "parking" | "other";
export type LeasePremisesStatus = "draft" | "approved" | "superseded";

// Phase 3B-C: provenance columns shared by every table the legacy backfill
// can write to — lets a reviewer always tell backfilled data apart from
// data a human explicitly entered/approved (migration 20269900000021).
export type BackfillSourceType = "primary" | "legacy_backfill";
export type BackfillReviewStatus = "not_required" | "needs_review" | "reviewed" | "rejected";

export interface BackfillProvenance {
  source_type: BackfillSourceType;
  backfill_confidence: number | null;
  backfill_derivation_method: string | null;
  review_status: BackfillReviewStatus;
}

export interface LeasePremises extends BackfillProvenance {
  id: string;
  org_id: string;
  lease_id: string;
  lease_version_id: string | null;
  lease_amendment_id: string | null;
  premises_type: PremisesType;
  effective_from: string; // date
  effective_to: string | null; // date
  status: LeasePremisesStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeasePremisesSpace {
  id: string;
  org_id: string;
  lease_premises_id: string;
  property_id: string;
  building_id: string | null;
  unit_id: string | null;
  allocation_weight: number;
  created_at: string;
  updated_at: string;
}

export type SpaceScopeType = "property" | "building" | "unit";
export type AreaType = "rentable" | "usable" | "gross" | "physical";

export interface SpaceAreaMeasurement extends BackfillProvenance {
  id: string;
  org_id: string;
  scope_type: SpaceScopeType;
  scope_id: string;
  area_type: AreaType;
  standard: string | null;
  area_sqft: number;
  effective_from: string;
  effective_to: string | null;
  source_id: string | null;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

export type AreaBasis = "rentable" | "usable" | "gross" | "fixed_contractual";

export interface LeasePremisesAreaPeriod {
  id: string;
  org_id: string;
  lease_premises_id: string;
  area_basis: AreaBasis;
  contractual_area_sqft: number | null;
  recovery_area_sqft: number | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export type OccupancyStatus = "occupied" | "vacant" | "owner_use" | "under_construction";

export interface SpaceOccupancyPeriod extends BackfillProvenance {
  id: string;
  org_id: string;
  scope_type: SpaceScopeType;
  scope_id: string;
  lease_id: string | null;
  occupancy_status: OccupancyStatus;
  occupied_area_sqft: number | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// 20269900000009 — expense allocation/publication additions + recovery setup
// ---------------------------------------------------------------------------

export type CalendarType = "calendar_year" | "fiscal_year" | "lease_year" | "custom";

export interface RecoveryCalendar {
  id: string;
  org_id: string;
  property_id: string | null;
  name: string;
  calendar_type: CalendarType;
  fiscal_start_month: number;
  timezone: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type RecoveryPeriodStatus = "draft" | "open" | "soft_closed" | "locked";

export interface RecoveryPeriod {
  id: string;
  org_id: string;
  calendar_id: string;
  start_date: string;
  end_date: string;
  label: string;
  status: RecoveryPeriodStatus;
  soft_closed_at: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PoolType = "property" | "building" | "custom";
export type PoolStatus = "draft" | "active" | "closed";

export interface RecoveryPool {
  id: string;
  org_id: string;
  period_id: string | null;
  is_template: boolean;
  property_id: string;
  name: string;
  pool_type: PoolType;
  scope_type: PoolType;
  scope_id: string | null;
  currency: string;
  status: PoolStatus;
  // Phase 3B product decision 3: optional pool-wide default gross-up
  // target. A lease's own GROSS_UP_VARIABLE policy step overrides this;
  // when neither is set, the pool is never grossed up.
  default_gross_up_target_pct: number | null;
  created_at: string;
  updated_at: string;
}

// Phase 3B product decisions 1 and 2: the AUTHORITATIVE record that a lease
// participates in a pool. Spatial/category matching (building/unit
// overlap) is a recommendation surface only, computed by the engine or a
// setup UI -- it is never read as authority for financial calculation.
// Without an active row here, a lease receives ZERO recovery from a pool
// no matter how plausible the spatial/category match looks.
export type PoolLeaseParticipantSource = "explicit" | "legacy_backfill";
export type PoolLeaseParticipantStatus = "active" | "ended";

export interface RecoveryPoolLeaseParticipant {
  id: string;
  org_id: string;
  pool_id: string;
  lease_id: string;
  effective_from: string;
  effective_to: string | null;
  source: PoolLeaseParticipantSource;
  status: PoolLeaseParticipantStatus;
  created_by: string | null;
  approved_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Phase 3B product decision 4: prior-period adjustments/credits use
// explicit states, never a bare nullable numeric that conflates "known to
// be zero" with "not yet determined."
export type PriorPeriodAdjustmentState = "KNOWN_ZERO" | "KNOWN_AMOUNT" | "UNKNOWN" | "NOT_APPLICABLE";
export type PriorPeriodAdjustmentType = "prior_period_adjustment" | "prior_credit";

export interface CamPriorPeriodAdjustment {
  id: string;
  org_id: string;
  lease_id: string;
  recovery_period_id: string;
  adjustment_type: PriorPeriodAdjustmentType;
  state: PriorPeriodAdjustmentState;
  amount: number | null;
  source_reference: string | null;
  recorded_by: string | null;
  recorded_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type Variability = "fixed" | "variable" | "semi_variable" | "unknown";
export type Controllability = "controllable" | "uncontrollable" | "unknown";
export type InclusionMode = "include" | "exclude";

export interface RecoveryPoolCategory {
  id: string;
  org_id: string;
  pool_id: string;
  expense_category_id: string;
  inclusion_mode: InclusionMode;
  variability_default: Variability;
  controllability_default: Controllability;
  created_at: string;
  updated_at: string;
}

export interface RecoveryPoolScopeMember {
  id: string;
  org_id: string;
  pool_id: string;
  scope_type: "building" | "unit";
  scope_id: string;
  effective_from: string;
  effective_to: string | null;
  include_in_denominator: boolean;
  created_at: string;
  updated_at: string;
}

export type PolicyType = "category_recovery" | "pool_participation" | "direct_charge" | "exclusion";
export type PolicyStatus = "draft" | "approved" | "rejected" | "superseded";

// Materialized, executable projection of an approved lease_expense_rules
// row — this is where the effective-dated / amendment-tied / superseded
// rule enforcement originally scoped directly onto lease_expense_rules now
// lives, per the fold-in decision made this phase.
export interface LeaseRecoveryPolicy {
  id: string;
  org_id: string;
  lease_id: string;
  lease_version_id: string | null;
  lease_amendment_id: string | null;
  source_rule_set_id: string | null;
  source_rule_id: string | null;
  // Informational freshness marker (lease_expense_rules has no auto-touch
  // trigger — do not rely on this for idempotency).
  source_rule_updated_at: string | null;
  // Correction 2: the real idempotency key — an md5 digest of every
  // financially relevant rule field the materialization mapping reads.
  // Unlike source_rule_updated_at, this does not change when a
  // non-financial field (e.g. notes) is edited.
  source_rule_hash: string | null;
  source_approved_at: string | null;
  // Version of the materialization mapping logic itself, distinct from the
  // rule's own version — lets a future change to the mapping be
  // distinguished from a change to the rule.
  materializer_version: string;
  // Frozen snapshot of the source rule's evidence (page, exact text,
  // confidence, approved_by/at) at materialization time. Never re-derived
  // from a live join — the rule may change or be re-approved later.
  source_evidence: Record<string, unknown> | null;
  policy_type: PolicyType;
  effective_from: string;
  effective_to: string | null;
  // Correction 3: where effective_from came from, never silently guessed.
  effective_date_source: "amendment_effective_date" | "lease_commencement" | "manual_override" | null;
  effective_date_reason: string | null;
  effective_date_approved_by: string | null;
  // Phase 3B product decision 6: how certain effective_date_source is — 1.0
  // for an explicit amendment or an approved manual override, 0.7 for a
  // lease-commencement fallback (lower certainty, restricted to base rules
  // with no conflicting amendment evidence at the RPC layer).
  effective_date_confidence: number | null;
  status: PolicyStatus;
  superseded_by_policy_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type PolicyStepType =
  | "INCLUDE_CATEGORY" | "EXCLUDE_CATEGORY" | "DIRECT_ASSIGN" | "GROSS_UP_VARIABLE"
  | "ADD_CAPITAL_AMORTIZATION" | "CALCULATE_SHARE" | "APPLY_BASE_YEAR" | "APPLY_EXPENSE_STOP"
  | "APPLY_DEDUCTIBLE" | "APPLY_FLOOR" | "APPLY_CAP" | "ADD_MANAGEMENT_FEE" | "ADD_ADMIN_FEE"
  | "PRORATE" | "RECONCILE_ESTIMATES";

export interface LeaseRecoveryPolicyStep {
  id: string;
  org_id: string;
  policy_id: string;
  sequence: number;
  step_type: PolicyStepType;
  expense_category_id: string | null;
  pool_id: string | null;
  selector: string | null;
  parameters: Record<string, unknown>;
  source_evidence: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type AllocationStatus = "draft" | "finalized" | "excluded";

export interface ExpenseAllocation {
  id: string;
  org_id: string;
  expense_id: string;
  scope_type: SpaceScopeType;
  scope_id: string | null;
  category_id: string | null;
  amount: number;
  service_start: string | null;
  service_end: string | null;
  variability: Variability;
  controllability: Controllability;
  status: AllocationStatus;
  created_at: string;
  updated_at: string;
}

export type AllocationRecoverability = "recoverable" | "not_recoverable" | "conditional" | "unknown";
export type AllocationCamEligible = "eligible" | "not_eligible" | "conditional" | "unknown";
export type AllocationDecisionStatus = "draft" | "finalized" | "excluded";

export interface ExpenseAllocationClassification {
  id: string;
  org_id: string;
  allocation_id: string;
  lease_rule_id: string | null;
  recoverability: AllocationRecoverability;
  cam_eligible: AllocationCamEligible;
  decision_status: AllocationDecisionStatus;
  reviewer: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AssignmentMethod = "automatic" | "manual";

// Splits one published cam_expense_inputs row across one or more recovery
// pools without duplicating the source amount. References the EXISTING
// cam_expense_inputs table (this migration set does not replace it).
export interface CamInputPoolAssignment {
  id: string;
  org_id: string;
  cam_expense_input_id: string;
  recovery_pool_id: string;
  amount: number;
  assignment_method: AssignmentMethod;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// 20269900000010 — CAM run ledger
// ---------------------------------------------------------------------------

export type CamRunType = "standard" | "adjustment" | "restatement" | "preview";
export type CamRunStatus =
  | "draft" | "readiness_failed" | "ready" | "calculating" | "calculated"
  | "under_review" | "submitted" | "approved" | "posted" | "superseded" | "voided";

/**
 * The boundary at which accumulated amounts are rounded to the ledger precision.
 *
 * SEGMENT            — round each effective-date segment's contribution independently
 *                      (pre-existing implicit behavior; now deprecated for annual CAM).
 * MONTH              — round at each calendar-month boundary (mandatory for monthly
 *                      estimate charges; optional for actuals).
 * LEASE_POOL_PERIOD  — aggregate all unrounded segment contributions per lease per pool
 *                      for the full recovery period, then round once (default for annual
 *                      CAM reconciliation per ADR-CAM-011 / Phase 4B decision 1).
 * LEASE_PERIOD       — aggregate across all pools for a lease, then round (use only when
 *                      a policy explicitly requires cross-pool netting before rounding).
 * STATEMENT          — defer rounding to statement generation (not supported for posted
 *                      runs; requires an approved policy override).
 */
export type RoundingScope =
  | "SEGMENT"
  | "MONTH"
  | "LEASE_POOL_PERIOD"
  | "LEASE_PERIOD"
  | "STATEMENT";

export interface RoundingPolicy {
  internal_decimal_places: number;
  ledger_decimal_places: number;
  residual_allocation: "largest_remainder" | string;
  /**
   * The rounding boundary applied to annual actual CAM recovery.
   * Defaults to LEASE_POOL_PERIOD — aggregate unrounded segment amounts
   * across the full recovery period, then round once at this boundary.
   * Monthly estimate charges always round at MONTH regardless of this value.
   */
  annual_rounding_scope: RoundingScope;
  /**
   * The rounding boundary applied to monthly CAM estimate charges.
   * Always MONTH; present explicitly so the engine and any caller can
   * assert it without re-deriving it from business logic.
   */
  estimate_rounding_scope: "MONTH";
}

export interface CamRun {
  id: string;
  org_id: string;
  recovery_period_id: string;
  scope_type: PoolType;
  scope_id: string | null;
  run_number: number;
  run_type: CamRunType;
  status: CamRunStatus;
  engine_version: string | null;
  input_hash: string | null;
  // ADR-CAM-011: internal calculation precision vs. final ledger rounding
  // configured per run, not hard-coded.
  rounding_policy: RoundingPolicy;
  created_by: string | null;
  approved_by: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CamRunInputSnapshot {
  id: string;
  org_id: string;
  cam_run_id: string;
  source_type: string;
  source_id: string;
  source_version: string | null;
  source_updated_at: string | null;
  payload_hash: string | null;
  created_at: string;
}

export interface CamRunPoolResult {
  id: string;
  org_id: string;
  cam_run_id: string;
  pool_id: string;
  actual_amount: number;
  excluded_amount: number;
  gross_up_adjustment: number;
  amortization: number;
  adjusted_pool: number;
  denominator_metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type CamRunLeaseResultStatus = "draft" | "calculated" | "reviewed" | "posted";

export interface CamRunLeaseResult {
  id: string;
  org_id: string;
  cam_run_id: string;
  lease_id: string;
  premises_period_id: string | null;
  final_recovery: number;
  estimates_billed: number;
  amount_due_credit: number;
  status: CamRunLeaseResultStatus;
  created_at: string;
  updated_at: string;
}

// line_type is deliberately a free string, not a union — see the migration
// header comment: the blueprint's own catalog (POOL_SOURCE, GROSS_UP,
// TENANT_SHARE, BASE_YEAR, CAP, ADMIN_FEE, ESTIMATE_RECON, ...) is
// illustrative, not exhaustive.
export interface CamRunCalculationLine {
  id: string;
  org_id: string;
  cam_run_id: string;
  lease_result_id: string | null;
  pool_result_id: string | null;
  sequence: number;
  line_type: string;
  category: string | null;
  formula_code: string | null;
  input_amount: number | null;
  output_amount: number | null;
  adjustment: number | null;
  policy_step_id: string | null;
  explanation: string | null;
  created_at: string;
}

export type ExceptionSeverity = "blocking" | "review_required" | "warning" | "info";
export type ExceptionResolutionStatus = "open" | "resolved" | "waived";

export interface CamRunException {
  id: string;
  org_id: string;
  cam_run_id: string;
  severity: ExceptionSeverity;
  code: string;
  entity_type: string | null;
  entity_id: string | null;
  message: string;
  resolution_status: ExceptionResolutionStatus;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

export type EstimateSource = "manual" | "imported" | "generated_from_budget";
export type EstimateStatus = "scheduled" | "billed" | "collected" | "void";

export interface CamEstimateSchedule {
  id: string;
  org_id: string;
  lease_id: string;
  recovery_period_id: string;
  month_date: string;
  amount: number;
  source: EstimateSource;
  status: EstimateStatus;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CamStatementStatus = "draft" | "issued" | "void";

export interface CamStatement {
  id: string;
  org_id: string;
  cam_run_id: string;
  lease_id: string;
  statement_version: number;
  storage_path: string | null;
  issued_at: string | null;
  status: CamStatementStatus;
  created_at: string;
  updated_at: string;
}

export type ChargeExportStatus = "pending" | "exported" | "failed";

export interface CamChargeExport {
  id: string;
  org_id: string;
  cam_run_id: string;
  lease_id: string;
  charge_type: string;
  amount: number;
  external_reference: string | null;
  export_status: ChargeExportStatus;
  created_at: string;
  updated_at: string;
}
