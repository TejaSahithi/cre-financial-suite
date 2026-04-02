// @ts-nocheck
/**
 * Property-Based Test: Base Year Expense Recovery
 * Feature: backend-driven-pipeline, Task 8.10
 *
 * **Validates: Requirements 5.5**
 *
 * Property 21: For any lease with base_year config, recovery amount must be >= 0 (never negative).
 * recovery = max(0, current_expenses - base_year_expenses)
 */

import { assert, assertGreaterOrEqual } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure computation logic
// ---------------------------------------------------------------------------

/**
 * Calculates base year expense recovery.
 * recovery = max(0, currentExpenses - baseYearExpenses)
 */
function computeBaseYearRecovery(currentExpenses: number, baseYearExpenses: number): number {
  return Math.max(0, currentExpenses - baseYearExpenses);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 21: Base year recovery is never negative for any expense amounts",
  fn: () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (currentExpenses, baseYearExpenses) => {
          const recovery = computeBaseYearRecovery(currentExpenses, baseYearExpenses);
          assertGreaterOrEqual(
            recovery,
            0,
            `Recovery must be >= 0. Got ${recovery} for current=${currentExpenses}, base=${baseYearExpenses}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 21: Recovery is zero when current expenses <= base year expenses",
  fn: () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (a, b) => {
          // Ensure current <= base
          const currentExpenses = Math.min(a, b);
          const baseYearExpenses = Math.max(a, b);
          const recovery = computeBaseYearRecovery(currentExpenses, baseYearExpenses);
          assert(
            recovery === 0,
            `Recovery must be 0 when current (${currentExpenses}) <= base (${baseYearExpenses}). Got ${recovery}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 21: Recovery equals the excess when current expenses exceed base year",
  fn: () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        (baseYearExpenses, excess) => {
          const currentExpenses = baseYearExpenses + excess;
          const recovery = computeBaseYearRecovery(currentExpenses, baseYearExpenses);
          assert(
            recovery === excess,
            `Recovery must equal excess (${excess}) when current (${currentExpenses}) > base (${baseYearExpenses}). Got ${recovery}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});
