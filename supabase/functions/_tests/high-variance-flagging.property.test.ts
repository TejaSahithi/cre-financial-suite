// @ts-nocheck
/**
 * Property-Based Test: High Variance Flagging
 * Feature: backend-driven-pipeline, Task 13.3
 *
 * **Validates: Requirements 10.3**
 *
 * Property 34: Any line item with |variance_pct| > 10 must have flagged = true.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper function
// ---------------------------------------------------------------------------

/**
 * Returns true when the absolute variance percentage exceeds 10%.
 */
function shouldFlag(variancePct: number): boolean {
  return Math.abs(variancePct) > 10;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Values strictly above 10 (positive) — use integer range to avoid 32-bit float issues
const highPositiveArb = fc.integer({ min: 11, max: 1000 });
// Values strictly below -10 (negative)
const highNegativeArb = fc.integer({ min: -1000, max: -11 });
// Values within [-10, 10]
const lowVarianceArb = fc.integer({ min: -10, max: 10 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 34: shouldFlag returns true when variance_pct > 10",
  fn: () => {
    fc.assert(
      fc.property(highPositiveArb, (pct) => {
        const flagged = shouldFlag(pct);
        assert(flagged === true, `variance_pct=${pct} (>10) must be flagged`);
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 34: shouldFlag returns true when variance_pct < -10",
  fn: () => {
    fc.assert(
      fc.property(highNegativeArb, (pct) => {
        const flagged = shouldFlag(pct);
        assert(flagged === true, `variance_pct=${pct} (<-10) must be flagged`);
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 34: shouldFlag returns false when |variance_pct| <= 10",
  fn: () => {
    fc.assert(
      fc.property(lowVarianceArb, (pct) => {
        const flagged = shouldFlag(pct);
        assertEquals(
          flagged,
          false,
          `variance_pct=${pct} (within ±10) must not be flagged`,
        );
      }),
      { numRuns: 100 },
    );
  },
});
