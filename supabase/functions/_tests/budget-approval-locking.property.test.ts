// @ts-nocheck
/**
 * Property-Based Test: Budget Approval Locking
 * Feature: backend-driven-pipeline, Task 12.3
 *
 * **Validates: Requirements 9.4**
 *
 * Property 32: A locked budget must not be modifiable (status stays 'locked').
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

type BudgetStatus = "draft" | "under_review" | "approved" | "locked" | string;

/**
 * Returns true if the budget can be modified (i.e. is not locked).
 */
function canModifyBudget(status: BudgetStatus): boolean {
  return status !== "locked";
}

/**
 * Valid budget status transitions.
 * Returns the new status if the transition is valid, or null if invalid.
 */
function transitionBudget(currentStatus: BudgetStatus, action: string): BudgetStatus | null {
  const transitions: Record<string, Record<string, BudgetStatus>> = {
    draft: { submit: "under_review" },
    under_review: { approve: "approved", reject: "draft" },
    approved: { lock: "locked" },
    locked: {}, // no valid transitions from locked
  };
  return transitions[currentStatus]?.[action] ?? null;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const anyStatusArb = fc.constantFrom("draft", "under_review", "approved", "locked", "unknown");
const anyActionArb = fc.constantFrom("submit", "approve", "reject", "lock", "edit", "delete");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 32: canModifyBudget('locked') is always false",
  fn: () => {
    fc.assert(
      fc.property(fc.constant("locked"), (status) => {
        const result = canModifyBudget(status);
        assertEquals(result, false, "A locked budget must never be modifiable");
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 32: locked budget has no valid transitions",
  fn: () => {
    fc.assert(
      fc.property(anyActionArb, (action) => {
        const result = transitionBudget("locked", action);
        assertEquals(
          result,
          null,
          `Locked budget must reject all transitions. Action '${action}' returned: ${result}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 32: non-locked statuses can be modified",
  fn: () => {
    fc.assert(
      fc.property(
        fc.constantFrom("draft", "under_review", "approved"),
        (status) => {
          const result = canModifyBudget(status);
          assert(result === true, `Status '${status}' should be modifiable`);
        },
      ),
      { numRuns: 100 },
    );
  },
});
