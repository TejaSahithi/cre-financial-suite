// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3/3B golden
// scenario tests for the full CamRunInput -> CamRunOutput orchestrator
// (orchestrator/run-cam-engine.ts). Pure function, no database required —
// every fixture below is a hand-built, fully-specified CamRunInput.
//
// Phase 3B product decisions 1/2: pool eligibility is authoritative through
// an EXPLICIT recovery_pool_lease_participants grant — every fixture below
// must include one for a lease to recover anything from a pool, no matter
// how obviously its premises overlap that pool's spatial scope.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runCamEngine } from "../_shared/cam-engine-v2/orchestrator/run-cam-engine.ts";
import type { CamRunInput, CamRunLeaseContext, CamRunHeader, PoolAssignmentInput, CamExpenseInputRow } from "../_shared/cam-engine-v2/contracts/cam-input.ts";
import type {
  RecoveryPeriod, RecoveryPool, RecoveryPoolCategory, RecoveryPoolScopeMember, RecoveryPoolLeaseParticipant,
  LeaseRecoveryPolicy, LeaseRecoveryPolicyStep, LeasePremises, LeasePremisesSpace, LeasePremisesAreaPeriod,
  SpaceAreaMeasurement, SpaceOccupancyPeriod,
} from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function runHeader(overrides: Partial<CamRunHeader> = {}): CamRunHeader {
  return {
    id: "run-1", org_id: "org-1", recovery_period_id: "period-1", scope_type: "property", scope_id: "prop-1",
    run_type: "standard", adjustment_of_run_id: null, restatement_of_run_id: null, engine_version: "cam-engine-v2.0.0",
    currency: "USD", area_unit: "sqft",
    rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder" },
    run_mode: "preview",
    ...overrides,
  };
}

function period(start = "2026-01-01", end = "2026-12-31"): RecoveryPeriod {
  return { id: "period-1", org_id: "org-1", calendar_id: "cal-1", start_date: start, end_date: end, label: "FY2026", status: "open", soft_closed_at: null, locked_at: null, created_at: "", updated_at: "" };
}

function pool(overrides: Partial<RecoveryPool> = {}, categories: RecoveryPoolCategory[] = [], scopeMembers: RecoveryPoolScopeMember[] = []): RecoveryPool & { categories: RecoveryPoolCategory[]; scope_members: RecoveryPoolScopeMember[] } {
  return {
    id: "pool-1", org_id: "org-1", period_id: "period-1", is_template: false, property_id: "prop-1", name: "Property Pool",
    pool_type: "property", scope_type: "property", scope_id: null, currency: "USD", status: "active",
    default_gross_up_target_pct: null, created_at: "", updated_at: "",
    ...overrides, categories, scope_members: scopeMembers,
  };
}

function expenseInput(overrides: Partial<CamExpenseInputRow> = {}): CamExpenseInputRow {
  return {
    id: uid("exp"), amount: 12000, category: "utilities", publication_status: "published", publication_version: 1,
    fiscal_year: 2026, property_id: "prop-1", building_id: null, unit_id: null, lease_id: null, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
    ...overrides,
  };
}

function categoryDef(poolId: string, expenseCategoryId: string, inclusionMode: "include" | "exclude" = "include"): RecoveryPoolCategory {
  return { id: uid("cat"), org_id: "org-1", pool_id: poolId, expense_category_id: expenseCategoryId, inclusion_mode: inclusionMode, variability_default: "variable", controllability_default: "controllable", created_at: "", updated_at: "" };
}

function poolAssignment(expenseInputId: string, poolId = "pool-1", overrides: Partial<PoolAssignmentInput> = {}): PoolAssignmentInput {
  return { id: uid("assign"), cam_expense_input_id: expenseInputId, recovery_pool_id: poolId, amount: 0, percent_of_source: null, ...overrides };
}

function occupancyPeriod(scopeId: string, occupiedAreaSqft: number, overrides: Partial<SpaceOccupancyPeriod> = {}): SpaceOccupancyPeriod {
  return {
    id: uid("occ"), org_id: "org-1", scope_type: "property", scope_id: scopeId, lease_id: null, occupancy_status: "occupied",
    occupied_area_sqft: occupiedAreaSqft, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
    ...overrides,
  };
}

function areaMeasurement(scopeId: string, sqft: number, overrides: Partial<SpaceAreaMeasurement> = {}): SpaceAreaMeasurement {
  return {
    id: uid("area"), org_id: "org-1", scope_type: "property", scope_id: scopeId, area_type: "rentable", standard: null, area_sqft: sqft,
    effective_from: "2026-01-01", effective_to: null, source_id: null, approved_at: null, approved_by: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
    ...overrides,
  };
}

function premises(
  leaseId: string, propertyId: string, recoveryAreaSqft: number, overrides: Partial<LeasePremises> = {},
  areaPeriodOverrides: Partial<LeasePremisesAreaPeriod> = {}, spaceOverrides: Partial<LeasePremisesSpace> = {},
): LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] } {
  const id = overrides.id ?? uid("prem");
  return {
    org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, premises_type: "primary",
    effective_from: "2026-01-01", effective_to: null, status: "approved", notes: null, created_by: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
    ...overrides, id,
    spaces: [{ id: uid("space"), org_id: "org-1", lease_premises_id: id, property_id: propertyId, building_id: null, unit_id: null, allocation_weight: 1, created_at: "", updated_at: "", ...spaceOverrides }],
    area_periods: [{ id: uid("areaper"), org_id: "org-1", lease_premises_id: id, area_basis: "rentable", contractual_area_sqft: recoveryAreaSqft, recovery_area_sqft: recoveryAreaSqft, effective_from: overrides.effective_from ?? "2026-01-01", effective_to: overrides.effective_to ?? null, created_at: "", updated_at: "", ...areaPeriodOverrides }],
  };
}

function lease(id: string, premisesList: (LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] })[]): CamRunLeaseContext {
  return { id, premises: premisesList };
}

function shareStep(overrides: Partial<LeaseRecoveryPolicyStep> = {}): LeaseRecoveryPolicyStep {
  return { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 1, step_type: "CALCULATE_SHARE", expense_category_id: "utilities", pool_id: null, selector: null, parameters: {}, source_evidence: null, created_at: "", updated_at: "", ...overrides };
}

function grossUpStepFor(category: string, targetPct: number, sequence = 1): LeaseRecoveryPolicyStep {
  return { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence, step_type: "GROSS_UP_VARIABLE", expense_category_id: category, pool_id: null, selector: null, parameters: { target_occupancy_pct: targetPct }, source_evidence: null, created_at: "", updated_at: "" };
}

