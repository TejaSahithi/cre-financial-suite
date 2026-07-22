import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { legalHoldDecision } from "../_shared/enterprise-control/legal-hold-policy.ts";

Deno.test("Release 10 legal hold prevents deletion", () => {
  const decision = legalHoldDecision({ legalHold: true }, {});
  assertEquals(decision.blocked, true);
  assertEquals(decision.reasonCodes, ["legal_hold_active"]);
});