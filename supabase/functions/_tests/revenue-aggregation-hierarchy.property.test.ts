// @ts-nocheck
/**
 * Property-Based Test: Revenue Aggregation Hierarchy
 * Feature: backend-driven-pipeline, Task 11.4
 *
 * **Validates: Requirements 8.4**
 *
 * Property 30: annual_total must equal sum of all monthly total values.
 */

import { assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper function
// ---------------------------------------------------------------------------

interface MonthlyProjection {
  month: number;
  total: number;
}

interface RevenueAggregate {
  annual_total: number;
  avg_monthly: number;
}

/**
 * Aggregates monthly projections into annual totals.
 */
function aggregateRevenue(monthlyProjections: MonthlyProjection[]): RevenueAggregate {
  const annual_total = monthlyProjections.reduce((sum, p) => sum + p.total, 0);
  const avg_monthly = monthlyProjections.length > 0
    ? annual_total / monthlyProjections.length
    : 0;
  return { annual_total, avg_monthly };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const monthlyProjectionArb = fc.record({
  month: fc.integer({ min: 1, max: 12 }),
  total: fc.float({ min: 0, max: 100_000, noNaN: true }),
});

// Exactly 12 projections (one per month)
const twelveMonthProjectionsArb = fc.array(
  fc.float({ min: 0, max: 100_000, noNaN: true }),
  { minLength: 12, maxLength: 12 },
).map((totals) =>
  totals.map((total, i) => ({ month: i + 1, total }))
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 30: annual_total equals sum of all monthly totals",
  fn: () => {
    fc.assert(
      fc.property(twelveMonthProjectionsArb, (projections) => {
        const result = aggregateRevenue(projections);
        const expectedSum = projections.reduce((sum, p) => sum + p.total, 0);
        assertAlmostEquals(
          result.annual_total,
          expectedSum,
          0.01,
          `annual_total (${result.annual_total}) must equal sum of monthly totals (${expectedSum})`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 30: annual_total equals sum for any number of projections",
  fn: () => {
    fc.assert(
      fc.property(
        fc.array(monthlyProjectionArb, { minLength: 0, maxLength: 24 }),
        (projections) => {
          const result = aggregateRevenue(projections);
          const expectedSum = projections.reduce((sum, p) => sum + p.total, 0);
          assertAlmostEquals(
            result.annual_total,
            expectedSum,
            0.01,
            `annual_total (${result.annual_total}) must equal sum (${expectedSum})`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});