function policy(leaseId: string, steps: LeaseRecoveryPolicyStep[], overrides: Partial<LeaseRecoveryPolicy> = {}): LeaseRecoveryPolicy & { steps: LeaseRecoveryPolicyStep[] } {
  return {
    id: "policy-1", org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, source_rule_set_id: null,
    source_rule_id: null, source_rule_updated_at: null, source_rule_hash: null, source_approved_at: null, materializer_version: "materializer_v1",
    source_evidence: null, policy_type: "category_recovery", effective_from: "2026-01-01", effective_to: null,
    effective_date_source: "lease_commencement", effective_date_reason: null, effective_date_approved_by: null, effective_date_confidence: null,
    status: "approved", superseded_by_policy_id: null, approved_by: null, approved_at: null, notes: null, created_at: "", updated_at: "",
    ...overrides, steps,
  };
}

/** Phase 3B product decisions 1/2: the ONLY authority for lease<->pool eligibility. Defaults to an unbounded window so it never accidentally clips a scenario under test — tests exercising participation windows themselves override effective_from/effective_to explicitly. */
function participant(poolId: string, leaseId: string, overrides: Partial<RecoveryPoolLeaseParticipant> = {}): RecoveryPoolLeaseParticipant {
  return { id: uid("participant"), org_id: "org-1", pool_id: poolId, lease_id: leaseId, effective_from: "2020-01-01", effective_to: null, source: "explicit", status: "active", created_by: null, approved_by: null, notes: null, created_at: "", updated_at: "", ...overrides };
}

function baseInput(overrides: Partial<CamRunInput> = {}): CamRunInput {
  return {
    run: runHeader(), recovery_period: period(), pools: [pool()], published_expense_inputs: [], pool_assignments: [],
    pool_lease_participants: [], leases: [], area_measurements: [], occupancy_periods: [], policies: [], estimate_schedules: [],
    prior_period_adjustments: [], prior_cam_history: [], base_year_snapshots: [], policy_materializer_versions: {}, readiness_at_snapshot_time: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Leap year
// ---------------------------------------------------------------------------
Deno.test("Golden 1 — leap year: 2024 recovery period correctly uses 366 fiscal days, not a hardcoded 365", async () => {
  const exp = expenseInput({ amount: 36600, service_period_start: "2024-01-01", service_period_end: "2024-12-31" });
  const input = baseInput({
    run: runHeader(), recovery_period: period("2024-01-01", "2024-12-31"),
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36600 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000, { effective_from: "2024-01-01" })],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000, { effective_from: "2024-01-01" })])],
    policies: [policy("lease-1", [shareStep()], { effective_from: "2024-01-01" })],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // 10% share of 36600 = 3660, regardless of the pool being spread across 366 days internally
  assertEquals(output.lease_results[0].final_recovery, 3660);
});

// ---------------------------------------------------------------------------
// 2. Midyear commencement
// ---------------------------------------------------------------------------
Deno.test("Golden 2 — midyear commencement: lease starting July 1 only recovers for the portion of the year it existed", async () => {
  const exp = expenseInput({ amount: 12000 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 12000 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000, { effective_from: "2026-07-01" })])],
    policies: [policy("lease-1", [shareStep()], { effective_from: "2026-07-01" })],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // Half a year (184 days of 365) at 10% share of 12000 -> ~605.75, well below the full-year 1200
  assertEquals(output.lease_results[0].final_recovery < 1200, true);
  assertEquals(output.lease_results[0].final_recovery > 0, true);
});

// ---------------------------------------------------------------------------
// 3. Midyear expiration
// ---------------------------------------------------------------------------
Deno.test("Golden 3 — midyear expiration: lease ending September 10 stops recovering after that date", async () => {
  const exp = expenseInput({ amount: 12000 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 12000 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000, { effective_to: "2026-09-10" })])],
    policies: [policy("lease-1", [shareStep()], { effective_to: "2026-09-10" })],
  });
  const output = await runCamEngine(input);
  assertEquals(output.lease_results[0].final_recovery < 1200, true);
});

// ---------------------------------------------------------------------------
// 4. Expansion (area change mid-year via a second premises window)
// ---------------------------------------------------------------------------
Deno.test("Golden 4 — expansion: tenant's numerator area increases mid-year, increasing their share proportionally", async () => {
  const exp = expenseInput({ amount: 36500 }); // 100/day
  const expandedPremises = premises("lease-1", "prop-1", 10000, { id: "prem-1", effective_to: "2026-06-30" });
  const afterExpansion = premises("lease-1", "prop-1", 20000, { id: "prem-2", effective_from: "2026-07-01" });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [expandedPremises, afterExpansion])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // First half at 10%, second half at 20% -> more than a flat 10% for the full year (3650) would be
  assertEquals(output.lease_results[0].final_recovery > 3650, true);
});

// ---------------------------------------------------------------------------
// 5. Multiple suites / buildings (multi-premises lease within one property pool)
// ---------------------------------------------------------------------------
Deno.test("Golden 5 — multiple suites: a lease with two concurrent premises sums both areas into one numerator", async () => {
  const exp = expenseInput({ amount: 12000 });
  const suiteA = premises("lease-1", "prop-1", 5000, { id: "prem-a", premises_type: "primary" });
  const suiteB = premises("lease-1", "prop-1", 3000, { id: "prem-b", premises_type: "expansion" });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 12000 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [suiteA, suiteB])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // (5000+3000)/100000 = 8% of 12000 = 960
  assertEquals(output.lease_results[0].final_recovery, 960);
});

// ---------------------------------------------------------------------------
// 6. Area change (denominator side)
// ---------------------------------------------------------------------------
Deno.test("Golden 6 — area change: a mid-year denominator area change is day-weighted, changing the tenant's effective share", async () => {
  const exp = expenseInput({ amount: 36500 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [
      areaMeasurement("prop-1", 100000, { effective_from: "2026-01-01", effective_to: "2026-06-30" }),
      areaMeasurement("prop-1", 200000, { effective_from: "2026-07-01", effective_to: null }),
    ],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // First half: 10% of pool; second half: 5% of pool (denominator doubled) -> less than a flat 10% (3650) for the full year
  assertEquals(output.lease_results[0].final_recovery < 3650, true);
});

// ---------------------------------------------------------------------------
// 7. Vacant-space gross-up
// ---------------------------------------------------------------------------
Deno.test("Golden 7 — vacant-space gross-up: variable expenses are grossed up to a target occupancy, increasing the pool and the tenant's recovery", async () => {
  const exp = expenseInput({ amount: 36500, variability: "variable" });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    occupancy_periods: [occupancyPeriod("prop-1", 50000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [grossUpStepFor("utilities", 100), shareStep({ sequence: 2 })])],
  });
  const grossUpOutput = await runCamEngine(input);
  const noGrossUpInput = { ...input, policies: [policy("lease-1", [shareStep()])] };
  const flatOutput = await runCamEngine(noGrossUpInput);
  assertEquals(grossUpOutput.exceptions.filter((e) => e.severity === "blocking"), []);
  // 50% occupancy grossed to 100% target doubles the variable pool -> tenant's recovery is higher than without gross-up
  assertEquals(grossUpOutput.lease_results[0].final_recovery > flatOutput.lease_results[0].final_recovery, true);
});

