// @ts-nocheck
import { assertEquals, assertRejects, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";

/**
 * Pure unit tests for Phase 4A handleGeneratePlanning data assembly,
 * reconciliation assertions, CAM double-counting protection, and
 * snapshot lineage checks.
 */

// ── Mock Helper ─────────────────────────────────────────────────────────────

function mockSnapshot(overrides = {}) {
  return {
    id: overrides.id || "snap-1",
    org_id: overrides.org_id || "org-1",
    property_id: overrides.property_id || "prop-1",
    fiscal_year: overrides.fiscal_year || 2027,
    status: overrides.status || "completed",
    engine_type: overrides.engine_type || "budget_basis",
    inputs: overrides.inputs || {},
    outputs: overrides.outputs || {},
    computed_at: "2026-08-08T00:00:00Z",
  };
}

// ── Pure Assembly Test Helper ───────────────────────────────────────────────

function assemblePlanningTotals(basisSnap, camEstSnap, revenueSnap) {
  const basisOutputs = basisSnap.outputs ?? {};
  const camEstOutputs = camEstSnap.outputs ?? {};
  const revenueOutputs = revenueSnap.outputs ?? {};

  const baseRent = Math.round(Number(revenueOutputs.summary?.revenue_by_type?.base_rent ?? 0) * 100) / 100;
  const otherIncome = Math.round(Number(revenueOutputs.summary?.revenue_by_type?.other_income ?? 0) * 100) / 100;
  const estimatedCamRecovery = Math.round(
    Number(camEstOutputs.property_summary?.estimated_tenant_recoveries ?? 0) * 100 / 100
  );

  const totalRevenue = Math.round((baseRent + estimatedCamRecovery + otherIncome) * 100) / 100;
  const totalExpenses = Math.round(Number(basisOutputs.totals?.annual_budget_total ?? 0) * 100) / 100;
  const noi = Math.round((totalRevenue - totalExpenses) * 100) / 100;

  return { baseRent, otherIncome, estimatedCamRecovery, totalRevenue, totalExpenses, noi };
}

function validateLineage(basisSnap, camEstSnap) {
  const recordedBasisId =
    camEstSnap.inputs?.budget_basis_snapshot_id ||
    camEstSnap.outputs?.budget_basis_snapshot_id;

  if (recordedBasisId && recordedBasisId !== basisSnap.id) {
    throw new Error(
      `Lineage mismatch: CAM Estimate snapshot was derived from basis "${recordedBasisId}", not "${basisSnap.id}".`
    );
  }
  return true;
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test("Phase 4A Assembly: Expense tie-out (Basis 3A = total_expenses = sum of lines)", () => {
  const basisSnap = mockSnapshot({
    id: "basis-123",
    engine_type: "budget_basis",
    outputs: {
      totals: { annual_budget_total: 150000 },
      categories: [
        { category_label: "Utilities", annual_budget: 50000 },
        { category_label: "Maintenance", annual_budget: 100000 },
      ],
    },
  });

  const camEstSnap = mockSnapshot({
    id: "cam-123",
    engine_type: "budget_cam_estimate",
    inputs: { budget_basis_snapshot_id: "basis-123" },
    outputs: { property_summary: { estimated_tenant_recoveries: 40000 } },
  });

  const revenueSnap = mockSnapshot({
    id: "rev-123",
    engine_type: "revenue",
    outputs: {
      summary: {
        revenue_by_type: { base_rent: 200000, cam_recovery: 35000, other_income: 10000 },
        annual_total: 245000,
      },
    },
  });

  const totals = assemblePlanningTotals(basisSnap, camEstSnap, revenueSnap);

  assertEquals(totals.totalExpenses, 150000);
  const categorySum = basisSnap.outputs.categories.reduce((s, c) => s + c.annual_budget, 0);
  assertEquals(categorySum, totals.totalExpenses);
});

Deno.test("Phase 4A Assembly: CAM recovery double-count guard (ignores actual CAM from revenue snapshot)", () => {
  const basisSnap = mockSnapshot({
    id: "basis-1",
    engine_type: "budget_basis",
    outputs: { totals: { annual_budget_total: 100000 }, categories: [{ category_label: "Taxes", annual_budget: 100000 }] },
  });

  const camEstSnap = mockSnapshot({
    id: "cam-1",
    engine_type: "budget_cam_estimate",
    inputs: { budget_basis_snapshot_id: "basis-1" },
    outputs: { property_summary: { estimated_tenant_recoveries: 25000 } }, // Phase 3B CAM
  });

  const revenueSnap = mockSnapshot({
    id: "rev-1",
    engine_type: "revenue",
    outputs: {
      summary: {
        revenue_by_type: {
          base_rent: 180000,
          cam_recovery: 99999, // ACTUAL posted CAM in revenue snapshot - MUST BE IGNORED
          other_income: 5000,
        },
        annual_total: 284999, // MUST NOT BE USED Directly
      },
    },
  });

  const totals = assemblePlanningTotals(basisSnap, camEstSnap, revenueSnap);

  // totalRevenue = base_rent (180000) + other_income (5000) + Phase 3B CAM (25000) = 210000
  assertEquals(totals.baseRent, 180000);
  assertEquals(totals.otherIncome, 5000);
  assertEquals(totals.estimatedCamRecovery, 25000);
  assertEquals(totals.totalRevenue, 210000);

  // Proves the actual CAM (99999) from revenue snapshot was NOT counted
  const doubleCountedTotal = 180000 + 99999 + 5000 + 25000;
  assertEquals(totals.totalRevenue < doubleCountedTotal, true);
});

Deno.test("Phase 4A Assembly: NOI tie-out (totalRevenue - totalExpenses)", () => {
  const basisSnap = mockSnapshot({
    id: "basis-2",
    engine_type: "budget_basis",
    outputs: { totals: { annual_budget_total: 120000 }, categories: [{ category_label: "Other", annual_budget: 120000 }] },
  });

  const camEstSnap = mockSnapshot({
    id: "cam-2",
    engine_type: "budget_cam_estimate",
    inputs: { budget_basis_snapshot_id: "basis-2" },
    outputs: { property_summary: { estimated_tenant_recoveries: 30000 } },
  });

  const revenueSnap = mockSnapshot({
    id: "rev-2",
    engine_type: "revenue",
    outputs: { summary: { revenue_by_type: { base_rent: 150000, other_income: 0 } } },
  });

  const totals = assemblePlanningTotals(basisSnap, camEstSnap, revenueSnap);

  // Revenue = 150000 + 30000 = 180000; Expenses = 120000
  assertEquals(totals.totalRevenue, 180000);
  assertEquals(totals.totalExpenses, 120000);
  assertEquals(totals.noi, 60000);
  assertEquals(totals.noi, totals.totalRevenue - totals.totalExpenses);
});

Deno.test("Phase 4A Lineage Guard: Rejects CAM estimate derived from a stale/different basis", () => {
  const basisSnapCurrent = mockSnapshot({ id: "basis-C", engine_type: "budget_basis" });

  const camEstSnapOld = mockSnapshot({
    id: "cam-B",
    engine_type: "budget_cam_estimate",
    inputs: { budget_basis_snapshot_id: "basis-A" }, // Derived from Basis A!
  });

  // Attempting to pair Basis C with CAM Estimate B (which was derived from A) MUST throw
  assertRejects(async () => {
    validateLineage(basisSnapCurrent, camEstSnapOld);
  }, Error, "Lineage mismatch");
});

Deno.test("Phase 4A Lineage Guard: Accepts CAM estimate matching the current basis", () => {
  const basisSnapCurrent = mockSnapshot({ id: "basis-C", engine_type: "budget_basis" });

  const camEstSnapCurrent = mockSnapshot({
    id: "cam-C",
    engine_type: "budget_cam_estimate",
    inputs: { budget_basis_snapshot_id: "basis-C" },
  });

  const valid = validateLineage(basisSnapCurrent, camEstSnapCurrent);
  assertEquals(valid, true);
});
