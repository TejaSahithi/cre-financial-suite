// @ts-nocheck
/**
 * Property-Based Test: CAM Exclusion Enforcement
 * Feature: backend-driven-pipeline, Task 10.3
 *
 * **Validates: Requirements 7.4**
 *
 * Property 27: For any lease with excluded_expenses categories, those categories
 * must not contribute to that tenant's CAM charge.
 * Property: result with exclusions <= result without exclusions.
 */

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper function
// ---------------------------------------------------------------------------

interface Expense {
  category: string;
  amount: number;
}

/**
 * Calculates a tenant's CAM charge, filtering out excluded categories
 * before computing pro-rata share.
 */
function calculateTenantCAM(
  expenses: Expense[],
  excludedCategories: string[],
  sqft: number,
  totalSqft: number,
): number {
  if (totalSqft === 0) return 0;
  const eligible = expenses.filter((e) => !excludedCategories.includes(e.category));
  const pool = eligible.reduce((sum, e) => sum + e.amount, 0);
  return (sqft / totalSqft) * pool;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const categories = ["management", "utilities", "maintenance", "insurance", "taxes", "admin"];

const expenseArb = fc.record({
  category: fc.constantFrom(...categories),
  amount: fc.float({ min: 0, max: 50000, noNaN: true }),
});

const camExclusionArb = fc.record({
  expenses: fc.array(expenseArb, { minLength: 1, maxLength: 15 }),
  excludedCategories: fc.array(fc.constantFrom(...categories), { minLength: 0, maxLength: 3 }),
  sqft: fc.integer({ min: 100, max: 10000 }),
  totalSqft: fc.integer({ min: 10000, max: 100000 }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 27: CAM with exclusions <= CAM without exclusions",
  fn: () => {
    fc.assert(
      fc.property(camExclusionArb, ({ expenses, excludedCategories, sqft, totalSqft }) => {
        const withExclusions = calculateTenantCAM(expenses, excludedCategories, sqft, totalSqft);
        const withoutExclusions = calculateTenantCAM(expenses, [], sqft, totalSqft);
        assert(
          withExclusions <= withoutExclusions + 1e-9,
          `CAM with exclusions (${withExclusions}) must be <= CAM without exclusions (${withoutExclusions})`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 27: excluded categories contribute zero to tenant CAM",
  fn: () => {
    fc.assert(
      fc.property(camExclusionArb, ({ expenses, excludedCategories, sqft, totalSqft }) => {
        if (excludedCategories.length === 0) return; // nothing to exclude
        // Build expenses that are ONLY excluded categories
        const onlyExcluded = expenses.filter((e) => excludedCategories.includes(e.category));
        if (onlyExcluded.length === 0) return;
        const chargeOnlyExcluded = calculateTenantCAM(onlyExcluded, excludedCategories, sqft, totalSqft);
        assert(
          chargeOnlyExcluded === 0,
          `Tenant CAM from only excluded categories must be 0, got ${chargeOnlyExcluded}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});