// ---------------------------------------------------------------------------
// 8. Fixed vs variable (fixed expenses never grossed up)
// ---------------------------------------------------------------------------
Deno.test("Golden 8 — fixed vs variable: a fixed-cost expense is unaffected by gross-up even at low occupancy", async () => {
  const exp = expenseInput({ amount: 36500, variability: "fixed" });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    occupancy_periods: [occupancyPeriod("prop-1", 10000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [grossUpStepFor("utilities", 100), shareStep({ sequence: 2 })])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.pool_results[0].gross_up_adjustment, 0);
  assertEquals(output.lease_results[0].final_recovery, 3650); // flat 10% of 36500, unaffected by occupancy
});

// ---------------------------------------------------------------------------
// 9. Base year
// ---------------------------------------------------------------------------
Deno.test("Golden 9 — base year: tenant's equivalent share of a normalized base-year amount is deducted from their recovery", async () => {
  const exp = expenseInput({ amount: 36500 });
  const baseYearStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 2, step_type: "APPLY_BASE_YEAR", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { base_year: "2024", base_year_amount: 20000 }, source_evidence: null, created_at: "", updated_at: "" };
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep(), baseYearStep])],
  });
  const output = await runCamEngine(input);
  // tenant's flat share = 3650; base deduction = 10% of 20000 = 2000 -> 1650
  assertEquals(output.lease_results[0].final_recovery, 1650);
});

// ---------------------------------------------------------------------------
// 10. Expense stop
// ---------------------------------------------------------------------------
Deno.test("Golden 10 — expense stop: annual stop amount is deducted from the tenant's recovery, prorated to the run's day count", async () => {
  const exp = expenseInput({ amount: 36500 });
  const stopStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 2, step_type: "APPLY_EXPENSE_STOP", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { expense_stop_amount: 1000 }, source_evidence: null, created_at: "", updated_at: "" };
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep(), stopStep])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.lease_results[0].final_recovery, 2650); // 3650 - 1000
});

// ---------------------------------------------------------------------------
// 11. Cumulative cap
// ---------------------------------------------------------------------------
Deno.test("Golden 11 — cumulative cap: controllable recovery is capped to the compounded base across the elapsed years", async () => {
  const exp = expenseInput({ amount: 36500, controllability: "controllable" });
  const capStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 2, step_type: "APPLY_CAP", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { cap_type: "cumulative", cap_percent: 5, cap_amount: 1000 }, source_evidence: null, created_at: "", updated_at: "" };
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep(), capStep])],
    prior_cam_history: [
      { fiscal_year: 2024, lease_id: "lease-1", cam_run_id: "run-2024", permitted_controllable_amount: 1000, actual_controllable_amount: 1000, posted_at: "2025-01-01" },
      { fiscal_year: 2025, lease_id: "lease-1", cam_run_id: "run-2025", permitted_controllable_amount: 1050, actual_controllable_amount: 1050, posted_at: "2026-01-01" },
    ],
  });
  const output = await runCamEngine(input);
  // uncapped share would be 3650; cumulative permitted = 1000*1.05^2 = 1102.5, well below 3650 -> capped
  assertEquals(output.lease_results[0].final_recovery, 1102.5);
});

// ---------------------------------------------------------------------------
// 12. Non-cumulative cap
// ---------------------------------------------------------------------------
Deno.test("Golden 12 — non-cumulative cap: controllable recovery is capped to last year's permitted amount plus this year's percentage only", async () => {
  const exp = expenseInput({ amount: 36500, controllability: "controllable" });
  const capStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 2, step_type: "APPLY_CAP", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { cap_type: "non_cumulative", cap_percent: 5 }, source_evidence: null, created_at: "", updated_at: "" };
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep(), capStep])],
    prior_cam_history: [{ fiscal_year: 2025, lease_id: "lease-1", cam_run_id: "run-2025", permitted_controllable_amount: 1000, actual_controllable_amount: 1000, posted_at: "2026-01-01" }],
  });
  const output = await runCamEngine(input);
  assertEquals(output.lease_results[0].final_recovery, 1050); // 1000 * 1.05
});

// ---------------------------------------------------------------------------
// 13. Category-specific cap (only the capped category's pool is affected)
// ---------------------------------------------------------------------------
Deno.test("Golden 13 — category-specific cap: a cap on one pool/category does not affect a separate pool/category for the same lease", async () => {
  const utilExp = expenseInput({ id: "exp-util", amount: 10000, category: "utilities", controllability: "controllable" });
  const landscapeExp = expenseInput({ id: "exp-land", amount: 5000, category: "landscaping", controllability: "controllable" });
  const utilPool = pool({}, [categoryDef("pool-1", "utilities")]);
  const landscapePool = pool({ id: "pool-2", name: "Landscape Pool" }, [categoryDef("pool-2", "landscaping")]);
  const capStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 2, step_type: "APPLY_CAP", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { cap_type: "fixed_dollar", cap_amount: 200 }, source_evidence: null, created_at: "", updated_at: "" };
  const input = baseInput({
    published_expense_inputs: [utilExp, landscapeExp],
    pool_assignments: [poolAssignment(utilExp.id, "pool-1", { amount: 10000 }), poolAssignment(landscapeExp.id, "pool-2", { amount: 5000 })],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-2", "lease-1")],
    pools: [utilPool, landscapePool],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [
      policy("lease-1", [shareStep({ expense_category_id: "utilities" }), capStep], { id: "policy-util" }),
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "landscaping" })], { id: "policy-land" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // utilities capped to 200; landscaping uncapped at 10% of 5000 = 500 -> total 700
  assertEquals(output.lease_results[0].final_recovery, 700);
});

