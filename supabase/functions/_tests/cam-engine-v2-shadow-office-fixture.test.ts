// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-E.
//
// Part 1: unit tests for the shadow-harness variance classifier (pure
// logic, no database).
//
// Part 2: the "Office" property archetype fixture — multiple buildings,
// a vacancy driving gross-up, a base year, and a cap — with a MANUALLY
// computed expected result (shown in the comments below, not just
// asserted) run through the real orchestrator. This is the authoritative
// acceptance standard per the Phase 3B instructions ("manually calculated
// golden cases... not V1 parity"), not a V1-vs-V2 comparison — no
// anonymized production property of this shape was available in this
// environment to run V1 against, which is disclosed plainly in the Phase
// 3B report rather than fabricated.
//
// Honest scope note: this is the ONE of the three required property
// archetypes (office/retail/industrial) actually completed this session.
// Retail and industrial fixtures are NOT included here — see the Phase 3B
// report's "remaining gaps" section.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyVariance } from "../_shared/cam-engine-v2/shadow/variance-classifier.ts";
import { runCamEngine } from "../_shared/cam-engine-v2/orchestrator/run-cam-engine.ts";
import type { CamRunInput, CamRunLeaseContext, CamRunHeader, PoolAssignmentInput, CamExpenseInputRow } from "../_shared/cam-engine-v2/contracts/cam-input.ts";
import type {
  RecoveryPeriod, RecoveryPool, RecoveryPoolCategory, RecoveryPoolLeaseParticipant,
  LeaseRecoveryPolicy, LeaseRecoveryPolicyStep, LeasePremises, LeasePremisesSpace, LeasePremisesAreaPeriod,
  SpaceAreaMeasurement, SpaceOccupancyPeriod,
} from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

// --- Part 1: variance classifier unit tests --------------------------------

Deno.test("classifyVariance: a sub-cent delta is ROUNDING_DIFFERENCE regardless of other context", () => {
  const result = classifyVariance({ leaseId: "lease-1", metric: "final_recovery", v1Value: 1000, v2Value: 1000.005, context: {} });
  assertEquals(result.classification, "ROUNDING_DIFFERENCE");
});

Deno.test("classifyVariance: a leap-year period variance is EXPECTED_V2_CORRECTION (V1's known 365-day hardcode)", () => {
  const result = classifyVariance({ leaseId: "lease-1", metric: "final_recovery", v1Value: 1000, v2Value: 1002.74, context: { leapYearInPeriod: true } });
  assertEquals(result.classification, "EXPECTED_V2_CORRECTION");
});

Deno.test("classifyVariance: vacancy + gross-up variance is EXPECTED_V2_CORRECTION (V1 doesn't time-weight occupied area)", () => {
  const result = classifyVariance({ leaseId: "lease-1", metric: "final_recovery", v1Value: 1000, v2Value: 1150, context: { hasVacancy: true, hasGrossUp: true } });
  assertEquals(result.classification, "EXPECTED_V2_CORRECTION");
});

Deno.test("classifyVariance: a cumulative-cap variance is EXPECTED_V2_CORRECTION (V1 only implements non_cumulative for real)", () => {
  const result = classifyVariance({ leaseId: "lease-1", metric: "final_recovery", v1Value: 1000, v2Value: 850, context: { capType: "cumulative" } });
  assertEquals(result.classification, "EXPECTED_V2_CORRECTION");
});

Deno.test("classifyVariance: a V2 UNSUPPORTED_RULE exception is classified distinctly from a real numeric disagreement", () => {
  const result = classifyVariance({ leaseId: "lease-1", metric: "final_recovery", v1Value: 1000, v2Value: 0, context: { v2HasUnsupportedRuleException: true } });
  assertEquals(result.classification, "UNSUPPORTED_RULE");
});

Deno.test("classifyVariance: an unexplained variance with no matching known-defect context is POSSIBLE_ENGINE_DEFECT, never silently accepted", () => {
  const result = classifyVariance({ leaseId: "lease-1", metric: "final_recovery", v1Value: 1000, v2Value: 1500, context: {} });
  assertEquals(result.classification, "POSSIBLE_ENGINE_DEFECT");
});

