// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3 unit
// tests for policies/policy-step-runner.ts and
// reconciliation/estimate-reconciliation.ts. Pure functions, no database
// required.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runPolicySteps, type PolicyStepRunContext } from "../_shared/cam-engine-v2/policies/policy-step-runner.ts";
import { reconcileEstimates } from "../_shared/cam-engine-v2/reconciliation/estimate-reconciliation.ts";
import type { LeaseRecoveryPolicyStep } from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";
import type { CamEstimateSchedule, CamPriorPeriodAdjustment } from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

function step(overrides: Partial<LeaseRecoveryPolicyStep>): LeaseRecoveryPolicyStep {
  return {
    id: "step-1", org_id: "org-1", policy_id: "policy-1", sequence: 1,
    step_type: "CALCULATE_SHARE", expense_category_id: null, pool_id: "pool-1", selector: null,
    parameters: {}, source_evidence: null, created_at: "", updated_at: "",
    ...overrides,
  };
}

function ctx(overrides: Partial<PolicyStepRunContext>): PolicyStepRunContext {
  return {
    leaseId: "lease-1", poolId: "pool-1",
    segment: { start: "2026-01-01", end: "2026-12-31", monthIndex: 1 },
    fiscalYearDays: 365, numeratorArea: 1000, denominatorArea: 10000,
    priorCamHistory: [], baseYearSnapshots: [],
    controllableInputAmount: 0, uncontrollableInputAmount: 0,
    ...overrides,
  };
}

Deno.test("CALCULATE_SHARE: area pro-rata computes tenant share from numerator/denominator", () => {
  const steps = [step({ step_type: "CALCULATE_SHARE", sequence: 1 })];
  const result = runPolicySteps(steps, 10000, ctx({ numeratorArea: 1000, denominatorArea: 10000 }));
  assertEquals(result.finalAmount, 1000); // 10% of 10000
  assertEquals(result.exceptions.length, 0);
  assertEquals(result.lines[0].formula_code, "AREA_PRO_RATA");
});

Deno.test("CALCULATE_SHARE: fixed percentage overrides area pro-rata when configured", () => {
  const steps = [step({ step_type: "CALCULATE_SHARE", parameters: { recovery_method: "fixed_percentage", tenant_share_percent: 25 } })];
  const result = runPolicySteps(steps, 8000, ctx({}));
  assertEquals(result.finalAmount, 2000);
  assertEquals(result.lines[0].formula_code, "FIXED_PERCENTAGE");
});

Deno.test("CALCULATE_SHARE: zero denominator area produces a blocking DENOMINATOR_ZERO exception, not a divide-by-zero guess", () => {
  const steps = [step({ step_type: "CALCULATE_SHARE" })];
  const result = runPolicySteps(steps, 10000, ctx({ denominatorArea: 0 }));
  assertEquals(result.finalAmount, 0);
  assertEquals(result.exceptions.length, 1);
  assertEquals(result.exceptions[0].code, "DENOMINATOR_ZERO");
});

Deno.test("DIRECT_ASSIGN: annual amount is prorated to the segment's day count", () => {
  const steps = [step({ step_type: "DIRECT_ASSIGN", parameters: { estimated_annual_amount: 3650 } })];
  const result = runPolicySteps(steps, 0, ctx({ segment: { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 }, fiscalYearDays: 365 }));
  assertEquals(result.finalAmount, 310); // 3650 * 31/365
});

Deno.test("APPLY_BASE_YEAR: deducts the tenant's equivalent share of the normalized base-year pool amount", () => {
  const steps = [step({ step_type: "APPLY_BASE_YEAR", parameters: { base_year: "2024" } })];
  const baseYearSnapshots = [{ base_year: "2024", pool_id: "pool-1", category: null, normalized_amount: 5000, source_cam_run_id: null, captured_at: "2025-01-01" }];
  // tenant share ratio = numeratorArea/denominatorArea = 1000/10000 = 10% -> base share = 500
  const result = runPolicySteps(steps, 1200, ctx({ baseYearSnapshots, numeratorArea: 1000, denominatorArea: 10000 }));
  assertEquals(result.finalAmount, 700); // 1200 - 500
  assertEquals(result.exceptions.length, 0);
});

