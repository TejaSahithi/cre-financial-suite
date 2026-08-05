// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 2
// Correction 4: the CamRunInput contract, extended with the 10 additions
// requested before Phase 3 begins. This is the single frozen snapshot
// shape Phase 3's calculation engine reads — never a set of live queries
// re-run mid-calculation (ADR-CAM-005/006: calculation reads only the
// snapshot payload, corrections are new runs, nothing is silently
// re-derived).
import type {
  CamRun,
  RecoveryPeriod,
  RecoveryPool,
  RecoveryPoolCategory,
  RecoveryPoolScopeMember,
  RecoveryPoolLeaseParticipant,
  LeaseRecoveryPolicy,
  LeaseRecoveryPolicyStep,
  LeasePremises,
  LeasePremisesSpace,
  LeasePremisesAreaPeriod,
  SpaceAreaMeasurement,
  SpaceOccupancyPeriod,
  CamEstimateSchedule,
  CamPriorPeriodAdjustment,
  RoundingPolicy,
} from "./cam-domain-types.ts";

export type AreaUnit = "sqft" | "sqm";

export interface CamExpenseInputRow {
  id: string;
  amount: number;
  // Frozen human-readable label (e.g. 'Insurance'). Display/audit only —
  // specification 8.3: "Keep the text label only for display/audit
  // snapshots." Never match categories on this field.
  category: string | null;
  // Canonical expense category (public.expense_categories.id). This is the
  // ONLY authoritative key for category matching: recovery_pool_categories
  // and lease_recovery_policy_steps both key on this UUID, so comparing them
  // against `category` can never match (specification 8.3: "Do not compare a
  // category UUID with a text value such as Insurance"). NULL means the
  // source label could not be resolved to exactly one category and the row
  // must block via EXPENSE_CATEGORY_MISSING rather than be guessed.
  expense_category_id: string | null;
  publication_status: "published" | "withdrawn" | "superseded";
  publication_version: number;
  fiscal_year: number | null;
  property_id: string | null;
  building_id: string | null;
  unit_id: string | null;
  lease_id: string | null;
  cam_input_type: string | null;
  // Variability classification (see expense_allocations.variability from
  // the Phase 1 hardening migration) — required for gross-up: ADR-CAM-006/
  // blueprint section 19 default product decision, "Unknown expense
  // variability: Block gross-up and create review exception." Defaults to
  // 'unknown' at the contract level; the engine never treats 'unknown' as
  // 'fixed' to skip a review, or as 'variable' to gross it up.
  variability: "fixed" | "variable" | "semi_variable" | "unknown";
  // Controllability classification — ADR-CAM-007: caps apply to the
  // controllable portion only; variability and controllability are
  // independent (an expense may be variable-and-uncontrollable, fixed-
  // and-controllable, or any other combination). Defaults to 'unknown';
  // the engine never assumes controllable to apply a cap it shouldn't.
  controllability: "controllable" | "uncontrollable" | "unknown";
  // Addition: expense service/accounting period — when the dollars were
  // actually incurred, distinct from fiscal_year (a coarse annual bucket)
  // and distinct from when the input was published. Required for
  // service-period proration (blueprint section 8.2); an input with
  // neither bound populated cannot be prorated and must produce a
  // blocking exception rather than being treated as falling fully inside
  // every slice.
  service_period_start: string | null;
  service_period_end: string | null;
}

export interface PoolAssignmentInput {
  id: string;
  cam_expense_input_id: string;
  recovery_pool_id: string;
  // Addition: pool-assigned amounts OR percentages. cam_input_pool_
  // assignments.amount today is always a fixed dollar figure; percent_of_
  // source is carried for a future percentage-based split and is null
  // until that exists. The engine must validate whichever is actually
  // populated: dollar assignments across a source input must sum to that
  // input's amount (see expense_allocations' own balance trigger for the
  // analogous rule one layer up); percentage assignments must sum to 100.
  amount: number;
  percent_of_source: number | null;
}

export interface PriorCamHistoryEntry {
  // Addition: prior CAM/cap history. A cumulative or carryforward cap's
  // permitted amount for this year depends on what was actually posted
  // last year — this must come from a real prior POSTED run, never be
  // assumed zero or re-derived from the current pool.
  fiscal_year: number;
  lease_id: string;
  cam_run_id: string;
  permitted_controllable_amount: number;
  actual_controllable_amount: number;
  posted_at: string;
}

// Phase 3B product decisions 1/2: the ONLY authority for "is this lease
// eligible to recover from this pool" -- spatial/category overlap is never
// consulted by the engine as a substitute for a row here.
export type PoolLeaseParticipantInput = RecoveryPoolLeaseParticipant;