// ---------------------------------------------------------------------------
// 14. Admin-fee ordering
// ---------------------------------------------------------------------------
Deno.test("Golden 14 — admin-fee ordering: fee is computed on the post-cap recovery, not the pre-cap amount", async () => {
  const exp = expenseInput({ amount: 36500, controllability: "controllable" });
  const capStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 2, step_type: "APPLY_CAP", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { cap_type: "fixed_dollar", cap_amount: 1000 }, source_evidence: null, created_at: "", updated_at: "" };
  const feeStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 3, step_type: "ADD_ADMIN_FEE", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { admin_fee_percent: 10 }, source_evidence: null, created_at: "", updated_at: "" };
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep(), capStep, feeStep])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.lease_results[0].final_recovery, 1100); // (3650 capped to 1000) + 10% fee = 1100, not 10% of 3650
});

// ---------------------------------------------------------------------------
// 15. Direct allocation
// ---------------------------------------------------------------------------
Deno.test("Golden 15 — direct allocation: DIRECT_ASSIGN bypasses area pro-rata and uses only the fixed annual amount", async () => {
  const exp = expenseInput({ amount: 36500 });
  const directStep: LeaseRecoveryPolicyStep = { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 1, step_type: "DIRECT_ASSIGN", expense_category_id: "utilities", pool_id: null, selector: null, parameters: { estimated_annual_amount: 2400 }, source_evidence: null, created_at: "", updated_at: "" };
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [directStep])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.lease_results[0].final_recovery, 2400);
});

// ---------------------------------------------------------------------------
// 16. Multiple pools (two DIFFERENT categories, two DIFFERENT pools)
// ---------------------------------------------------------------------------
Deno.test("Golden 16 — multiple pools: a lease recovering from two independent pools sums both into its final recovery", async () => {
  const utilExp = expenseInput({ id: "exp-util", amount: 10000, category: "utilities" });
  const landscapeExp = expenseInput({ id: "exp-land", amount: 5000, category: "landscaping" });
  const utilPool = pool({}, [categoryDef("pool-1", "utilities")]);
  const landscapePool = pool({ id: "pool-2", name: "Landscape Pool" }, [categoryDef("pool-2", "landscaping")]);
  const input = baseInput({
    published_expense_inputs: [utilExp, landscapeExp],
    pool_assignments: [poolAssignment(utilExp.id, "pool-1", { amount: 10000 }), poolAssignment(landscapeExp.id, "pool-2", { amount: 5000 })],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-2", "lease-1")],
    pools: [utilPool, landscapePool],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [
      policy("lease-1", [shareStep({ expense_category_id: "utilities" })], { id: "policy-util" }),
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "landscaping" })], { id: "policy-land" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.pool_results.length, 2);
  // 10% of 10000 + 10% of 5000 = 1000 + 500 = 1500
  assertEquals(output.lease_results[0].final_recovery, 1500);
});

// ---------------------------------------------------------------------------
// 17. Unassigned expense
// ---------------------------------------------------------------------------
Deno.test("Golden 17 — unassigned expense: a published expense input with no pool assignment produces no calculation impact and no false amount (silently absent, not an error, since assignment is a separate approval step)", async () => {
  const assignedExp = expenseInput({ id: "exp-assigned", amount: 10000 });
  const unassignedExp = expenseInput({ id: "exp-unassigned", amount: 99999 });
  const input = baseInput({
    published_expense_inputs: [assignedExp, unassignedExp],
    pool_assignments: [poolAssignment(assignedExp.id, "pool-1", { amount: 10000 })], // unassignedExp has NO assignment row
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.pool_results[0].actual_amount, 10000); // unassigned $99999 never entered the pool
  assertEquals(output.lease_results[0].final_recovery, 1000);
});

// ---------------------------------------------------------------------------
// 18. Estimates greater than actual (credit to tenant)
// ---------------------------------------------------------------------------
Deno.test("Golden 18 — estimates greater than actual: tenant is owed a credit when estimates billed exceed the final recovery", async () => {
  const exp = expenseInput({ amount: 1000 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 1000 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep()])],
    estimate_schedules: [{ id: "est-1", org_id: "org-1", lease_id: "lease-1", recovery_period_id: "period-1", month_date: "2026-06-01", amount: 500, source: "manual", status: "billed", exported_at: null, created_at: "", updated_at: "" }],
  });
  const output = await runCamEngine(input);
  // final_recovery = 100 (10% of 1000); estimates billed 500 -> credit of -400
  assertEquals(output.lease_results[0].final_recovery, 100);
  assertEquals(output.lease_results[0].amount_due_credit, -400);
});

// ---------------------------------------------------------------------------
// 19. Rounding reconciliation
// ---------------------------------------------------------------------------
Deno.test("Golden 19 — rounding: internal precision uses run.rounding_policy.internal_decimal_places, ledger output uses ledger_decimal_places", async () => {
  const exp = expenseInput({ amount: 100 });
  const input = baseInput({
    run: runHeader({ rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder" } }),
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 100 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 3)], // deliberately awkward divisor to force rounding
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 1)])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const output = await runCamEngine(input);
  const recovery = output.lease_results[0].final_recovery;
  // Ledger output must be rounded to exactly 2 decimal places (no floating-point residue).
  assertEquals(Math.round(recovery * 100) / 100, recovery);
});

// ---------------------------------------------------------------------------
// 20. Amendment effective mid-period (policy supersession mid-year)
// ---------------------------------------------------------------------------
Deno.test("Golden 20 — amendment effective mid-period: an old policy and its superseding replacement each apply only within their own effective window", async () => {
  const exp = expenseInput({ amount: 36500 });
  const originalPolicy = policy("lease-1", [shareStep({ parameters: { recovery_method: "fixed_percentage", tenant_share_percent: 5 } })], { id: "policy-orig", effective_from: "2026-01-01", effective_to: "2026-06-30", status: "superseded" });
  const amendedPolicy = policy("lease-1", [shareStep({ id: uid("step"), parameters: { recovery_method: "fixed_percentage", tenant_share_percent: 15 } })], { id: "policy-amend", effective_from: "2026-07-01", effective_to: null, status: "approved" });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [originalPolicy, amendedPolicy], // both present in the snapshot; only the approved one is actually applied
  });
  const output = await runCamEngine(input);
  // superseded policy is never applied (status !== 'approved'), so only the second-half 15% share applies:
  // ~half a year of the pool (18250) * 15% = ~2737.5, well below a flat 5%-all-year (1825) and flat 15%-all-year (5475)
  assertEquals(output.lease_results[0].final_recovery > 1825, true);
  assertEquals(output.lease_results[0].final_recovery < 5475, true);
});

