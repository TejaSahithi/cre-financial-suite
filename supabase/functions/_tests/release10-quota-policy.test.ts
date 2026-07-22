import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { quotaState } from "../_shared/enterprise-control/quota-policy.ts";

Deno.test("Release 10 hard quota blocks only the relevant operation", () => {
  const decision = quotaState({ softLimit: 80, hardLimit: 100 }, { currentValue: 100 });
  assertEquals(decision.state, "hard_limit");
  assertEquals(decision.operationAllowed, false);
});