Deno.test("APPLY_BASE_YEAR: falls back to an explicit base_year_amount when no snapshot is available", () => {
  const steps = [step({ step_type: "APPLY_BASE_YEAR", parameters: { base_year: "2024", base_year_amount: 4000 } })];
  const result = runPolicySteps(steps, 1200, ctx({ numeratorArea: 1000, denominatorArea: 10000 }));
  assertEquals(result.finalAmount, 800); // 1200 - (4000*0.1)
});

Deno.test("APPLY_BASE_YEAR: missing both snapshot and explicit amount blocks with BASE_YEAR_MISSING instead of assuming zero", () => {
  const steps = [step({ step_type: "APPLY_BASE_YEAR", parameters: { base_year: "2024" } })];
  const result = runPolicySteps(steps, 1200, ctx({}));
  assertEquals(result.finalAmount, 1200); // pass-through, unmodified
  assertEquals(result.exceptions.length, 1);
  assertEquals(result.exceptions[0].code, "BASE_YEAR_MISSING");
});

Deno.test("APPLY_BASE_YEAR: deduction never drives the recovery below zero", () => {
  const steps = [step({ step_type: "APPLY_BASE_YEAR", parameters: { base_year: "2024", base_year_amount: 999999 } })];
  const result = runPolicySteps(steps, 100, ctx({ numeratorArea: 1000, denominatorArea: 10000 }));
  assertEquals(result.finalAmount, 0);
});

Deno.test("APPLY_EXPENSE_STOP: annual stop is prorated to the segment and deducted", () => {
  const steps = [step({ step_type: "APPLY_EXPENSE_STOP", parameters: { expense_stop_amount: 1200 } })];
  const result = runPolicySteps(steps, 500, ctx({ segment: { start: "2026-01-01", end: "2026-06-30", monthIndex: 1 }, fiscalYearDays: 365 }));
  const segmentDays = 181; // Jan-Jun 2026 inclusive
  const expectedStop = Math.round((1200 * segmentDays / 365) * 1e6) / 1e6;
  assertEquals(result.finalAmount, Math.round(Math.max(0, 500 - expectedStop) * 1e6) / 1e6);
});

Deno.test("Base year AND expense stop compose (both configured explicitly) rather than one silently overriding the other", () => {
  const steps = [
    step({ id: "s1", step_type: "APPLY_BASE_YEAR", sequence: 1, parameters: { base_year: "2024", base_year_amount: 2000 } }),
    step({ id: "s2", step_type: "APPLY_EXPENSE_STOP", sequence: 2, parameters: { expense_stop_amount: 500 } }),
  ];
  const result = runPolicySteps(steps, 5000, ctx({ numeratorArea: 1000, denominatorArea: 10000, fiscalYearDays: 365, segment: { start: "2026-01-01", end: "2026-12-31", monthIndex: 1 } }));
  // base year deducts 2000*0.1=200 -> 4800; expense stop deducts 500 (full year) -> 4300
  assertEquals(result.finalAmount, 4300);
  assertEquals(result.lines.length, 2);
  assertEquals(result.lines[0].line_type, "BASE_YEAR");
  assertEquals(result.lines[1].line_type, "EXPENSE_STOP");
});

Deno.test("APPLY_CAP fixed_dollar: controllable amount capped to the fixed dollar ceiling", () => {
  const steps = [step({ step_type: "APPLY_CAP", parameters: { cap_type: "fixed_dollar", cap_amount: 3000 } })];
  const result = runPolicySteps(steps, 5000, ctx({ controllableInputAmount: 5000 }));
  assertEquals(result.finalAmount, 3000);
  assertEquals(result.lines[0].formula_code, "CAP_FIXED_DOLLAR");
});

