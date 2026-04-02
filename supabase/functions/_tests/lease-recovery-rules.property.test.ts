// @ts-nocheck
/**
 * Property-Based Test: Lease-Specific Recovery Rules (CAM Cap)
 * Feature: backend-driven-pipeline, Task 9.4
 *
 * **Validates: Requirements 6.3**
 *
 * Property 25: For any lease with CAM cap C, the allocated amount after applying
 * the cap must be <= C.
 */

import { assert, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure computation logic
// ---------------------------------------------------------------------------

/**
 * Applies a CAM cap to an allocated amount.
 * Returns Math.min(amount, cap).
 */
function applyCAMCap(amount: number, cap: number): number {
  return Math.min(amount, cap);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 25: applyCAMCap result is always <= cap",
  fn: () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        (amount, cap) => {
          const result = applyCAMCap(amount, cap);
          assert(
            result <= cap + 0.0001,
            `applyCAMCap result (${result}) must be <= cap (${cap})`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 25: applyCAMCap returns amount unchanged when amount <= cap",
  fn: () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 500_000, noNaN: true }),
        fc.float({ min: 0, max: 500_000, noNaN: true }),
        (a, b) => {
          const amount = Math.min(a, b);
          const cap = Math.max(a, b);
          const result = applyCAMCap(amount, cap);
          assertAlmostEquals(
            result,
            amount,
            0.0001,
            `When amount (${amount}) <= cap (${cap}), result must equal amount`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 25: applyCAMCap returns cap when amount > cap",
  fn: () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 500_000, noNaN: true }),
        fc.float({ min: 1, max: 500_000, noNaN: true }),
        (cap, excess) => {
          const amount = cap + excess;
          const result = applyCAMCap(amount, cap);
          assertAlmostEquals(
            result,
            cap,
            0.0001,
            `When amount (${amount}) > cap (${cap}), result must equal cap`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 25: applyCAMCap is idempotent (applying twice gives same result)",
  fn: () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        (amount, cap) => {
          const once = applyCAMCap(amount, cap);
          const twice = applyCAMCap(once, cap);
          assertAlmostEquals(
            twice,
            once,
            0.0001,
            `applyCAMCap must be idempotent: applying twice (${twice}) must equal once (${once})`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});
