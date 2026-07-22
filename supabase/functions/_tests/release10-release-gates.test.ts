import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateReleaseGates, RELEASE10_REQUIRED_GATES } from "../_shared/enterprise-control/release-gates.ts";

Deno.test("Release 10 release gates require every broad GA gate", () => {
  const results = Object.fromEntries(RELEASE10_REQUIRED_GATES.map((gate) => [gate, "passed"]));
  results.backup_health = "failed";
  const decision = evaluateReleaseGates(results);
  assertEquals(decision.passed, false);
  assertEquals(decision.failed, ["backup_health"]);
});