Deno.test("APPLY_CAP noncumulative: permitted amount derives from prior year only, year-over-year (not compounding)", () => {
  const steps = [step({ step_type: "APPLY_CAP", parameters: { cap_type: "non_cumulative", cap_percent: 5 } })];
  const priorCamHistory = [{ fiscal_year: 2025, lease_id: "lease-1", cam_run_id: "run-2025", permitted_controllable_amount: 1000, actual_controllable_amount: 1000, posted_at: "2026-01-01" }];
  const result = runPolicySteps(steps, 1200, ctx({ controllableInputAmount: 1200, priorCamHistory }));
  assertEquals(result.finalAmount, 1050); // 1000 * 1.05, controllable-only reduction reflected 1-for-1
});

Deno.test("APPLY_CAP noncumulative: no prior history produces a CAP_HISTORY_MISSING warning and passes through uncapped (not silently zero)", () => {
  const steps = [step({ step_type: "APPLY_CAP", parameters: { cap_type: "non_cumulative", cap_percent: 5 } })];
  const result = runPolicySteps(steps, 1200, ctx({ controllableInputAmount: 1200 }));
  assertEquals(result.finalAmount, 1200);
  assertEquals(result.exceptions.length, 1);
  assertEquals(result.exceptions[0].severity, "warning");
  assertEquals(result.exceptions[0].code, "CAP_HISTORY_MISSING");
});

Deno.test("APPLY_CAP cumulative: compounds the base cap forward by the number of years elapsed", () => {
  const steps = [step({ step_type: "APPLY_CAP", parameters: { cap_type: "cumulative", cap_percent: 5, cap_amount: 1000 } })];
  const priorCamHistory = [
    { fiscal_year: 2024, lease_id: "lease-1", cam_run_id: "run-2024", permitted_controllable_amount: 1000, actual_controllable_amount: 1000, posted_at: "2025-01-01" },
    { fiscal_year: 2025, lease_id: "lease-1", cam_run_id: "run-2025", permitted_controllable_amount: 1050, actual_controllable_amount: 1050, posted_at: "2026-01-01" },
  ];
  const result = runPolicySteps(steps, 1500, ctx({ controllableInputAmount: 1500, priorCamHistory }));
  // yearsElapsed = 2025-2024+1 = 2 -> 1000 * 1.05^2 = 1102.5
  assertEquals(result.finalAmount, 1102.5);
});

Deno.test("APPLY_CAP: only the controllable portion is reduced; uncontrollable amount passes through untouched", () => {
  const steps = [step({ step_type: "APPLY_CAP", parameters: { cap_type: "fixed_dollar", cap_amount: 1000 } })];
  // total input 3000 = 2000 controllable + 1000 uncontrollable; cap reduces controllable to 1000 (-1000 adjustment)
  const result = runPolicySteps(steps, 3000, ctx({ controllableInputAmount: 2000, uncontrollableInputAmount: 1000 }));
  assertEquals(result.finalAmount, 2000); // 3000 + (1000 - 2000) = 2000
});

Deno.test("APPLY_CAP: unrecognized cap_type blocks with CAP_TYPE_UNRECOGNIZED rather than defaulting to any specific cap behavior", () => {
  const steps = [step({ step_type: "APPLY_CAP", parameters: { cap_type: "some_future_cap_type" } })];
  const result = runPolicySteps(steps, 1000, ctx({}));
  assertEquals(result.exceptions.length, 1);
  assertEquals(result.exceptions[0].code, "CAP_TYPE_UNRECOGNIZED");
});

Deno.test("APPLY_CAP: cap_type \"none\" is a real no-cap state, not CAP_TYPE_UNRECOGNIZED — passes through with no exception", () => {
  const steps = [step({ step_type: "APPLY_CAP", parameters: { cap_type: "none" } })];
  const result = runPolicySteps(steps, 1000, ctx({ controllableInputAmount: 1000 }));
  assertEquals(result.finalAmount, 1000);
  assertEquals(result.exceptions.length, 0);
  assertEquals(result.lines[0].formula_code, "CAP_NONE");
});

