import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  deriveExpenseCamSendBlockers,
  validateExpenseCamSendPayload,
} from "../_shared/send-expense-classification-to-cam-workflow.ts";

Deno.test("validateExpenseCamSendPayload requires classification_id and idempotency_key", () => {
  assertThrows(
    () => validateExpenseCamSendPayload({}),
    Error,
    "classification_id is required",
  );
  assertThrows(
    () => validateExpenseCamSendPayload({ classification_id: "11111111-1111-4111-8111-111111111111" }),
    Error,
    "idempotency_key is required",
  );
});

Deno.test("deriveExpenseCamSendBlockers allows automatic approved CAM-ready classification", () => {
  const blockers = deriveExpenseCamSendBlockers(
    {
      id: "classification-1",
      actual_expense_id: "expense-1",
      lease_expense_rule_id: "rule-1",
      amount: 100,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      sent_to_cam: false,
    },
    { id: "expense-1", amount: 100 },
    { id: "rule-1", published_to_cam: true, payment_treatment: "reimbursable" },
  );

  assertEquals(blockers, []);
});

Deno.test("deriveExpenseCamSendBlockers allows manual CAM send only with reason", () => {
  const classification = {
    id: "classification-1",
    actual_expense_id: "expense-1",
    amount: 100,
    recoverability_result: "needs_review",
    cam_eligible: "yes",
  };

  assertEquals(deriveExpenseCamSendBlockers(classification, { id: "expense-1", amount: 100 }, null), ["manual_reason_required"]);
  assertEquals(deriveExpenseCamSendBlockers(classification, { id: "expense-1", amount: 100 }, null, "reviewed manually"), []);
});

Deno.test("deriveExpenseCamSendBlockers handles already sent and blocking reasons", () => {
  assertEquals(deriveExpenseCamSendBlockers({ sent_to_cam: true }), ["already_sent"]);

  const blockers = deriveExpenseCamSendBlockers(
    {
      amount: 0,
      recoverability_result: "recoverable",
      cam_eligible: "no",
    },
    null,
    { payment_treatment: "tenant_direct_contract", is_excluded: true },
  );

  assertEquals(blockers.includes("missing_actual_or_rule"), true);
  assertEquals(blockers.includes("missing_amount"), true);
  assertEquals(blockers.includes("not_cam_eligible"), true);
  assertEquals(blockers.includes("explicit_exclusion"), true);
  assertEquals(blockers.includes("manual_reason_required"), true);
});
