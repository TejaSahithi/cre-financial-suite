// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3 unit
// tests for the pure pool-assembly modules (pool-builder.ts, gross-up.ts,
// denominator.ts). Pure functions, no database required.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyCategoryInclusionExclusion, assembleSegmentAmounts } from "../_shared/cam-engine-v2/pools/pool-builder.ts";
import { applyGrossUp } from "../_shared/cam-engine-v2/pools/gross-up.ts";
import { computeDenominatorArea, computeTenantNumeratorArea } from "../_shared/cam-engine-v2/pools/denominator.ts";
import { buildMonthlySlices } from "../_shared/cam-engine-v2/time/period-slicer.ts";
import type { CamExpenseInputRow, PoolAssignmentInput } from "../_shared/cam-engine-v2/contracts/cam-input.ts";
import type { RecoveryPoolCategory } from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";
import type { PoolSegmentAmount } from "../_shared/cam-engine-v2/pools/pool-builder.ts";

function expenseInput(overrides: Partial<CamExpenseInputRow>): CamExpenseInputRow {
  return {
    id: "exp-1",
    amount: 1200,
    category: "utilities",
    publication_status: "published",
    publication_version: 1,
    fiscal_year: 2026,
    property_id: "prop-1",
    building_id: null,
    unit_id: null,
    lease_id: null,
    cam_input_type: "actual",
    variability: "variable",
    controllability: "controllable",
    service_period_start: "2026-01-01",
    service_period_end: "2026-12-31",
    ...overrides,
  };
}

function assignment(overrides: Partial<PoolAssignmentInput>): PoolAssignmentInput {
  return { id: "assign-1", cam_expense_input_id: "exp-1", recovery_pool_id: "pool-1", amount: 1200, percent_of_source: null, ...overrides };
}

// --- pool-builder.ts: assembleSegmentAmounts -------------------------------

Deno.test("assembleSegmentAmounts: full-year expense prorates evenly across monthly segments by actual days", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-12-31");
  const { amounts, exceptions } = assembleSegmentAmounts(segments, [expenseInput({})], [assignment({})]);
  assertEquals(exceptions.length, 0);
  assertEquals(amounts.length, 12);
  const total = amounts.reduce((s, a) => s + a.amount, 0);
  assertEquals(Math.round(total * 100) / 100, 1200);
  // January (31 days) should carry more than February (28 days in 2026).
  const jan = amounts.find((a) => a.segment.monthIndex === 1)!;
  const feb = amounts.find((a) => a.segment.monthIndex === 2)!;
  assertEquals(jan.amount > feb.amount, true);
});

Deno.test("assembleSegmentAmounts: expense with no service period produces a blocking EXPENSE_SERVICE_PERIOD_MISSING exception, not a guess", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-12-31");
  const input = expenseInput({ service_period_start: null, service_period_end: null });
  const { amounts, exceptions } = assembleSegmentAmounts(segments, [input], [assignment({})]);
  assertEquals(amounts.length, 0);
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "EXPENSE_SERVICE_PERIOD_MISSING");
  assertEquals(exceptions[0].severity, "blocking");
});

Deno.test("assembleSegmentAmounts: inverted service period produces a blocking EXPENSE_SERVICE_PERIOD_INVALID exception", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-12-31");
  const input = expenseInput({ service_period_start: "2026-06-01", service_period_end: "2026-01-01" });
  const { exceptions } = assembleSegmentAmounts(segments, [input], [assignment({})]);
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "EXPENSE_SERVICE_PERIOD_INVALID");
});

Deno.test("assembleSegmentAmounts: pool assignment referencing an unknown expense input produces POOL_ASSIGNMENT_ORPHANED", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-12-31");
  const { amounts, exceptions } = assembleSegmentAmounts(segments, [], [assignment({})]);
  assertEquals(amounts.length, 0);
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "POOL_ASSIGNMENT_ORPHANED");
});

Deno.test("assembleSegmentAmounts: service period covering only part of the run only produces amounts for overlapping segments (midyear commencement of an expense)", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-12-31");
  const input = expenseInput({ service_period_start: "2026-09-01", service_period_end: "2026-12-31" });
  const { amounts } = assembleSegmentAmounts(segments, [input], [assignment({})]);
  assertEquals(amounts.every((a) => a.segment.monthIndex >= 9), true);
  const total = amounts.reduce((s, a) => s + a.amount, 0);
  assertEquals(Math.round(total * 100) / 100, 1200);
});

// --- pool-builder.ts: applyCategoryInclusionExclusion ----------------------

function poolAmount(overrides: Partial<PoolSegmentAmount>): PoolSegmentAmount {
  return {
    pool_id: "pool-1",
    segment: { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 },
    category: "utilities",
    amount: 100,
    source_expense_input_id: "exp-1",
    variability: "variable",
    controllability: "controllable",
    ...overrides,
  };
}