Deno.test("Category-specific cap: only the pool/category this step targets is affected, independent of other pools' totals", () => {
  const capSteps = [step({ step_type: "APPLY_CAP", pool_id: "pool-A", parameters: { cap_type: "fixed_dollar", cap_amount: 500 } })];
  const resultA = runPolicySteps(capSteps, 2000, ctx({ poolId: "pool-A", controllableInputAmount: 2000 }));
  const resultB = runPolicySteps(capSteps, 2000, ctx({ poolId: "pool-B", controllableInputAmount: 2000 }));
  assertEquals(resultA.finalAmount, 500);
  // Same step definition applied to a different pool context still caps independently (no cross-pool leakage).
  assertEquals(resultB.finalAmount, 500);
  assertEquals(resultA.lines[0].pool_id, "pool-A");
  assertEquals(resultB.lines[0].pool_id, "pool-B");
});

Deno.test("Admin-fee ordering: fee is computed on the post-cap amount, not pre-cap (CAM-G13 by construction via step sequence)", () => {
  const steps = [
    step({ id: "s1", step_type: "APPLY_CAP", sequence: 1, parameters: { cap_type: "fixed_dollar", cap_amount: 1000 } }),
    step({ id: "s2", step_type: "ADD_ADMIN_FEE", sequence: 2, parameters: { admin_fee_percent: 10 } }),
  ];
  const result = runPolicySteps(steps, 2000, ctx({ controllableInputAmount: 2000 }));
  // post-cap = 1000, fee = 10% of 1000 = 100 -> 1100 (NOT 10% of the original 2000)
  assertEquals(result.finalAmount, 1100);
  assertEquals(result.lines[1].adjustment, 100);
});

Deno.test("Admin fee applied out of sequence order (steps array unsorted) still executes in ascending `sequence`, not array order", () => {
  const steps = [
    step({ id: "s2", step_type: "ADD_ADMIN_FEE", sequence: 2, parameters: { admin_fee_percent: 10 } }),
    step({ id: "s1", step_type: "APPLY_CAP", sequence: 1, parameters: { cap_type: "fixed_dollar", cap_amount: 1000 } }),
  ];
  const result = runPolicySteps(steps, 2000, ctx({ controllableInputAmount: 2000 }));
  assertEquals(result.finalAmount, 1100);
});

Deno.test("DIRECT_ASSIGN (direct allocation): bypasses area pro-rata entirely, using only the fixed annual amount", () => {
  const steps = [step({ step_type: "DIRECT_ASSIGN", parameters: { estimated_annual_amount: 1000 } })];
  const result = runPolicySteps(steps, 999999 /* deliberately irrelevant input */, ctx({ segment: { start: "2026-01-01", end: "2026-12-31", monthIndex: 1 }, fiscalYearDays: 365 }));
  assertEquals(result.finalAmount, 1000);
});

Deno.test("APPLY_FLOOR: enforces a minimum recovery amount", () => {
  const steps = [step({ step_type: "APPLY_FLOOR", parameters: { floor_amount: 500 } })];
  const result = runPolicySteps(steps, 300, ctx({}));
  assertEquals(result.finalAmount, 500);
});

Deno.test("Unrecognized step_type blocks with UNRECOGNIZED_POLICY_STEP rather than silently skipping", () => {
  const steps = [step({ step_type: "SOME_FUTURE_STEP" as any })];
  const result = runPolicySteps(steps, 1000, ctx({}));
  assertEquals(result.exceptions.length, 1);
  assertEquals(result.exceptions[0].code, "UNRECOGNIZED_POLICY_STEP");
});

Deno.test("Deterministic rerun: identical steps and context produce an identical finalAmount across repeated invocations", () => {
  const steps = [
    step({ id: "s1", step_type: "CALCULATE_SHARE", sequence: 1 }),
    step({ id: "s2", step_type: "APPLY_CAP", sequence: 2, parameters: { cap_type: "fixed_dollar", cap_amount: 500 } }),
    step({ id: "s3", step_type: "ADD_ADMIN_FEE", sequence: 3, parameters: { admin_fee_percent: 15 } }),
  ];
  const c = ctx({ numeratorArea: 2000, denominatorArea: 10000, controllableInputAmount: 2000 });
  const run1 = runPolicySteps(steps, 10000, c);
  const run2 = runPolicySteps(steps, 10000, c);
  assertEquals(run1.finalAmount, run2.finalAmount);
  assertEquals(run1.exceptions, run2.exceptions);
});

