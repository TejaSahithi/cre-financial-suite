// Enterprise CAM & Budget Implementation Blueprint v1.0 — Workstream B.3
// unit tests for the pure largest-remainder residual allocation algorithm.
// Orchestrator-level integration (capped tenants, direct allocations,
// multiple pools) is covered separately in cam-engine-v2-golden.test.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyLargestRemainderAllocation } from "../_shared/cam-engine-v2/reconciliation/residual-allocation.ts";

Deno.test("residual allocation: naive rounding already ties out exactly -> zero residual, no adjustments", () => {
  const outcome = applyLargestRemainderAllocation(
    [{ key: "a", rawAmount: 50 }, { key: "b", rawAmount: 50 }],
    100, 2,
  );
  assertEquals(outcome.residualUnitsDistributed, 0);
  assertEquals(outcome.results.every((r) => r.residualAdjustment === 0), true);
  assertEquals(outcome.results.reduce((s, r) => s + r.finalAmount, 0), 100);
});

Deno.test("residual allocation: positive residual (naive sum undershoots) is added to the largest-remainder candidates first", () => {
  // 100 / 3 = 33.333... each; naive rounding to cents gives 33.33 * 3 = 99.99, short by 1 cent.
  const outcome = applyLargestRemainderAllocation(
    [{ key: "lease-1", rawAmount: 33.3333 }, { key: "lease-2", rawAmount: 33.3333 }, { key: "lease-3", rawAmount: 33.3334 }],
    100, 2,
  );
  assertEquals(outcome.residualUnitsDistributed, 1);
  const total = outcome.results.reduce((s, r) => s + r.finalAmount, 0);
  assertEquals(total, 100);
  // lease-3 has the largest raw value (and thus is tied for largest remainder among equals) -- exactly one candidate got +0.01.
  const adjusted = outcome.results.filter((r) => r.residualAdjustment !== 0);
  assertEquals(adjusted.length, 1);
  assertEquals(adjusted[0].residualAdjustment, 0.01);
});

Deno.test("residual allocation: negative residual (naive sum overshoots) removes from the smallest-remainder candidates first", () => {
  // Three candidates whose naive rounding sums to MORE than the target.
  const outcome = applyLargestRemainderAllocation(
    [{ key: "a", rawAmount: 10.006 }, { key: "b", rawAmount: 10.006 }, { key: "c", rawAmount: 10.006 }],
    30, 2,
  );
  // naive: each rounds to 10.01 (three of them = 30.03), target = 30.00 -> residual = -3 units (-0.03)
  const total = outcome.results.reduce((s, r) => s + r.finalAmount, 0);
  assertEquals(total, 30);
  assertEquals(outcome.residualUnitsDistributed, 3);
  assertEquals(outcome.results.every((r) => r.residualAdjustment === -0.01), true);
});

Deno.test("residual allocation: equal fractional remainders use the stable key tie-breaker, not array order", () => {
  // All three candidates have IDENTICAL raw values -> identical remainders. Residual distribution must be decided by key, not input order.
  const outcomeA = applyLargestRemainderAllocation(
    [{ key: "z-lease", rawAmount: 33.335 }, { key: "a-lease", rawAmount: 33.335 }, { key: "m-lease", rawAmount: 33.335 }],
    100.01, 2,
  );
  const outcomeB = applyLargestRemainderAllocation(
    // Same candidates, different array order.
    [{ key: "m-lease", rawAmount: 33.335 }, { key: "z-lease", rawAmount: 33.335 }, { key: "a-lease", rawAmount: 33.335 }],
    100.01, 2,
  );
  const byKey = (o: typeof outcomeA) => Object.fromEntries(o.results.map((r) => [r.key, r.finalAmount]));
  assertEquals(byKey(outcomeA), byKey(outcomeB));
  // All three have an identical (negative) remainder here (naive rounding overshoots 100.01 by
  // one cent: 33.34*3 = 100.02), so the tie-breaker is ascending key -- "a-lease" (alphabetically
  // first) absorbs the -0.01 adjustment, independent of the two calls' different array order.
  assertEquals(byKey(outcomeA)["a-lease"], 33.33);
  assertEquals(byKey(outcomeA)["m-lease"], 33.34);
  assertEquals(byKey(outcomeA)["z-lease"], 33.34);
});

Deno.test("residual allocation: stable deterministic rerun -- identical input produces byte-identical output", () => {
  const candidates = [{ key: "lease-1", rawAmount: 12.3456 }, { key: "lease-2", rawAmount: 45.6789 }, { key: "lease-3", rawAmount: 22.2222 }];
  const run1 = applyLargestRemainderAllocation(candidates, 80.25, 2);
  const run2 = applyLargestRemainderAllocation(candidates, 80.25, 2);
  assertEquals(run1, run2);
});

Deno.test("residual allocation: large number of candidates still sums exactly to the target", () => {
  const n = 500;
  const perShare = 100000 / n; // deliberately not a clean 2-decimal number
  const candidates = Array.from({ length: n }, (_, i) => ({ key: `lease-${String(i).padStart(4, "0")}`, rawAmount: perShare }));
  const outcome = applyLargestRemainderAllocation(candidates, 100000, 2);
  const total = outcome.results.reduce((s, r) => s + r.finalAmount, 0);
  assertEquals(Math.round(total * 100) / 100, 100000);
});

Deno.test("residual allocation: single candidate absorbs the full amount with no residual math needed", () => {
  const outcome = applyLargestRemainderAllocation([{ key: "only", rawAmount: 99.995 }], 100, 2);
  assertEquals(outcome.results[0].finalAmount, 100);
});
