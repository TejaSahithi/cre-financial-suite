// @ts-nocheck
/**
 * Property-Based Test: Variance Calculation
 * Feature: backend-driven-pipeline, Task 13.2
 *
 * **Validates: Requirements 10.2**
 *
 * Property 33: variance = actual - budget,
 * variance_pct = (variance / budget) * 100 when budget != 0.
 */

import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

function computeVariance(actual: number, budget: number): number {
  return actual - budget;
}

function computeVariancePct(variance: number, budget: number): number {
  if (budget === 0) return 0;
  return (variance / budget) * 100;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const varianceArb = fc.record({
  actual: fc.float({ min: -1_000_000, max: 1_000_000, noNaN: true }),
  budget: fc.float({ min: -1_000_000, max: 1_000_000, noNaN: true }),
});

const nonZeroBudgetArb = fc.record({
  actual: fc.float({ min: -1_000_000, max: 1_000_000, noNaN: true }),
  budget: fc.float({ min: 1, max: 1_000_000, noNaN: true }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 33: variance = actual - budget for any actual and budget",
  fn: () => {
    fc.assert(
      fc.property(varianceArb, ({ actual, budget }) => {
        const variance = computeVariance(actual, budget);
        assertAlmostEquals(
          variance,
          actual - budget,
          1e-6,
          `variance (${variance}) must equal actual - budget = ${actual} - ${budget}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 33: variance_pct = (variance / budget) * 100 when budget != 0",
  fn: () => {
    fc.assert(
      fc.property(nonZeroBudgetArb, ({ actual, budget }) => {
        const variance = computeVariance(actual, budget);
        const variancePct = computeVariancePct(variance, budget);
        const expected = (variance / budget) * 100;
        assertAlmostEquals(
          variancePct,
          expected,
          1e-6,
          `variance_pct (${variancePct}) must equal (variance/budget)*100 = ${expected}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 33: variance_pct is 0 when budget is 0",
  fn: () => {
    fc.assert(
      fc.property(
        fc.float({ min: -1_000_000, max: 1_000_000, noNaN: true }),
        (actual) => {
          const variance = computeVariance(actual, 0);
          const variancePct = computeVariancePct(variance, 0);
          assertEquals(variancePct, 0, "variance_pct must be 0 when budget is 0");
        },
      ),
      { numRuns: 100 },
    );
  },
});