Deno.test("INCLUDE_CATEGORY/EXCLUDE_CATEGORY/GROSS_UP_VARIABLE/RECONCILE_ESTIMATES are documented no-ops in the per-lease runner (handled upstream/downstream)", () => {
  const steps = [
    step({ step_type: "INCLUDE_CATEGORY" }),
    step({ id: "s2", step_type: "GROSS_UP_VARIABLE", sequence: 2 }),
    step({ id: "s3", step_type: "RECONCILE_ESTIMATES", sequence: 3 }),
  ];
  const result = runPolicySteps(steps, 1000, ctx({}));
  assertEquals(result.finalAmount, 1000);
  assertEquals(result.lines.length, 0);
  assertEquals(result.exceptions.length, 0);
});

// --- estimate-reconciliation.ts --------------------------------------------

function estimate(overrides: Partial<CamEstimateSchedule>): CamEstimateSchedule {
  return { id: "est-1", org_id: "org-1", lease_id: "lease-1", recovery_period_id: "period-1", month_date: "2026-01-01", amount: 100, source: "manual", status: "billed", exported_at: null, created_at: "", updated_at: "", ...overrides };
}

function adjustment(overrides: Partial<CamPriorPeriodAdjustment>): CamPriorPeriodAdjustment {
  return { id: "adj-1", org_id: "org-1", lease_id: "lease-1", recovery_period_id: "period-1", adjustment_type: "prior_period_adjustment", state: "KNOWN_ZERO", amount: null, source_reference: null, recorded_by: null, recorded_at: "", notes: null, created_at: "", updated_at: "", ...overrides };
}

const NO_ADJUSTMENTS_ZEROED: CamPriorPeriodAdjustment[] = [
  adjustment({ id: "adj-a", adjustment_type: "prior_period_adjustment", state: "KNOWN_ZERO" }),
  adjustment({ id: "adj-c", adjustment_type: "prior_credit", state: "KNOWN_ZERO" }),
];

Deno.test("reconcileEstimates: final recovery above estimates billed produces a positive amount due", () => {
  const estimates = [estimate({ month_date: "2026-06-01", amount: 500 })];
  const { result } = reconcileEstimates("lease-1", "period-1", 4000, estimates, NO_ADJUSTMENTS_ZEROED, "2026-01-01", "2026-12-31", "preview");
  assertEquals(result.estimatesBilled, 500);
  assertEquals(result.amountDueOrCredit, 3500);
});

Deno.test("reconcileEstimates: estimates billed exceeding final recovery (estimates greater than actual) produces a negative amount (credit to tenant)", () => {
  const estimates = [estimate({ amount: 6000 })];
  const { result } = reconcileEstimates("lease-1", "period-1", 4000, estimates, NO_ADJUSTMENTS_ZEROED, "2026-01-01", "2026-12-31", "preview");
  assertEquals(result.amountDueOrCredit, -2000);
});

Deno.test("reconcileEstimates: void estimates are excluded from the billed total", () => {
  const estimates = [estimate({ amount: 500, status: "billed" }), estimate({ id: "est-2", amount: 999, status: "void" })];
  const { result } = reconcileEstimates("lease-1", "period-1", 1000, estimates, NO_ADJUSTMENTS_ZEROED, "2026-01-01", "2026-12-31", "preview");
  assertEquals(result.estimatesBilled, 500);
});

Deno.test("reconcileEstimates: estimates outside the recovery period window are not counted (late prior-period expense scenario isolation)", () => {
  const estimates = [estimate({ month_date: "2025-12-15", amount: 999 })]; // prior period, out of window
  const { result } = reconcileEstimates("lease-1", "period-1", 1000, estimates, NO_ADJUSTMENTS_ZEROED, "2026-01-01", "2026-12-31", "preview");
  assertEquals(result.estimatesBilled, 0);
  assertEquals(result.amountDueOrCredit, 1000);
});

