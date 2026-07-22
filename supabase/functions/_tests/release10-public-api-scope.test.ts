import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { publicApiScopeDecision } from "../_shared/enterprise-control/public-api-governance.ts";

Deno.test("Release 10 public API credentials require explicit scopes", () => {
  const decision = publicApiScopeDecision({ active: true, scopes: ["leases.read"], rateLimit: { remaining: 1 } }, "exports.create");
  assertEquals(decision.allowed, false);
  assertEquals(decision.reasonCodes, ["api_scope_missing"]);
});