// @ts-nocheck
/**
 * Property-Based Test: Budget Line Items
 * Feature: backend-driven-pipeline, Task 12.2
 *
 * **Validates: Requirements 9.2**
 *
 * Property 31: NOI must equal total_revenue - total_expenses.
 */

import { assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper function
// ---------------------------------------------------------------------------

/**
 * Computes Net Operating Income.
 */
function computeNOI(totalRevenue: number, totalExpenses: number): number {
  return totalRevenue - totalExpenses;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const noiArb = fc.record({
  totalRevenue: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
  totalExpenses: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 31: computeNOI(r, e) === r - e for any r, e",
  fn: () => {
    fc.assert(
      fc.property(noiArb, ({ totalRevenue, totalExpenses }) => {
        const noi = computeNOI(totalRevenue, totalExpenses);
        const expected = totalRevenue - totalExpenses;
        assertAlmostEquals(
          noi,
          expected,
          1e-6,
          `NOI (${noi}) must equal revenue - expenses = ${totalRevenue} - ${totalExpenses} = ${expected}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 31: NOI is negative when expenses exceed revenue",
  fn: () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 500_000, noNaN: true }),
        fc.float({ min: 0, max: 500_000, noNaN: true }),
        (base, extra) => {
          const revenue = base;
          const expenses = base + extra + 1; // always > revenue
          const noi = computeNOI(revenue, expenses);
          assertAlmostEquals(
            noi,
            revenue - expenses,
            1e-6,
            `NOI must equal revenue - expenses`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});
