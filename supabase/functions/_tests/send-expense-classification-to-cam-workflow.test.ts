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
  // CAM publication boundary hardening (20260905000000_cam_publication_rpcs.sql,
  // then 20269900000049_send_to_cam_fail_closed_gate.sql): classification_status
  // ='finalized', both the expense's and rule's own approval, a canonical
  // expense_category_id, a resolved property scope, and a valid service
  // period are all now required — this fixture reflects a genuinely
  // ready-to-publish row, not just a CAM-eligible one.
  const blockers = deriveExpenseCamSendBlockers(
    {
      id: "classification-1",
      actual_expense_id: "expense-1",
      lease_expense_rule_id: "rule-1",
      property_id: "property-1",
      amount: 100,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      classification_status: "finalized",
      sent_to_cam: false,
      expense_category_id: "category-1",
      service_period_start: "2026-01-01",
      service_period_end: "2026-01-31",
    },
    { id: "expense-1", amount: 100, approval_status: "approved" },
    { id: "rule-1", published_to_cam: true, payment_treatment: "reimbursable", approval_status: "approved" },
  );

  assertEquals(blockers, []);
});

Deno.test("deriveExpenseCamSendBlockers allows manual CAM send only with reason", () => {
  const classification = {
    id: "classification-1",
    actual_expense_id: "expense-1",
    property_id: "property-1",
    amount: 100,
    recoverability_result: "needs_review",
    cam_eligible: "yes",
    classification_status: "finalized",
    expense_category_id: "category-1",
    service_period_start: "2026-01-01",
    service_period_end: "2026-01-31",
  };
  const expense = { id: "expense-1", amount: 100, approval_status: "approved" };

  assertEquals(deriveExpenseCamSendBlockers(classification, expense, null), ["manual_reason_required"]);
  assertEquals(deriveExpenseCamSendBlockers(classification, expense, null, "reviewed manually"), []);
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

Deno.test("deriveExpenseCamSendBlockers reports not_categorized, invalid_scope, missing_service_period individually", () => {
  const base = {
    id: "classification-1",
    actual_expense_id: "expense-1",
    lease_expense_rule_id: "rule-1",
    amount: 100,
    recoverability_result: "recoverable",
    cam_eligible: "yes",
    classification_status: "finalized",
  };
  const expense = { id: "expense-1", amount: 100, approval_status: "approved", property_id: null };
  const rule = { id: "rule-1", published_to_cam: true, payment_treatment: "reimbursable", approval_status: "approved" };

  const noCategory = deriveExpenseCamSendBlockers(
    { ...base, property_id: "property-1", service_period_start: "2026-01-01", service_period_end: "2026-01-31" },
    expense,
    rule,
  );
  assertEquals(noCategory, ["not_categorized"]);

  const noScope = deriveExpenseCamSendBlockers(
    { ...base, expense_category_id: "category-1", service_period_start: "2026-01-01", service_period_end: "2026-01-31" },
    expense,
    rule,
  );
  assertEquals(noScope, ["invalid_scope"]);

  const noServicePeriod = deriveExpenseCamSendBlockers(
    { ...base, property_id: "property-1", expense_category_id: "category-1" },
    expense,
    rule,
  );
  assertEquals(noServicePeriod, ["missing_service_period"]);
});

Deno.test("deriveExpenseCamSendBlockers reports rule_superseded for a superseded linked rule", () => {
  const blockers = deriveExpenseCamSendBlockers(
    {
      id: "classification-1",
      actual_expense_id: "expense-1",
      lease_expense_rule_id: "rule-1",
      property_id: "property-1",
      amount: 100,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      classification_status: "finalized",
      expense_category_id: "category-1",
      service_period_start: "2026-01-01",
      service_period_end: "2026-01-31",
    },
    { id: "expense-1", amount: 100, approval_status: "approved" },
    { id: "rule-1", published_to_cam: true, payment_treatment: "reimbursable", approval_status: "superseded" },
  );

  assertEquals(blockers.includes("rule_superseded"), true);
});
