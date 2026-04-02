// @ts-nocheck
/**
 * Unit Tests: Reconciliation
 * Feature: backend-driven-pipeline, Task 13.4
 *
 * Requirements: 10.2, 10.3
 */

import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

interface LineItem {
  category: string;
  budget: number;
  actual: number;
}

interface ReconciliationResult {
  category: string;
  budget: number;
  actual: number;
  variance: number;
  variance_pct: number;
  flagged: boolean;
}

function computeVariance(actual: number, budget: number): number {
  return actual - budget;
}

function computeVariancePct(variance: number, budget: number): number {
  if (budget === 0) return 0;
  return (variance / budget) * 100;
}

function shouldFlag(variancePct: number): boolean {
  return Math.abs(variancePct) > 10;
}

function reconcileLineItem(item: LineItem): ReconciliationResult {
  const variance = computeVariance(item.actual, item.budget);
  const variance_pct = computeVariancePct(variance, item.budget);
  const flagged = shouldFlag(variance_pct);
  return { ...item, variance, variance_pct, flagged };
}

function reconcileAll(items: LineItem[]): ReconciliationResult[] {
  return items.map(reconcileLineItem);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Zero variance: actual=budget=10000 → variance=0, variance_pct=0, flagged=false
Deno.test("Zero variance: actual=budget=10000 → variance=0, variance_pct=0, flagged=false", () => {
  const result = reconcileLineItem({ category: "utilities", budget: 10000, actual: 10000 });

  assertAlmostEquals(result.variance, 0, 0.01, "variance must be 0");
  assertAlmostEquals(result.variance_pct, 0, 0.01, "variance_pct must be 0");
  assertEquals(result.flagged, false, "flagged must be false when variance=0");
});

// 2. 100% variance: actual=20000, budget=10000 → variance=10000, variance_pct=100, flagged=true
Deno.test("100% variance: actual=20000, budget=10000 → variance=10000, variance_pct=100, flagged=true", () => {
  const result = reconcileLineItem({ category: "maintenance", budget: 10000, actual: 20000 });

  assertAlmostEquals(result.variance, 10000, 0.01, "variance must be 10000");
  assertAlmostEquals(result.variance_pct, 100, 0.01, "variance_pct must be 100");
  assertEquals(result.flagged, true, "flagged must be true when variance_pct=100");
});

Deno.test("Negative 50% variance: actual=5000, budget=10000 → variance=-5000, variance_pct=-50, flagged=true", () => {
  const result = reconcileLineItem({ category: "insurance", budget: 10000, actual: 5000 });

  assertAlmostEquals(result.variance, -5000, 0.01, "variance must be -5000");
  assertAlmostEquals(result.variance_pct, -50, 0.01, "variance_pct must be -50");
  assertEquals(result.flagged, true, "flagged must be true when |variance_pct|=50 > 10");
});

// 3. Mixed variances: 3 line items, verify flagged only when |pct| > 10
Deno.test("Mixed variances: flagged only when |variance_pct| > 10", () => {
  const items: LineItem[] = [
    { category: "utilities", budget: 10000, actual: 10500 },   // 5% → not flagged
    { category: "maintenance", budget: 10000, actual: 12000 }, // 20% → flagged
    { category: "management", budget: 10000, actual: 9000 },   // -10% → not flagged (exactly 10, not > 10)
  ];

  const results = reconcileAll(items);

  // utilities: 5% variance → not flagged
  const utilities = results.find((r) => r.category === "utilities")!;
  assertAlmostEquals(utilities.variance_pct, 5, 0.01, "utilities variance_pct must be 5");
  assertEquals(utilities.flagged, false, "utilities must not be flagged at 5%");

  // maintenance: 20% variance → flagged
  const maintenance = results.find((r) => r.category === "maintenance")!;
  assertAlmostEquals(maintenance.variance_pct, 20, 0.01, "maintenance variance_pct must be 20");
  assertEquals(maintenance.flagged, true, "maintenance must be flagged at 20%");

  // management: exactly -10% → not flagged (boundary: > 10, not >= 10)
  const management = results.find((r) => r.category === "management")!;
  assertAlmostEquals(management.variance_pct, -10, 0.01, "management variance_pct must be -10");
  assertEquals(management.flagged, false, "management must not be flagged at exactly -10%");
});

Deno.test("Variance with zero budget: variance_pct=0, flagged=false", () => {
  const result = reconcileLineItem({ category: "capital", budget: 0, actual: 5000 });
  assertEquals(result.variance_pct, 0, "variance_pct must be 0 when budget is 0");
  assertEquals(result.flagged, false, "must not be flagged when budget is 0");
});
