import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { validateRuleReviewPayload } from "../_shared/lease-expense-rule-review-workflow.ts";

Deno.test("validateRuleReviewPayload requires rule_id and idempotency_key", () => {
  assertThrows(
    () => validateRuleReviewPayload({}, "approve"),
    Error,
    "rule_id is required",
  );

  assertThrows(
    () => validateRuleReviewPayload({ rule_id: "11111111-1111-4111-8111-111111111111" }, "approve"),
    Error,
    "idempotency_key is required",
  );
});

Deno.test("validateRuleReviewPayload normalizes supported actions and reason", () => {
  const payload = validateRuleReviewPayload({
    rule_id: "11111111-1111-4111-8111-111111111111",
    idempotency_key: "rule-review:1",
    reason: " clause accepted ",
  }, "approve");

  assertEquals(payload, {
    action: "approve",
    ruleId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "rule-review:1",
    reason: "clause accepted",
  });
});

Deno.test("validateRuleReviewPayload rejects unsupported actions", () => {
  assertThrows(
    () => validateRuleReviewPayload({
      rule_id: "11111111-1111-4111-8111-111111111111",
      idempotency_key: "rule-review:1",
    }, "publish"),
    Error,
    "action must be approve, reject, or not_applicable",
  );
});
