import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { legacyRetirementDecision } from "../_shared/enterprise-control/legacy-retirement.ts";

Deno.test("Release 10 legacy retirement fails when active usage exists", () => {
  const decision = legacyRetirementDecision({ activeUsageCount: 1, replacementParityVerified: true, rollbackAvailable: true, supportSignoff: true, securitySignoff: true });
  assertEquals(decision.allowed, false);
  assertEquals(decision.reasonCodes, ["legacy_usage_active"]);
});