Deno.test("reconcileEstimates: idempotent — identical inputs produce identical output on repeated calls", () => {
  const estimates = [estimate({ amount: 300 })];
  const run1 = reconcileEstimates("lease-1", "period-1", 2000, estimates, NO_ADJUSTMENTS_ZEROED, "2026-01-01", "2026-12-31", "preview");
  const run2 = reconcileEstimates("lease-1", "period-1", 2000, estimates, NO_ADJUSTMENTS_ZEROED, "2026-01-01", "2026-12-31", "preview");
  assertEquals(run1.result.amountDueOrCredit, run2.result.amountDueOrCredit);
});

Deno.test("reconcileEstimates: KNOWN_AMOUNT prior adjustment and credit both apply to the formula", () => {
  const adjustments = [
    adjustment({ id: "adj-a", adjustment_type: "prior_period_adjustment", state: "KNOWN_AMOUNT", amount: 200 }),
    adjustment({ id: "adj-c", adjustment_type: "prior_credit", state: "KNOWN_AMOUNT", amount: 50 }),
  ];
  const { result } = reconcileEstimates("lease-1", "period-1", 1000, [], adjustments, "2026-01-01", "2026-12-31", "preview");
  // 1000 - 0 + 200 - 50 = 1150
  assertEquals(result.amountDueOrCredit, 1150);
});

Deno.test("reconcileEstimates: NOT_APPLICABLE contributes zero, same as KNOWN_ZERO, but is a distinct recorded state", () => {
  const adjustments = [
    adjustment({ id: "adj-a", adjustment_type: "prior_period_adjustment", state: "NOT_APPLICABLE" }),
    adjustment({ id: "adj-c", adjustment_type: "prior_credit", state: "NOT_APPLICABLE" }),
  ];
  const { result, exceptions } = reconcileEstimates("lease-1", "period-1", 1000, [], adjustments, "2026-01-01", "2026-12-31", "preview");
  assertEquals(result.amountDueOrCredit, 1000);
  assertEquals(exceptions.length, 0);
});

Deno.test("reconcileEstimates: UNKNOWN prior adjustment warns (not blocks) in a preview run", () => {
  const adjustments = [
    adjustment({ id: "adj-a", adjustment_type: "prior_period_adjustment", state: "UNKNOWN" }),
    adjustment({ id: "adj-c", adjustment_type: "prior_credit", state: "KNOWN_ZERO" }),
  ];
  const { exceptions } = reconcileEstimates("lease-1", "period-1", 1000, [], adjustments, "2026-01-01", "2026-12-31", "preview");
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "PRIOR_ADJUSTMENT_UNKNOWN");
  assertEquals(exceptions[0].severity, "warning");
});

Deno.test("reconcileEstimates: UNKNOWN prior adjustment BLOCKS in a posting_eligible run", () => {
  const adjustments = [
    adjustment({ id: "adj-a", adjustment_type: "prior_period_adjustment", state: "UNKNOWN" }),
    adjustment({ id: "adj-c", adjustment_type: "prior_credit", state: "KNOWN_ZERO" }),
  ];
  const { exceptions } = reconcileEstimates("lease-1", "period-1", 1000, [], adjustments, "2026-01-01", "2026-12-31", "posting_eligible");
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].severity, "blocking");
});

Deno.test("reconcileEstimates: a MISSING adjustment record is treated as UNKNOWN, never as zero", () => {
  const { exceptions, result } = reconcileEstimates("lease-1", "period-1", 1000, [], [], "2026-01-01", "2026-12-31", "posting_eligible");
  // both prior_period_adjustment and prior_credit have no row at all
  assertEquals(exceptions.filter((e) => e.code === "PRIOR_ADJUSTMENT_UNKNOWN").length, 2);
  assertEquals(exceptions.every((e) => e.severity === "blocking"), true);
  assertEquals(result.amountDueOrCredit, 1000); // still computed (0 contribution) so preview numbers remain visible
});