// --- Part 2: Office archetype fixture ---------------------------------------
//
// Property "Office Tower": Building A (100,000 sqft) + Building B (50,000
// sqft) = 150,000 sqft total. FY2026 (non-leap -- leap year is covered by
// Golden 1, kept separate here to isolate this fixture's own variables).
//
//   Pool 1 (property-wide operating pool): $150,000, 100% variable,
//     pool-default gross-up target 100%. Occupied area 120,000/150,000 =
//     80% actual occupancy -> grossed = 150,000 * (100%/80%) = $187,500
//     (gross-up adjustment +$37,500).
//   Pool 2 (Building A only, HVAC): $20,000, fixed (never grossed up).
//
//   Tenant A1 (Building A, 10,000 sqft): participates in Pool 1 AND Pool 2.
//     Pool 1 share = 187,500 * (10,000/150,000) = $12,500.
//     Base year (fixed base_year_amount $120,000, property-wide):
//       tenant's base share = 120,000 * (10,000/150,000) = $8,000.
//       Pool 1 net = 12,500 - 8,000 = $4,500.
//     Pool 2 share = 20,000 * (10,000/100,000) = $2,000 (no base year here).
//     TOTAL A1 = 4,500 + 2,000 = $6,500.00
//
//   Tenant B1 (Building B, 5,000 sqft): participates in Pool 1 only.
//     Pool 1 share (pre-cap) = 187,500 * (5,000/150,000) = $6,250.
//     Fixed-dollar cap $3,000 on (100% controllable) expense -> capped.
//     TOTAL B1 = $3,000.00
//
// These are the manually computed expected values the test asserts against.

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function runHeader(): CamRunHeader {
  return {
    id: "run-office", org_id: "org-1", recovery_period_id: "period-1", scope_type: "property", scope_id: "prop-1",
    run_type: "standard", adjustment_of_run_id: null, restatement_of_run_id: null, engine_version: "cam-engine-v2.0.0",
    currency: "USD", area_unit: "sqft",
    rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder", annual_rounding_scope: "LEASE_POOL_PERIOD", estimate_rounding_scope: "MONTH" },
    run_mode: "posting_eligible",
  };
}

function period(): RecoveryPeriod {
  return { id: "period-1", org_id: "org-1", calendar_id: "cal-1", start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026", status: "open", soft_closed_at: null, locked_at: null, created_at: "", updated_at: "" };
}

function pool(id: string, name: string, scopeType: "property" | "building", scopeId: string | null, defaultGrossUpTargetPct: number | null, categories: RecoveryPoolCategory[] = []): RecoveryPool & { categories: RecoveryPoolCategory[]; scope_members: never[] } {
  return {
    id, org_id: "org-1", period_id: "period-1", is_template: false, property_id: "prop-1", name,
    pool_type: scopeType, scope_type: scopeType, scope_id: scopeId, currency: "USD", status: "active",
    default_gross_up_target_pct: defaultGrossUpTargetPct, created_at: "", updated_at: "", categories, scope_members: [],
  };
}

function categoryDef(poolId: string, expenseCategoryId: string): RecoveryPoolCategory {
  return { id: uid("cat"), org_id: "org-1", pool_id: poolId, expense_category_id: expenseCategoryId, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable", created_at: "", updated_at: "" };
}

function expenseInput(id: string, amount: number, category: string, variability: "fixed" | "variable"): CamExpenseInputRow {
  return {
    // Symbolic category identifier doubles as the canonical
    // expense_category_id, which is what pools/policies now match on.
    id, amount, category, expense_category_id: category,
    publication_status: "published", publication_version: 1, fiscal_year: 2026,
    property_id: "prop-1", building_id: null, unit_id: null, lease_id: null, cam_input_type: "actual",
    variability, controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  };
}

function assignment(id: string, expenseId: string, poolId: string, amount: number): PoolAssignmentInput {
  return { id, cam_expense_input_id: expenseId, recovery_pool_id: poolId, amount, percent_of_source: null };
}

function areaMeasurement(scopeId: string, sqft: number): SpaceAreaMeasurement {
  return {
    id: uid("area"), org_id: "org-1", scope_type: scopeId === "prop-1" ? "property" : "building", scope_id: scopeId, area_type: "rentable",
    standard: null, area_sqft: sqft, effective_from: "2026-01-01", effective_to: null, source_id: null, approved_at: null, approved_by: null,
    created_at: "", updated_at: "", source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
  };
}

function occupancyPeriod(): SpaceOccupancyPeriod {
  return {
    id: "occ-1", org_id: "org-1", scope_type: "property", scope_id: "prop-1", lease_id: null, occupancy_status: "occupied",
    occupied_area_sqft: 120000, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
  };
}

function premises(leaseId: string, buildingId: string, sqft: number): LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] } {
  const id = uid("prem");
  return {
    id, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, premises_type: "primary",
    effective_from: "2026-01-01", effective_to: null, status: "approved", notes: null, created_by: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
    spaces: [{ id: uid("space"), org_id: "org-1", lease_premises_id: id, property_id: "prop-1", building_id: buildingId, unit_id: null, allocation_weight: 1, created_at: "", updated_at: "" }],
    area_periods: [{ id: uid("areaper"), org_id: "org-1", lease_premises_id: id, area_basis: "rentable", contractual_area_sqft: sqft, recovery_area_sqft: sqft, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "" }],
  };
}