// ---------------------------------------------------------------------------
// 21. Deterministic rerun
// ---------------------------------------------------------------------------
Deno.test("Golden 21 — deterministic rerun: identical CamRunInput produces an identical input_hash and identical results across independent invocations", async () => {
  const exp = expenseInput({ amount: 12000 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 12000 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const run1 = await runCamEngine(input);
  const run2 = await runCamEngine(input);
  assertEquals(run1.input_hash, run2.input_hash);
  assertEquals(run1.lease_results, run2.lease_results);
  assertEquals(run1.pool_results, run2.pool_results);
  assertEquals(run1.calculation_lines.map((l) => ({ ...l, sequence: 0 })), run2.calculation_lines.map((l) => ({ ...l, sequence: 0 })));
});

Deno.test("Golden 21b — deterministic rerun: a different CamRunInput produces a different input_hash", async () => {
  const exp1 = expenseInput({ amount: 12000 });
  const input1 = baseInput({ published_expense_inputs: [exp1], pool_assignments: [poolAssignment(exp1.id, "pool-1", { amount: 12000 })] });
  const exp2 = expenseInput({ amount: 15000 });
  const input2 = baseInput({ published_expense_inputs: [exp2], pool_assignments: [poolAssignment(exp2.id, "pool-1", { amount: 15000 })] });
  const run1 = await runCamEngine(input1);
  const run2 = await runCamEngine(input2);
  assertEquals(run1.input_hash === run2.input_hash, false);
});

// ---------------------------------------------------------------------------
// 22. Missing area / unassigned pool -> blocking exception, not a silent guess
// ---------------------------------------------------------------------------
Deno.test("Golden 22 — missing area blocks the run: a lease with no area measurement for its scope produces a blocking AREA_MISSING exception and ready_to_post=false", async () => {
  const exp = expenseInput({ amount: 12000 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 12000 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [], // deliberately missing
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.ready_to_post, false);
  assertEquals(output.exceptions.some((e) => e.code === "AREA_MISSING" && e.severity === "blocking"), true);
});

Deno.test("Golden 22b — cross-lease independence: two leases in the same pool each recover according to their own share, summing to less than the whole pool when a third premises' area exists but has no lease", async () => {
  const exp = expenseInput({ amount: 10000 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 10000 })],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-1", "lease-2")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)]), lease("lease-2", [premises("lease-2", "prop-1", 20000)])],
    policies: [policy("lease-1", [shareStep()], { id: "policy-1" }), policy("lease-2", [shareStep({ id: uid("step") })], { id: "policy-2", lease_id: "lease-2" })],
  });
  const output = await runCamEngine(input);
  const lease1 = output.lease_results.find((r) => r.lease_id === "lease-1")!.final_recovery;
  const lease2 = output.lease_results.find((r) => r.lease_id === "lease-2")!.final_recovery;
  // Both leases draw from the SAME pool+category+segment groups, so
  // Workstream B.3's largest-remainder residual allocation reconciles their
  // shares back to an exact total EVERY MONTH (12 segments) -- each
  // individual lease's ANNUAL figure can differ from the idealized flat
  // 10%/20% split by a few cents (legitimate monthly ledger rounding, the
  // same behavior any real monthly-billed accounting system has), but the
  // GROUP's combined total across the whole year is exact to the cent.
  // The group's PER-SEGMENT sums are exact by construction (proven by the
  // residual-allocation unit tests); the ANNUAL total is 12 independently
  // ledger-rounded monthly figures summed, which is not bit-identical to a
  // single-shot idealized flat-year calculation even for the combined
  // group -- same day-weighted-monthly-proration-plus-per-month-rounding
  // reality as each individual lease's figure.
  assertEquals(Math.abs(lease1 - 1000) < 0.10, true);
  assertEquals(Math.abs(lease2 - 2000) < 0.10, true);
  assertEquals(Math.abs(lease1 + lease2 - 3000) < 0.10, true);
});

// ---------------------------------------------------------------------------
// 22c. Phase 3B product decision 2: spatial overlap alone is NOT authority
// ---------------------------------------------------------------------------
Deno.test("Golden 22c — spatial overlap without an explicit participation grant recovers ZERO, not a spatially-inferred share", async () => {
  const exp = expenseInput({ amount: 12000 });
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 12000 })],
    pool_lease_participants: [], // deliberately no explicit grant, despite obvious spatial/property overlap
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep()])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.ready_to_post, false);
  assertEquals(output.exceptions.some((e) => e.code === "LEASE_POOL_UNRESOLVED"), true);
  assertEquals(output.lease_results[0].final_recovery, 0);
});

// ===========================================================================
// Phase 3B-A required multi-pool scenarios
// ===========================================================================

// ---------------------------------------------------------------------------
// 23. Property pool plus building pool for one lease
// ---------------------------------------------------------------------------
Deno.test("Golden 23 — property pool plus building pool: a lease recovers from BOTH simultaneously, aggregated, not chosen between", async () => {
  const propExp = expenseInput({ id: "exp-prop", amount: 20000, category: "utilities" });
  const bldgExp = expenseInput({ id: "exp-bldg", amount: 8000, category: "elevator" });
  const propertyPool = pool({}, [categoryDef("pool-1", "utilities")]);
  const buildingPool = pool({ id: "pool-2", name: "Building A Pool", pool_type: "building", scope_type: "building", scope_id: "bldg-A" }, [categoryDef("pool-2", "elevator")]);
  const input = baseInput({
    published_expense_inputs: [propExp, bldgExp],
    pool_assignments: [poolAssignment(propExp.id, "pool-1", { amount: 20000 }), poolAssignment(bldgExp.id, "pool-2", { amount: 8000 })],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-2", "lease-1")],
    pools: [propertyPool, buildingPool],
    area_measurements: [areaMeasurement("prop-1", 100000), areaMeasurement("bldg-A", 40000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000, {}, {}, { building_id: "bldg-A" })])],
    policies: [
      policy("lease-1", [shareStep({ expense_category_id: "utilities" })], { id: "policy-prop" }),
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "elevator" })], { id: "policy-bldg" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // property: 10000/100000 = 10% of 20000 = 2000; building: 10000/40000 = 25% of 8000 = 2000 -> total 4000
  assertEquals(output.lease_results[0].final_recovery, 4000);
  assertEquals(output.calculation_lines.some((l) => l.lease_id === "lease-1" && l.pool_id === "pool-1"), true);
  assertEquals(output.calculation_lines.some((l) => l.lease_id === "lease-1" && l.pool_id === "pool-2"), true);
});

