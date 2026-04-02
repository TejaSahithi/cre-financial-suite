// @ts-nocheck
/**
 * Unit Tests: Expense Processing
 * Feature: backend-driven-pipeline, Task 9.5
 *
 * Tests pure expense processing helper functions.
 * Requirements: 6.1, 6.2, 6.3
 */

import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Types and pure helper functions
// ---------------------------------------------------------------------------

type ExpenseClassification = "recoverable" | "non_recoverable" | "conditional";

interface Expense {
  id: string;
  amount: number;
  classification: ExpenseClassification;
}

interface Tenant {
  id: string;
  square_footage: number;
  base_year_amount?: number; // optional base year threshold
}

interface TenantAllocation {
  tenant_id: string;
  allocation: number;
}

/**
 * Allocates totalRecoverable across tenants by pro-rata square footage.
 */
function allocateExpenses(totalRecoverable: number, tenants: Tenant[]): TenantAllocation[] {
  if (tenants.length === 0) return [];
  const totalSqft = tenants.reduce((sum, t) => sum + t.square_footage, 0);
  if (totalSqft === 0) {
    const equalShare = totalRecoverable / tenants.length;
    return tenants.map((t) => ({ tenant_id: t.id, allocation: equalShare }));
  }
  return tenants.map((t) => ({
    tenant_id: t.id,
    allocation: (t.square_footage / totalSqft) * totalRecoverable,
  }));
}

/**
 * Applies base year exclusion: tenant only pays expenses above base_year_amount.
 * Returns the adjusted allocation (max 0).
 */
function applyBaseYearExclusion(allocation: number, baseYearAmount: number): number {
  return Math.max(0, allocation - baseYearAmount);
}

/**
 * Filters expenses to only recoverable ones and returns their total.
 */
function getTotalRecoverable(expenses: Expense[]): number {
  return expenses
    .filter((e) => e.classification === "recoverable")
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Filters expenses to only non-recoverable ones and returns their total.
 */
function getTotalNonRecoverable(expenses: Expense[]): number {
  return expenses
    .filter((e) => e.classification === "non_recoverable")
    .reduce((sum, e) => sum + e.amount, 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. 3 tenants with equal sqft: each gets 1/3 of recoverable expenses
Deno.test("3 tenants with equal sqft each receive 1/3 of recoverable expenses", () => {
  const expenses: Expense[] = [
    { id: "e1", amount: 3000, classification: "recoverable" },
    { id: "e2", amount: 6000, classification: "recoverable" },
  ];
  const totalRecoverable = getTotalRecoverable(expenses); // 9000

  const tenants: Tenant[] = [
    { id: "t1", square_footage: 1000 },
    { id: "t2", square_footage: 1000 },
    { id: "t3", square_footage: 1000 },
  ];

  const allocations = allocateExpenses(totalRecoverable, tenants);

  assertEquals(allocations.length, 3, "Must have 3 allocations");
  for (const a of allocations) {
    assertAlmostEquals(
      a.allocation,
      3000,
      0.01,
      `Each tenant must receive 3000 (1/3 of 9000). Got ${a.allocation}`,
    );
  }
});

// 2. Base year exclusion: tenant only pays expenses above base_year_amount
Deno.test("Base year exclusion: tenant only pays expenses above base_year_amount", () => {
  const allocation = 5000;
  const baseYearAmount = 3000;

  const adjusted = applyBaseYearExclusion(allocation, baseYearAmount);
  assertAlmostEquals(
    adjusted,
    2000,
    0.01,
    `Adjusted allocation must be 5000 - 3000 = 2000. Got ${adjusted}`,
  );
});

Deno.test("Base year exclusion: result is zero when allocation <= base_year_amount", () => {
  const allocation = 2000;
  const baseYearAmount = 3000;

  const adjusted = applyBaseYearExclusion(allocation, baseYearAmount);
  assertEquals(adjusted, 0, "Adjusted allocation must be 0 when allocation <= base year amount");
});

Deno.test("Base year exclusion: no adjustment when base_year_amount is zero", () => {
  const allocation = 4500;
  const baseYearAmount = 0;

  const adjusted = applyBaseYearExclusion(allocation, baseYearAmount);
  assertAlmostEquals(adjusted, 4500, 0.01, "Allocation must be unchanged when base year is 0");
});

// 3. Non-recoverable expenses: not allocated to any tenant
Deno.test("Non-recoverable expenses are not allocated to tenants", () => {
  const expenses: Expense[] = [
    { id: "e1", amount: 5000, classification: "recoverable" },
    { id: "e2", amount: 3000, classification: "non_recoverable" },
    { id: "e3", amount: 2000, classification: "non_recoverable" },
  ];

  const totalRecoverable = getTotalRecoverable(expenses);
  const totalNonRecoverable = getTotalNonRecoverable(expenses);

  assertEquals(totalRecoverable, 5000, "Only recoverable expenses should be allocated");
  assertEquals(totalNonRecoverable, 5000, "Non-recoverable total must be 5000");

  const tenants: Tenant[] = [
    { id: "t1", square_footage: 500 },
    { id: "t2", square_footage: 500 },
  ];

  const allocations = allocateExpenses(totalRecoverable, tenants);
  const allocationSum = allocations.reduce((sum, a) => sum + a.allocation, 0);

  assertAlmostEquals(
    allocationSum,
    totalRecoverable,
    0.01,
    "Allocations must sum to recoverable total only (not including non-recoverable)",
  );

  // Verify non-recoverable amount is NOT included in allocations
  assert(
    allocationSum < totalRecoverable + totalNonRecoverable,
    "Allocations must not include non-recoverable expenses",
  );
});

Deno.test("Mixed expense types: only recoverable portion is distributed", () => {
  const expenses: Expense[] = [
    { id: "e1", amount: 1200, classification: "recoverable" },
    { id: "e2", amount: 800, classification: "non_recoverable" },
    { id: "e3", amount: 400, classification: "conditional" },
  ];

  const totalRecoverable = getTotalRecoverable(expenses);
  assertEquals(totalRecoverable, 1200, "Only recoverable expense should count");

  const tenants: Tenant[] = [
    { id: "t1", square_footage: 2000 },
    { id: "t2", square_footage: 2000 },
  ];

  const allocations = allocateExpenses(totalRecoverable, tenants);
  for (const a of allocations) {
    assertAlmostEquals(a.allocation, 600, 0.01, "Each tenant gets half of 1200 = 600");
  }
});