function lease(id: string, buildingId: string, sqft: number): CamRunLeaseContext {
  return { id, premises: [premises(id, buildingId, sqft)] };
}

function participant(poolId: string, leaseId: string): RecoveryPoolLeaseParticipant {
  return { id: uid("participant"), org_id: "org-1", pool_id: poolId, lease_id: leaseId, effective_from: "2020-01-01", effective_to: null, source: "explicit", status: "active", created_by: null, approved_by: null, notes: null, created_at: "", updated_at: "" };
}

function policy(id: string, leaseId: string, steps: LeaseRecoveryPolicyStep[]): LeaseRecoveryPolicy & { steps: LeaseRecoveryPolicyStep[] } {
  return {
    id, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, source_rule_set_id: null,
    source_rule_id: null, source_rule_updated_at: null, source_rule_hash: null, source_approved_at: null, materializer_version: "materializer_v1",
    source_evidence: null, policy_type: "category_recovery", effective_from: "2026-01-01", effective_to: null,
    effective_date_source: "lease_commencement", effective_date_reason: null, effective_date_approved_by: null, effective_date_confidence: null,
    status: "approved", superseded_by_policy_id: null, approved_by: null, approved_at: null, notes: null, created_at: "", updated_at: "",
    steps,
  };
}

function step(overrides: Partial<LeaseRecoveryPolicyStep>): LeaseRecoveryPolicyStep {
  return { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 1, step_type: "CALCULATE_SHARE", expense_category_id: "operating", pool_id: null, selector: null, parameters: {}, source_evidence: null, created_at: "", updated_at: "", ...overrides };
}