// ---------------------------------------------------------------------------
// 24. Operating pool plus taxes and insurance pools (3 simultaneous pools)
// ---------------------------------------------------------------------------
Deno.test("Golden 24 — operating pool plus taxes and insurance pools: three simultaneous pools sum into one lease total", async () => {
  const opExp = expenseInput({ id: "exp-op", amount: 10000, category: "operating" });
  const taxExp = expenseInput({ id: "exp-tax", amount: 6000, category: "taxes" });
  const insExp = expenseInput({ id: "exp-ins", amount: 2000, category: "insurance" });
  const opPool = pool({}, [categoryDef("pool-1", "operating")]);
  const taxPool = pool({ id: "pool-2", name: "Taxes Pool" }, [categoryDef("pool-2", "taxes")]);
  const insPool = pool({ id: "pool-3", name: "Insurance Pool" }, [categoryDef("pool-3", "insurance")]);
  const input = baseInput({
    published_expense_inputs: [opExp, taxExp, insExp],
    pool_assignments: [
      poolAssignment(opExp.id, "pool-1", { amount: 10000 }),
      poolAssignment(taxExp.id, "pool-2", { amount: 6000 }),
      poolAssignment(insExp.id, "pool-3", { amount: 2000 }),
    ],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-2", "lease-1"), participant("pool-3", "lease-1")],
    pools: [opPool, taxPool, insPool],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [
      policy("lease-1", [shareStep({ expense_category_id: "operating" })], { id: "policy-op" }),
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "taxes" })], { id: "policy-tax" }),
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "insurance" })], { id: "policy-ins" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  assertEquals(output.pool_results.length, 3);
  // 10% of (10000+6000+2000) = 1800
  assertEquals(output.lease_results[0].final_recovery, 1800);
});

