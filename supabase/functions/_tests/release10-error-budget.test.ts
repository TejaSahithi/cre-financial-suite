import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateErrorBudget } from "../_shared/enterprise-control/error-budget.ts";

Deno.test("Release 10 error budget blocks rollout when exhausted", () => {
  const snapshot = calculateErrorBudget({ service: "review", window: "30d", objective: 0.999, totalRequests: 1000, successfulRequests: 990 });
  assertEquals(snapshot.rolloutAllowed, false);
  assertEquals(snapshot.reasonCodes, ["error_budget_exhausted"]);
});