// Phase 3B product decision 4: explicit-state prior adjustments/credits,
// keyed by (lease_id, adjustment_type). UNKNOWN is a real, distinct value
// the engine must see and react to (warn in preview, block in a
// posting-eligible run) -- never silently treated as zero.
export type PriorPeriodAdjustmentInput = CamPriorPeriodAdjustment;

export interface BaseYearSourceSnapshot {
  // Addition: base-year source snapshot. The blueprint's own "Base-year
  // source requirement" (section 8.5): a base-year policy must reference a
  // normalized base-year pool or an approved fixed amount, frozen at the
  // time it was established — never a live re-query of that year's
  // expenses table, which may have been corrected/restated since.
  base_year: string;
  pool_id: string;
  category: string | null;
  normalized_amount: number;
  source_cam_run_id: string | null;
  captured_at: string;
}

export interface CamRunHeader {
  id: string;
  org_id: string;
  recovery_period_id: string;
  scope_type: "property" | "building" | "custom";
  scope_id: string | null;
  // Addition: run_type and adjustment/restatement references. A run must
  // declare, explicitly, whether it corrects an earlier one and exactly
  // which one — never inferred from "whatever the latest posted run
  // happens to be," which could silently pick up an unrelated later run.
  run_type: CamRun["run_type"];
  adjustment_of_run_id: string | null;
  restatement_of_run_id: string | null;
  engine_version: string;
  // Addition: currency. Every amount in this contract is denominated in
  // this currency; the engine must reject (not silently sum) an input
  // whose own currency, if ever tracked per-input, disagrees.
  currency: string;
  // Addition: allocation and area units. Every area figure in this
  // contract is in this unit; mixing sqft and sqm inputs in one run must
  // be a blocking exception, never a silent unit-less sum.
  area_unit: AreaUnit;
  rounding_policy: RoundingPolicy;
  // Phase 3B product decision 4: whether an UNKNOWN prior-adjustment state
  // merely warns (preview) or blocks the run from being ready_to_post
  // (posting_eligible). A preview run lets a reviewer see draft numbers
  // while the real adjustment/credit figures are still being tracked down;
  // a posting_eligible run must never post on top of an unresolved unknown.
  run_mode: "preview" | "posting_eligible";
}

export interface CamRunLeaseContext {
  id: string;
  premises: (LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] })[];
}

export interface CamRunInput {
  run: CamRunHeader;
  recovery_period: RecoveryPeriod;
  pools: (RecoveryPool & { categories: RecoveryPoolCategory[]; scope_members: RecoveryPoolScopeMember[] })[];
  published_expense_inputs: CamExpenseInputRow[];
  pool_assignments: PoolAssignmentInput[];
  // Phase 3B product decisions 1/2: the authoritative lease<->pool
  // eligibility grants. A lease with zero rows here participates in ZERO
  // pools, no matter how strongly its premises overlap a pool's spatial
  // scope.
  pool_lease_participants: PoolLeaseParticipantInput[];
  leases: CamRunLeaseContext[];
  area_measurements: SpaceAreaMeasurement[];
  occupancy_periods: SpaceOccupancyPeriod[];
  policies: (LeaseRecoveryPolicy & { steps: LeaseRecoveryPolicyStep[] })[];
  // Addition: CAM estimate schedules. What was already billed this period
  // — required for the RECONCILE_ESTIMATES step; never assumed zero when
  // schedule rows exist but weren't loaded.
  estimate_schedules: CamEstimateSchedule[];
  // Phase 3B product decision 4: replaces the old plain-number
  // priorApprovedAdjustments/priorCreditsApplied parameters. One entry per
  // (lease_id, adjustment_type) that actually has a recorded state; a
  // missing entry is itself treated as UNKNOWN by the reconciliation
  // module, never silently as zero.
  prior_period_adjustments: PriorPeriodAdjustmentInput[];
  prior_cam_history: PriorCamHistoryEntry[];
  base_year_snapshots: BaseYearSourceSnapshot[];
  // Addition: policy/materializer versions, keyed by policy id — lets the
  // engine (or a later readiness check) detect that a policy was
  // materialized by an older mapping version than the one currently
  // shipping, without re-deriving it from a live join.
  policy_materializer_versions: Record<string, string>;
  // The evaluate_cam_readiness() result for this exact (period, scope) as
  // of snapshot time — Phase 3 step 1 re-runs this live before using the
  // snapshot; it is captured here too so the persisted snapshot is
  // self-describing about what it saw.
  readiness_at_snapshot_time: unknown;
}