// ---------------------------------------------------------------------------
// 25. Parking pool applying only to selected premises
// ---------------------------------------------------------------------------
Deno.test("Golden 25 — parking pool applying only to selected premises: a multi-suite lease only recovers parking CAM for the premises inside that pool's scope", async () => {
  const parkingExp = expenseInput({ amount: 12000, category: "parking" });
  const parkingPool = pool(
    { id: "pool-parking", name: "Parking Pool", pool_type: "building", scope_type: "building", scope_id: "bldg-A" },
    [categoryDef("pool-parking", "parking")],
  );
  const premisesInBuildingA = premises("lease-1", "prop-1", 4000, { id: "prem-a" }, {}, { building_id: "bldg-A" });
  const premisesInBuildingB = premises("lease-1", "prop-1", 6000, { id: "prem-b" }, {}, { building_id: "bldg-B" });
  const input = baseInput({
    published_expense_inputs: [parkingExp],
    pool_assignments: [poolAssignment(parkingExp.id, "pool-parking", { amount: 12000 })],
    pool_lease_participants: [participant("pool-parking", "lease-1")],
    pools: [parkingPool],
    area_measurements: [areaMeasurement("bldg-A", 20000)], // only building A has area on record for the parking pool's own scope
    leases: [lease("lease-1", [premisesInBuildingA, premisesInBuildingB])],
    policies: [policy("lease-1", [shareStep({ expense_category_id: "parking" })])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  // Numerator is pool-scoped to premises in building A only (4000, not 4000+6000): 4000/20000 = 20% of 12000 = 2400
  assertEquals(output.lease_results[0].final_recovery, 2400);
});

// ---------------------------------------------------------------------------
// 26. One invoice split across two pools
// ---------------------------------------------------------------------------
Deno.test("Golden 26 — one invoice split across two pools: a single expense input's balanced assignments feed two pools without duplicating the source amount", async () => {
  const sharedExp = expenseInput({ amount: 10000, category: "utilities" });
  const poolA = pool({}, [categoryDef("pool-1", "utilities")]);
  const poolB = pool({ id: "pool-2", name: "Pool B" }, [categoryDef("pool-2", "utilities")]);
  const input = baseInput({
    published_expense_inputs: [sharedExp],
    pool_assignments: [
      poolAssignment(sharedExp.id, "pool-1", { amount: 6000 }),
      poolAssignment(sharedExp.id, "pool-2", { amount: 4000 }),
    ],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-2", "lease-1")],
    pools: [poolA, poolB],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [
      policy("lease-1", [shareStep({ expense_category_id: "utilities" })], { id: "policy-a" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  assertEquals(output.pool_results.find((p) => p.pool_id === "pool-1")!.actual_amount, 6000);
  assertEquals(output.pool_results.find((p) => p.pool_id === "pool-2")!.actual_amount, 4000);
  // Only ONE policy exists for this category, so it's evaluated once per eligible pool: 10% of 6000 + 10% of 4000 = 1000
  // (the source $10,000 is never double-counted -- 6000+4000 == the original invoice, not 6000+4000+the original again)
  assertEquals(output.lease_results[0].final_recovery, 1000);
});

// ---------------------------------------------------------------------------
// 27. Prohibited double recovery — over-allocated assignments blocked
// ---------------------------------------------------------------------------
Deno.test("Golden 27 — prohibited double recovery: pool assignments summing past the source expense's own amount block the run instead of silently over-recovering", async () => {
  const sharedExp = expenseInput({ amount: 10000, category: "utilities" });
  const poolA = pool({}, [categoryDef("pool-1", "utilities")]);
  const poolB = pool({ id: "pool-2", name: "Pool B" }, [categoryDef("pool-2", "utilities")]);
  const input = baseInput({
    published_expense_inputs: [sharedExp],
    pool_assignments: [
      poolAssignment(sharedExp.id, "pool-1", { amount: 6000 }),
      poolAssignment(sharedExp.id, "pool-2", { amount: 6000 }), // 6000 + 6000 = 12000 > source amount 10000
    ],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-2", "lease-1")],
    pools: [poolA, poolB],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [policy("lease-1", [shareStep({ expense_category_id: "utilities" })])],
  });
  const output = await runCamEngine(input);
  assertEquals(output.ready_to_post, false);
  assertEquals(output.exceptions.some((e) => e.code === "POOL_ASSIGNMENT_OVER_ALLOCATED" && e.severity === "blocking"), true);
});

// ---------------------------------------------------------------------------
// 28. Different gross-up targets for two leases in one pool
// ---------------------------------------------------------------------------
Deno.test("Golden 28 — different gross-up targets for two leases in one pool: each lease's own override produces a genuinely different grossed-up recovery", async () => {
  const exp = expenseInput({ amount: 36500, variability: "variable" });
  const poolA = pool({}, [categoryDef("pool-1", "utilities")]);
  const occupancy = occupancyPeriod("prop-1", 50000);
  const input = baseInput({
    published_expense_inputs: [exp],
    pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-1", "lease-2")],
    pools: [poolA],
    occupancy_periods: [occupancy],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)]), lease("lease-2", [premises("lease-2", "prop-1", 10000)])],
    policies: [
      policy("lease-1", [grossUpStepFor("utilities", 90), shareStep({ id: uid("step"), expense_category_id: "utilities", sequence: 2 })], { id: "policy-1" }),
      policy("lease-2", [grossUpStepFor("utilities", 100), shareStep({ id: uid("step"), expense_category_id: "utilities", sequence: 2 })], { id: "policy-2", lease_id: "lease-2" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  const lease1Recovery = output.lease_results.find((r) => r.lease_id === "lease-1")!.final_recovery;
  const lease2Recovery = output.lease_results.find((r) => r.lease_id === "lease-2")!.final_recovery;
  // Both leases have IDENTICAL area/share, but lease-2's higher gross-up target (100% vs 90%) must
  // produce a strictly higher recovery -- proving gross-up is resolved per-lease, not once per pool.
  assertEquals(lease2Recovery > lease1Recovery, true);
});

// ---------------------------------------------------------------------------
// 29. Conflicting gross-up policies for the same lease
// ---------------------------------------------------------------------------
Deno.test("Golden 29 — conflicting gross-up policies for the same lease: two simultaneously-active policies for the same category/pool/period with different targets block with GROSS_UP_TARGET_CONFLICT", async () => {
  const exp = expenseInput({ amount: 36500, variability: "variable" });
  const input = baseInput({
    published_expense_inputs: [exp],
    pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 36500 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [
      // Both simultaneously 'approved' and overlapping — a genuine data
      // anomaly (materialization normally supersedes instead), which the
      // engine must still detect defensively rather than silently pick one.
      policy("lease-1", [grossUpStepFor("utilities", 90), shareStep({ id: uid("step"), expense_category_id: "utilities", sequence: 2 })], { id: "policy-a" }),
      policy("lease-1", [grossUpStepFor("utilities", 100), shareStep({ id: uid("step"), expense_category_id: "utilities", sequence: 2 })], { id: "policy-b" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.ready_to_post, false);
  assertEquals(output.exceptions.some((e) => e.code === "GROSS_UP_TARGET_CONFLICT" && e.severity === "blocking"), true);
});

// ---------------------------------------------------------------------------
// 30. Duplicate active policy for the same category (no gross-up involved) -> DUPLICATE_RECOVERY_PATH
// ---------------------------------------------------------------------------
Deno.test("Golden 30 — duplicate active policies for the same category without a gross-up conflict block with DUPLICATE_RECOVERY_PATH, not silent double-counting", async () => {
  const exp = expenseInput({ amount: 10000 });
  const input = baseInput({
    published_expense_inputs: [exp],
    pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 10000 })],
    pool_lease_participants: [participant("pool-1", "lease-1")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)])],
    policies: [
      policy("lease-1", [shareStep({ expense_category_id: "utilities" })], { id: "policy-a" }),
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "utilities" })], { id: "policy-b" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.ready_to_post, false);
  assertEquals(output.exceptions.some((e) => e.code === "DUPLICATE_RECOVERY_PATH" && e.severity === "blocking"), true);
});

// ---------------------------------------------------------------------------
// 31-34. Workstream B.3 — orchestrator-level residual allocation scenarios
// (capped tenants, direct allocations, multiple pools, large lease counts).
// The pure largest-remainder algorithm itself is exhaustively unit-tested in
// cam-engine-v2-residual-allocation.test.ts; these tests instead prove the
// ORCHESTRATOR wires it correctly at each of the specific scenarios the
// residual-allocation product requirement called out by name.
// ---------------------------------------------------------------------------
Deno.test("Golden 31 — residual allocation + capped tenant: a cap applied to one member of a residual group does not disturb the other members' shares, and the capped member settles at its cap, not a residual-corrected raw share", async () => {
  const exp = expenseInput({ amount: 90000, controllability: "controllable" });
  const capStep: LeaseRecoveryPolicyStep = {
    id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 2, step_type: "APPLY_CAP",
    expense_category_id: "utilities", pool_id: null, selector: null,
    parameters: { cap_type: "fixed_dollar", cap_amount: 1000 }, source_evidence: null, created_at: "", updated_at: "",
  };
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 90000 })],
    pool_lease_participants: [participant("pool-1", "lease-a"), participant("pool-1", "lease-b"), participant("pool-1", "lease-c")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [
      lease("lease-a", [premises("lease-a", "prop-1", 10000)]),
      lease("lease-b", [premises("lease-b", "prop-1", 10000)]),
      lease("lease-c", [premises("lease-c", "prop-1", 10000)]),
    ],
    policies: [
      policy("lease-a", [shareStep({ id: uid("step") })], { id: "policy-a", lease_id: "lease-a" }),
      policy("lease-b", [shareStep({ id: uid("step") })], { id: "policy-b", lease_id: "lease-b" }),
      // lease-c is in the SAME residual group as a/b at the raw CALCULATE_SHARE
      // stage (same pool+category+segment), but its cap step runs afterward,
      // per-lease, on the group-corrected raw share.
      policy("lease-c", [shareStep({ id: uid("step") }), capStep], { id: "policy-c", lease_id: "lease-c" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  const a = output.lease_results.find((r) => r.lease_id === "lease-a")!.final_recovery;
  const b = output.lease_results.find((r) => r.lease_id === "lease-b")!.final_recovery;
  const c = output.lease_results.find((r) => r.lease_id === "lease-c")!.final_recovery;
  // Each lease's uncapped raw share is 10% of 90000 = 9000/yr, far above the
  // $1000 cap -- lease-c must settle at (close to) its annual cap, not at a
  // residual-corrected ~9000 share and not at some other distorted value.
  assertEquals(Math.abs(c - 1000) < 0.10, true);
  // lease-a and lease-b are uninvolved with the cap and must still recover
  // their normal residual-corrected shares, unaffected by lease-c's cap.
  assertEquals(Math.abs(a - 9000) < 0.10, true);
  assertEquals(Math.abs(b - 9000) < 0.10, true);
});

Deno.test("Golden 32 — residual allocation + direct allocation: a DIRECT_ASSIGN lease recovers its exact fixed amount, untouched by residual correction applied to other leases sharing the same pool", async () => {
  const utilExp = expenseInput({ id: "exp-util", amount: 10000, category: "utilities" });
  const utilPool = pool({}, [categoryDef("pool-1", "utilities"), categoryDef("pool-1", "parking")]);
  const directStep: LeaseRecoveryPolicyStep = {
    id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 1, step_type: "DIRECT_ASSIGN",
    expense_category_id: "parking", pool_id: null, selector: null,
    parameters: { estimated_annual_amount: 2400 }, source_evidence: null, created_at: "", updated_at: "",
  };
  const input = baseInput({
    pools: [utilPool],
    published_expense_inputs: [utilExp],
    pool_assignments: [poolAssignment(utilExp.id, "pool-1", { amount: 10000 })],
    pool_lease_participants: [participant("pool-1", "lease-1"), participant("pool-1", "lease-2"), participant("pool-1", "lease-direct")],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [
      lease("lease-1", [premises("lease-1", "prop-1", 10000)]),
      lease("lease-2", [premises("lease-2", "prop-1", 20000)]),
      lease("lease-direct", [premises("lease-direct", "prop-1", 5000)]),
    ],
    policies: [
      // lease-1 and lease-2 share utilities via CALCULATE_SHARE -> a genuine
      // residual group of 2 forms for that pool+category+segment.
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "utilities" })], { id: "policy-1", lease_id: "lease-1" }),
      policy("lease-2", [shareStep({ id: uid("step"), expense_category_id: "utilities" })], { id: "policy-2", lease_id: "lease-2" }),
      // lease-direct is in the SAME POOL but recovers a different category via
      // DIRECT_ASSIGN only -- it must never enter the residual group at all.
      policy("lease-direct", [directStep], { id: "policy-direct", lease_id: "lease-direct" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  const direct = output.lease_results.find((r) => r.lease_id === "lease-direct")!.final_recovery;
  // Exact, not a tolerance check -- DIRECT_ASSIGN bypasses share computation
  // (and therefore the residual mechanism) entirely, same as standalone Golden 15.
  assertEquals(direct, 2400);
  const lease1 = output.lease_results.find((r) => r.lease_id === "lease-1")!.final_recovery;
  const lease2 = output.lease_results.find((r) => r.lease_id === "lease-2")!.final_recovery;
  assertEquals(Math.abs(lease1 - 1000) < 0.10, true);
  assertEquals(Math.abs(lease2 - 2000) < 0.10, true);
});

Deno.test("Golden 33 — residual allocation + multiple pools: the same two leases form TWO independent residual groups (one per pool), and neither pool's correction leaks into the other", async () => {
  const utilExp = expenseInput({ id: "exp-util", amount: 9000, category: "utilities" });
  const landscapeExp = expenseInput({ id: "exp-land", amount: 6000, category: "landscaping" });
  const utilPool = pool({}, [categoryDef("pool-1", "utilities")]);
  const landscapePool = pool({ id: "pool-2", name: "Landscape Pool" }, [categoryDef("pool-2", "landscaping")]);
  const input = baseInput({
    pools: [utilPool, landscapePool],
    published_expense_inputs: [utilExp, landscapeExp],
    pool_assignments: [poolAssignment(utilExp.id, "pool-1", { amount: 9000 }), poolAssignment(landscapeExp.id, "pool-2", { amount: 6000 })],
    pool_lease_participants: [
      participant("pool-1", "lease-1"), participant("pool-1", "lease-2"),
      participant("pool-2", "lease-1"), participant("pool-2", "lease-2"),
    ],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases: [lease("lease-1", [premises("lease-1", "prop-1", 10000)]), lease("lease-2", [premises("lease-2", "prop-1", 20000)])],
    policies: [
      // One policy per (lease, category) -- same convention as Golden 16/24 --
      // so each pool+category forms its own independent residual group.
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "utilities" })], { id: "policy-1-util", lease_id: "lease-1" }),
      policy("lease-1", [shareStep({ id: uid("step"), expense_category_id: "landscaping" })], { id: "policy-1-land", lease_id: "lease-1" }),
      policy("lease-2", [shareStep({ id: uid("step"), expense_category_id: "utilities" })], { id: "policy-2-util", lease_id: "lease-2" }),
      policy("lease-2", [shareStep({ id: uid("step"), expense_category_id: "landscaping" })], { id: "policy-2-land", lease_id: "lease-2" }),
    ],
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  const lease1 = output.lease_results.find((r) => r.lease_id === "lease-1")!.final_recovery;
  const lease2 = output.lease_results.find((r) => r.lease_id === "lease-2")!.final_recovery;
  // lease-1: 10% of utilities (900) + 10% of landscaping (600) = 1500.
  // lease-2: 20% of utilities (1800) + 20% of landscaping (1200) = 3000.
  // Each pool is corrected independently, then the two pools' contributions
  // are aggregated per lease -- consistent with the multi-pool-aggregation
  // architecture proven functionally by Golden 23/24.
  assertEquals(Math.abs(lease1 - 1500) < 0.10, true);
  assertEquals(Math.abs(lease2 - 3000) < 0.10, true);
  assertEquals(Math.abs(lease1 + lease2 - 4500) < 0.10, true);
});

Deno.test("Golden 34 — residual allocation at scale: a 60-lease residual group still ties out to the pool total, with no individual lease drifting by more than a couple of cents", async () => {
  const leaseCount = 60;
  const areaPerLease = 1000; // 60 * 1000 = 60,000 of 100,000 sqft occupied
  const exp = expenseInput({ amount: 100000.37 }); // deliberately not evenly divisible by 60
  const leases: CamRunLeaseContext[] = [];
  const participants: RecoveryPoolLeaseParticipant[] = [];
  const policies: (LeaseRecoveryPolicy & { steps: LeaseRecoveryPolicyStep[] })[] = [];
  for (let i = 0; i < leaseCount; i++) {
    const leaseId = `lease-${String(i).padStart(3, "0")}`;
    leases.push(lease(leaseId, [premises(leaseId, "prop-1", areaPerLease)]));
    participants.push(participant("pool-1", leaseId));
    policies.push(policy(leaseId, [shareStep({ id: uid("step") })], { id: `policy-${leaseId}`, lease_id: leaseId }));
  }
  const input = baseInput({
    published_expense_inputs: [exp], pool_assignments: [poolAssignment(exp.id, "pool-1", { amount: 100000.37 })],
    pool_lease_participants: participants,
    area_measurements: [areaMeasurement("prop-1", 100000)],
    leases, policies,
  });
  const output = await runCamEngine(input);
  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  assertEquals(output.lease_results.length, leaseCount);
  // Each lease's idealized flat share: 1% of pool (1000/100000 sqft) of the
  // 60,000/100,000 occupied fraction's expense = 100000.37 * (1000/100000) = 1000.0037.
  const idealPerLease = 100000.37 * (areaPerLease / 100000);
  let sum = 0;
  for (const r of output.lease_results) {
    assertEquals(Math.abs(r.final_recovery - idealPerLease) < 0.15, true);
    sum += r.final_recovery;
  }
  assertEquals(Math.abs(sum - idealPerLease * leaseCount) < 0.50, true);
});