Deno.test("applyCategoryInclusionExclusion: pool with no configured categories treats everything as included", () => {
  const { included, excluded } = applyCategoryInclusionExclusion([poolAmount({})], {});
  assertEquals(included.length, 1);
  assertEquals(excluded.length, 0);
});

Deno.test("applyCategoryInclusionExclusion: explicit exclusion wins over broad inclusion for the same category", () => {
  const categories: Record<string, RecoveryPoolCategory[]> = {
    "pool-1": [
      { id: "c1", org_id: "org-1", pool_id: "pool-1", expense_category_id: "utilities", inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable", created_at: "", updated_at: "" },
      { id: "c2", org_id: "org-1", pool_id: "pool-1", expense_category_id: "utilities", inclusion_mode: "exclude", variability_default: "variable", controllability_default: "controllable", created_at: "", updated_at: "" },
    ],
  };
  const { included, excluded } = applyCategoryInclusionExclusion([poolAmount({})], categories);
  assertEquals(included.length, 0);
  assertEquals(excluded.length, 1);
});

Deno.test("applyCategoryInclusionExclusion: an include-only pool excludes any category not explicitly listed", () => {
  const categories: Record<string, RecoveryPoolCategory[]> = {
    "pool-1": [
      { id: "c1", org_id: "org-1", pool_id: "pool-1", expense_category_id: "landscaping", inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable", created_at: "", updated_at: "" },
    ],
  };
  const { included, excluded } = applyCategoryInclusionExclusion([poolAmount({ category: "utilities" })], categories);
  assertEquals(included.length, 0);
  assertEquals(excluded.length, 1);
});

// --- gross-up.ts ------------------------------------------------------------

Deno.test("applyGrossUp: below target occupancy, variable expenses are grossed up proportionally (vacant-space gross-up)", () => {
  const amounts: PoolSegmentAmount[] = [
    poolAmount({ amount: 8000, variability: "variable" }),
    poolAmount({ amount: 2000, variability: "fixed" }),
  ];
  const { result, exceptions } = applyGrossUp("pool-1", amounts, 0.8, 1.0);
  assertEquals(exceptions.length, 0);
  assertEquals(result.fixedAmount, 2000);
  assertEquals(result.variableAmount, 8000);
  assertEquals(result.grossedVariableAmount, 10000); // 8000 * (1.0/0.8)
  assertEquals(result.grossUpAdjustment, 2000);
  assertEquals(result.adjustedPool, 12000);
});

Deno.test("applyGrossUp: fixed-only expenses are never grossed up even at low occupancy", () => {
  const amounts: PoolSegmentAmount[] = [poolAmount({ amount: 5000, variability: "fixed" })];
  const { result } = applyGrossUp("pool-1", amounts, 0.5, 1.0);
  assertEquals(result.grossUpAdjustment, 0);
  assertEquals(result.adjustedPool, 5000);
});

Deno.test("applyGrossUp: actual occupancy already at or above target performs no adjustment", () => {
  const amounts: PoolSegmentAmount[] = [poolAmount({ amount: 5000, variability: "variable" })];
  const { result } = applyGrossUp("pool-1", amounts, 1.0, 0.95);
  assertEquals(result.grossUpAdjustment, 0);
  assertEquals(result.adjustedPool, 5000);
});

Deno.test("applyGrossUp: no target occupancy configured performs no adjustment", () => {
  const amounts: PoolSegmentAmount[] = [poolAmount({ amount: 5000, variability: "variable" })];
  const { result } = applyGrossUp("pool-1", amounts, 0.5, null);
  assertEquals(result.grossUpAdjustment, 0);
});

Deno.test("applyGrossUp: unknown variability blocks gross-up with a VARIABILITY_UNKNOWN exception instead of guessing", () => {
  const amounts: PoolSegmentAmount[] = [poolAmount({ amount: 5000, variability: "unknown", source_expense_input_id: "exp-99" })];
  const { exceptions } = applyGrossUp("pool-1", amounts, 0.8, 1.0);
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "VARIABILITY_UNKNOWN");
  assertEquals(exceptions[0].entity_id, "exp-99");
});

Deno.test("applyGrossUp: near-zero occupancy is floored by MINIMUM_SAFE_OCCUPANCY_PCT rather than dividing by near-zero", () => {
  const amounts: PoolSegmentAmount[] = [poolAmount({ amount: 1000, variability: "variable" })];
  const { result } = applyGrossUp("pool-1", amounts, 0.001, 1.0);
  // safeActual floored to 0.05 -> grossed = 1000 * (1.0/0.05) = 20000, not astronomically large
  assertEquals(result.grossedVariableAmount, 20000);
});

// --- denominator.ts ---------------------------------------------------------

Deno.test("computeDenominatorArea: sums area across eligible scopes for a fully-covered segment", () => {
  const segment = { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 };
  const measurements = [
    { id: "m1", org_id: "org-1", scope_type: "building" as const, scope_id: "bldg-1", area_type: "rentable" as const, standard: null, area_sqft: 10000, effective_from: "2026-01-01", effective_to: null, source_id: null, approved_at: null, approved_by: null, created_at: "", updated_at: "", source_type: "primary" as const, backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required" as const },
  ];
  const { area, exceptions } = computeDenominatorArea(segment, ["bldg-1"], measurements);
  assertEquals(area, 10000);
  assertEquals(exceptions.length, 0);
});

Deno.test("computeDenominatorArea: a scope change mid-segment (area change) is day-weighted, not all-or-nothing", () => {
  const segment = { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 }; // 31 days
  const measurements = [
    { id: "m1", org_id: "org-1", scope_type: "building" as const, scope_id: "bldg-1", area_type: "rentable" as const, standard: null, area_sqft: 10000, effective_from: "2026-01-01", effective_to: "2026-01-15", source_id: null, approved_at: null, approved_by: null, created_at: "", updated_at: "", source_type: "primary" as const, backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required" as const },
    { id: "m2", org_id: "org-1", scope_type: "building" as const, scope_id: "bldg-1", area_type: "rentable" as const, standard: null, area_sqft: 12000, effective_from: "2026-01-16", effective_to: null, source_id: null, approved_at: null, approved_by: null, created_at: "", updated_at: "", source_type: "primary" as const, backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required" as const },
  ];
  const { area, exceptions } = computeDenominatorArea(segment, ["bldg-1"], measurements);
  assertEquals(exceptions.length, 0);
  // (10000*15 + 12000*16) / 31 = 11032.26
  assertEquals(area, 11032.26);
});

Deno.test("computeDenominatorArea: missing measurement for a scope produces a blocking AREA_MISSING exception", () => {
  const segment = { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 };
  const { area, exceptions } = computeDenominatorArea(segment, ["bldg-missing"], []);
  assertEquals(area, 0);
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "AREA_MISSING");
});

Deno.test("computeTenantNumeratorArea: multi-suite lease sums recovery area across all premises overlapping the segment", () => {
  const segment = { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 };
  const premises = [
    {
      id: "prem-1", org_id: "org-1", lease_id: "lease-1", lease_version_id: null, lease_amendment_id: null,
      premises_type: "primary" as const, effective_from: "2026-01-01", effective_to: null, status: "approved" as const,
      notes: null, created_by: null, created_at: "", updated_at: "",
      source_type: "primary" as const, backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required" as const,
      area_periods: [{ id: "ap1", org_id: "org-1", lease_premises_id: "prem-1", area_basis: "rentable" as const, contractual_area_sqft: 5000, recovery_area_sqft: 5000, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "" }],
    },
    {
      id: "prem-2", org_id: "org-1", lease_id: "lease-1", lease_version_id: null, lease_amendment_id: null,
      premises_type: "expansion" as const, effective_from: "2026-01-01", effective_to: null, status: "approved" as const,
      notes: null, created_by: null, created_at: "", updated_at: "",
      source_type: "primary" as const, backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required" as const,
      area_periods: [{ id: "ap2", org_id: "org-1", lease_premises_id: "prem-2", area_basis: "rentable" as const, contractual_area_sqft: 1500, recovery_area_sqft: 1500, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "" }],
    },
  ];
  const { area, exceptions } = computeTenantNumeratorArea(segment, premises);
  assertEquals(exceptions.length, 0);
  assertEquals(area, 6500);
});

Deno.test("computeTenantNumeratorArea: no effective premises for the segment produces a blocking PREMISES_MISSING exception", () => {
  const segment = { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 };
  const { area, exceptions } = computeTenantNumeratorArea(segment, []);
  assertEquals(area, 0);
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "PREMISES_MISSING");
});

Deno.test("computeTenantNumeratorArea: falls back to contractual_area_sqft when recovery_area_sqft is null", () => {
  const segment = { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 };
  const premises = [
    {
      id: "prem-1", org_id: "org-1", lease_id: "lease-1", lease_version_id: null, lease_amendment_id: null,
      premises_type: "primary" as const, effective_from: "2026-01-01", effective_to: null, status: "approved" as const,
      notes: null, created_by: null, created_at: "", updated_at: "",
      source_type: "primary" as const, backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required" as const,
      area_periods: [{ id: "ap1", org_id: "org-1", lease_premises_id: "prem-1", area_basis: "fixed_contractual" as const, contractual_area_sqft: 3000, recovery_area_sqft: null, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "" }],
    },
  ];
  const { area, exceptions } = computeTenantNumeratorArea(segment, premises);
  assertEquals(exceptions.length, 0);
  assertEquals(area, 3000);
});