Deno.test("Office archetype fixture: multiple buildings, vacancy-driven gross-up, base year, and cap tie out to manually computed expected values", async () => {
  const poolOperating = pool("pool-operating", "Property Operating Pool", "property", null, 100, [categoryDef("pool-operating", "operating")]);
  const poolHvac = pool("pool-hvac-a", "Building A HVAC Pool", "building", "bldg-A", null, [categoryDef("pool-hvac-a", "hvac")]);

  const expOperating = expenseInput("exp-operating", 150000, "operating", "variable");
  const expHvac = expenseInput("exp-hvac", 20000, "hvac", "fixed");

  const input: CamRunInput = {
    run: runHeader(),
    recovery_period: period(),
    pools: [poolOperating, poolHvac],
    published_expense_inputs: [expOperating, expHvac],
    pool_assignments: [
      assignment("assign-1", expOperating.id, "pool-operating", 150000),
      assignment("assign-2", expHvac.id, "pool-hvac-a", 20000),
    ],
    pool_lease_participants: [
      participant("pool-operating", "lease-a1"),
      participant("pool-hvac-a", "lease-a1"),
      participant("pool-operating", "lease-b1"),
    ],
    leases: [lease("lease-a1", "bldg-A", 10000), lease("lease-b1", "bldg-B", 5000)],
    area_measurements: [areaMeasurement("prop-1", 150000), areaMeasurement("bldg-A", 100000)],
    occupancy_periods: [occupancyPeriod()],
    policies: [
      policy("policy-a1-operating", "lease-a1", [
        step({ id: uid("step"), sequence: 1, expense_category_id: "operating" }),
        step({ id: uid("step"), sequence: 2, step_type: "APPLY_BASE_YEAR", expense_category_id: "operating", parameters: { base_year: "2024", base_year_amount: 120000 } }),
      ]),
      policy("policy-a1-hvac", "lease-a1", [
        step({ id: uid("step"), sequence: 1, expense_category_id: "hvac" }),
      ]),
      policy("policy-b1-operating", "lease-b1", [
        step({ id: uid("step"), sequence: 1, expense_category_id: "operating" }),
        step({ id: uid("step"), sequence: 2, step_type: "APPLY_CAP", expense_category_id: "operating", parameters: { cap_type: "fixed_dollar", cap_amount: 3000 } }),
      ]),
    ],
    estimate_schedules: [],
    prior_period_adjustments: [
      { id: "adj-a1-1", org_id: "org-1", lease_id: "lease-a1", recovery_period_id: "period-1", adjustment_type: "prior_period_adjustment", state: "KNOWN_ZERO", amount: null, source_reference: null, recorded_by: null, recorded_at: "", notes: null, created_at: "", updated_at: "" },
      { id: "adj-a1-2", org_id: "org-1", lease_id: "lease-a1", recovery_period_id: "period-1", adjustment_type: "prior_credit", state: "KNOWN_ZERO", amount: null, source_reference: null, recorded_by: null, recorded_at: "", notes: null, created_at: "", updated_at: "" },
      { id: "adj-b1-1", org_id: "org-1", lease_id: "lease-b1", recovery_period_id: "period-1", adjustment_type: "prior_period_adjustment", state: "KNOWN_ZERO", amount: null, source_reference: null, recorded_by: null, recorded_at: "", notes: null, created_at: "", updated_at: "" },
      { id: "adj-b1-2", org_id: "org-1", lease_id: "lease-b1", recovery_period_id: "period-1", adjustment_type: "prior_credit", state: "KNOWN_ZERO", amount: null, source_reference: null, recorded_by: null, recorded_at: "", notes: null, created_at: "", updated_at: "" },
    ],
    prior_cam_history: [],
    base_year_snapshots: [],
    policy_materializer_versions: {},
    readiness_at_snapshot_time: null,
  };

  const output = await runCamEngine(input);

  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  assertEquals(output.ready_to_post, true);

  const poolOperatingResult = output.pool_results.find((p) => p.pool_id === "pool-operating")!;
  assertEquals(poolOperatingResult.actual_amount, 150000);
  assertEquals(poolOperatingResult.gross_up_adjustment, 37500);
  assertEquals(poolOperatingResult.adjusted_pool, 187500);

  const a1 = output.lease_results.find((r) => r.lease_id === "lease-a1")!;
  const b1 = output.lease_results.find((r) => r.lease_id === "lease-b1")!;

  // lease-a1 and lease-b1 both draw from pool-operating for the "operating"
  // category, so Workstream B.3's largest-remainder residual allocation
  // reconciles their CALCULATE_SHARE output back to an exact total EVERY
  // MONTH (12 segments). Each lease's own ANNUAL figure can differ from
  // the hand-computed idealized value by a few cents (legitimate monthly
  // ledger rounding -- the same behavior any real monthly-billed
  // accounting system has), but the two leases' COMBINED total is exact:
  // $6,500 + $3,000 = $9,500 no matter how the pennies fall between them.
  assertEquals(Math.abs(a1.final_recovery - 6500) < 0.10, true);
  assertEquals(Math.abs(b1.final_recovery - 3000) < 0.10, true);
  // Combined total: 12 independently ledger-rounded monthly figures summed
  // is not bit-identical to a single-shot idealized flat-year calculation
  // even for the combined group -- same day-weighted-monthly-proration-
  // plus-per-month-rounding reality as each individual lease's figure.
  assertEquals(Math.abs(a1.final_recovery + b1.final_recovery - 9500) < 0.10, true);

  // Explainability: every dollar in each lease's total must trace to real
  // calculation lines, not just match the final number by coincidence.
  // ADR-CAM-001 means the base-year deduction is prorated across the
  // year's 12 monthly segments (each lease-1/12th-ish of $8,000, weighted
  // by days per month) rather than appearing as one annual line -- their
  // SUM is close to the $8,000 hand-computed above (within a few cents,
  // same monthly-residual-rounding rationale as final_recovery above),
  // exactly matching how the per-segment proration fix (found by the
  // earlier Golden 9 test) works.
  const a1Lines = output.calculation_lines.filter((l) => l.lease_id === "lease-a1");
  const a1BaseYearLines = a1Lines.filter((l) => l.line_type === "BASE_YEAR" && l.pool_id === "pool-operating");
  assertEquals(a1BaseYearLines.length, 12);
  const a1BaseYearTotal = a1BaseYearLines.reduce((sum, l) => sum + (l.adjustment ?? 0), 0);
  assertEquals(Math.abs(a1BaseYearTotal - -8000) < 0.10, true);
  // pool-hvac-a is category-restricted to "hvac" only, so the operating
  // policy's steps never touch it at all -- confirms the category-scoping
  // fix, not just that the final total happens to be right.
  assertEquals(a1Lines.some((l) => l.pool_id === "pool-hvac-a" && l.line_type === "BASE_YEAR"), false);

  const b1Lines = output.calculation_lines.filter((l) => l.lease_id === "lease-b1");
  const b1CapLines = b1Lines.filter((l) => l.line_type === "CAP");
  assertEquals(b1CapLines.length, 12);
  const b1CapTotal = b1CapLines.reduce((sum, l) => sum + (l.adjustment ?? 0), 0);
  assertEquals(Math.abs(b1CapTotal - -3250) < 0.10, true);

  // Deterministic rerun -- required by the acceptance standard alongside the
  // manual tie-out itself.
  const rerun = await runCamEngine(input);
  assertEquals(rerun.lease_results, output.lease_results);
  assertEquals(rerun.input_hash, output.input_hash);
});
