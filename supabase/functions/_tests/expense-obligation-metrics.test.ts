// @ts-nocheck
// Phase 6A metrics tests (expense-obligation-metrics.ts, corrections G/H).
// Mutation detection is tested at the utility-function level (the correct,
// testable boundary) -- a deliberately-mutating test double proves the
// tripwire itself works, not just that real code happens to stay clean.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeCanonicalExpenseMetrics,
  emptyCanonicalExpenseMetrics,
  stableCanonicalize,
  deepEqual,
  countChangedPaths,
} from "../_shared/extraction/canonical/financial/expense-obligation-metrics.ts";

// ── runStatus (correction H) ─────────────────────────────────────────────────

Deno.test("emptyCanonicalExpenseMetrics: sets runStatus and zeroes every count", () => {
  const metrics = emptyCanonicalExpenseMetrics("specialist_output_missing");
  assertEquals(metrics.runStatus, "specialist_output_missing");
  assertEquals(metrics.canonicalObligationCount, 0);
  assertEquals(metrics.authoritativeMutationCount, 0);
});

Deno.test("computeCanonicalExpenseMetrics: runStatus 'success' vs 'no_obligations' distinguishes empty-because-nothing-found from empty-because-something-ran", () => {
  const base = {
    specialistObligationCount: 3,
    invalidObligationCount: 0,
    dedupResult: { duplicateObligationsCollapsed: 0, corroboratingEvidenceMerged: 0, conflictingObligations: 0 },
    canonicalMappings: [],
    dynamicRows: [],
    authoritativeMutationCount: 0,
  };
  const success = computeCanonicalExpenseMetrics({ ...base, runStatus: "success", finalObligations: [{ verificationStatus: "verified", requiresReview: false } as any] });
  const empty = computeCanonicalExpenseMetrics({ ...base, runStatus: "no_obligations", finalObligations: [] });
  assertEquals(success.runStatus, "success");
  assertEquals(success.canonicalObligationCount, 1);
  assertEquals(empty.runStatus, "no_obligations");
  assertEquals(empty.canonicalObligationCount, 0);
});

// ── Mutation detection (correction G) ────────────────────────────────────────

Deno.test("deepEqual/countChangedPaths: identical objects (different key order) are equal, zero changed paths", () => {
  const a = { x: 1, nested: { y: 2 } };
  const b = { nested: { y: 2 }, x: 1 };
  assert(deepEqual(a, b));
  assertEquals(countChangedPaths(a, b), 0);
});

Deno.test("mutation detection: a test double that deliberately mutates a snapshot object is caught -- authoritativeMutationCount > 0", () => {
  const authoritativePayload = { fieldSnapshot: { tenant_name: { value: "Acme Corp" } }, records: [{ fields: { monthly_rent: { value: 1200 } } }] };
  const before = stableCanonicalize(authoritativePayload);

  // Simulate exactly the bug this tripwire exists to catch: some code
  // downstream mutates a shared-reference object in place.
  (authoritativePayload as any).fieldSnapshot.tenant_name.value = "MUTATED";

  const after = stableCanonicalize(authoritativePayload);
  assertEquals(deepEqual(before, after), false, "the tripwire must detect the mutation, not silently pass");
  const changedPaths = countChangedPaths(before, after);
  assert(changedPaths > 0, `expected at least 1 changed path, got ${changedPaths}`);
});

Deno.test("mutation detection: an untouched authoritative payload always reports authoritativeMutationCount 0", () => {
  const authoritativePayload = { fieldSnapshot: { tenant_name: { value: "Acme Corp" } }, records: [{ fields: { monthly_rent: { value: 1200 } } }] };
  const before = stableCanonicalize(authoritativePayload);
  // ... no mutation happens here ...
  const after = stableCanonicalize(authoritativePayload);
  assertEquals(deepEqual(before, after), true);
  assertEquals(countChangedPaths(before, after), 0);
});

Deno.test("countChangedPaths: counts more than one changed leaf when multiple fields differ", () => {
  const before = { a: 1, b: 2, nested: { c: 3 } };
  const after = { a: 1, b: 99, nested: { c: 100 } };
  const changed = countChangedPaths(before, after);
  assertEquals(changed, 2);
});
