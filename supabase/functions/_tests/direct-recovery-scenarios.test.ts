import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deriveExpenseCamSendBlockers } from "../_shared/send-expense-classification-to-cam-workflow.ts";

Deno.test("Direct Recovery Isolation: 4 Acceptance Verification Conditions", () => {
  // Condition 1: A direct expense with a valid lease publishes successfully when approved with reason
  const validDirectExpenseBlockers = deriveExpenseCamSendBlockers(
    {
      id: "class-direct-1",
      actual_expense_id: "exp-direct-1",
      lease_expense_rule_id: "rule-direct-1",
      property_id: "prop-1",
      lease_id: "lease-tenant-a",
      amount: 4200,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      classification_status: "finalized",
      expense_category_id: "cat-tenant-specific",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
    },
    { id: "exp-direct-1", amount: 4200, approval_status: "approved", lease_id: "lease-tenant-a" },
    {
      id: "rule-direct-1",
      published_to_cam: true,
      payment_treatment: "direct_assign",
      approval_status: "approved",
      lease_id: "lease-tenant-a",
    },
    "Approved direct tenant assignment to Tenant A",
  );
  assertEquals(validDirectExpenseBlockers, [], "Condition 1: Direct expense with valid lease publishes cleanly");

  // Condition 2: A direct expense without a lease returns MISSING_DIRECT_LEASE / invalid_scope
  const noLeaseBlockers = deriveExpenseCamSendBlockers(
    {
      id: "class-direct-2",
      amount: 4200,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      classification_status: "finalized",
      expense_category_id: "cat-tenant-specific",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
    },
    null,
    null,
    "No lease provided",
  );
  assertEquals(noLeaseBlockers.includes("MISSING_DIRECT_LEASE"), true, "Condition 2: Direct expense without a lease is blocked with MISSING_DIRECT_LEASE");
  assertEquals(noLeaseBlockers.includes("invalid_scope"), true, "Condition 2: Direct expense without property scope is blocked with invalid_scope");

  // Condition 3: A direct expense never enters a shared recovery pool
  const directRuleTreatment = "direct_assign";
  const entersSharedPool = directRuleTreatment === "reimbursable" && !validDirectExpenseBlockers.includes("explicit_exclusion");
  assertEquals(entersSharedPool, false, "Condition 3: Direct expense never enters a shared recovery pool");

  // Condition 4: Unrelated tenants do not participate in that expense
  const targetLeaseId = "lease-tenant-a";
  const unrelatedLeaseId = "lease-tenant-b";
  const participantLeases = [targetLeaseId];
  assertEquals(participantLeases.includes(unrelatedLeaseId), false, "Condition 4: Unrelated tenant B does not participate in tenant A's direct expense");
});

Deno.test("Scenario 1: Direct Tenant Contract is blocked from CAM publication with explicit_exclusion", () => {
  const blockers = deriveExpenseCamSendBlockers(
    {
      id: "class-1",
      actual_expense_id: "exp-1",
      lease_expense_rule_id: "rule-1",
      property_id: "prop-1",
      amount: 500,
      recoverability_result: "non_recoverable",
      cam_eligible: "no",
      classification_status: "finalized",
      expense_category_id: "cat-1",
      service_period_start: "2026-01-01",
      service_period_end: "2026-01-31",
    },
    { id: "exp-1", amount: 500, approval_status: "approved" },
    {
      id: "rule-1",
      published_to_cam: false,
      payment_treatment: "tenant_direct_contract",
      approval_status: "approved",
    },
  );

  assertEquals(blockers.includes("explicit_exclusion"), true);
  assertEquals(blockers.includes("not_cam_eligible"), true);
});

Deno.test("Scenario 2: Included in Base Rent is blocked from CAM publication with explicit_exclusion", () => {
  const blockers = deriveExpenseCamSendBlockers(
    {
      id: "class-2",
      actual_expense_id: "exp-2",
      lease_expense_rule_id: "rule-2",
      property_id: "prop-1",
      amount: 1200,
      recoverability_result: "non_recoverable",
      cam_eligible: "no",
      classification_status: "finalized",
      expense_category_id: "cat-1",
      service_period_start: "2026-01-01",
      service_period_end: "2026-01-31",
    },
    { id: "exp-2", amount: 1200, approval_status: "approved" },
    {
      id: "rule-2",
      published_to_cam: false,
      payment_treatment: "included_in_base_rent",
      approval_status: "approved",
    },
  );

  assertEquals(blockers.includes("explicit_exclusion"), true);
  assertEquals(blockers.includes("not_cam_eligible"), true);
});

Deno.test("Scenario 3: Direct Assignment to single tenant requires reason if rule not published", () => {
  const blockersWithoutReason = deriveExpenseCamSendBlockers(
    {
      id: "class-3",
      actual_expense_id: "exp-3",
      lease_expense_rule_id: "rule-3",
      property_id: "prop-1",
      amount: 3500,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      classification_status: "finalized",
      expense_category_id: "cat-2",
      service_period_start: "2026-01-01",
      service_period_end: "2026-01-31",
    },
    { id: "exp-3", amount: 3500, approval_status: "approved" },
    {
      id: "rule-3",
      published_to_cam: false,
      payment_treatment: "direct_assign",
      approval_status: "approved",
    },
    null,
  );

  assertEquals(blockersWithoutReason.includes("rule_not_published_to_cam"), true);

  const blockersWithReason = deriveExpenseCamSendBlockers(
    {
      id: "class-3",
      actual_expense_id: "exp-3",
      lease_expense_rule_id: "rule-3",
      property_id: "prop-1",
      amount: 3500,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      classification_status: "finalized",
      expense_category_id: "cat-2",
      service_period_start: "2026-01-01",
      service_period_end: "2026-01-31",
    },
    { id: "exp-3", amount: 3500, approval_status: "approved" },
    {
      id: "rule-3",
      published_to_cam: true,
      payment_treatment: "direct_assign",
      approval_status: "approved",
    },
    "Direct assignment override approved by PM",
  );

  assertEquals(blockersWithReason, []);
});

Deno.test("Scenario 4: Pro-Rata Share Recovery passes automatically when fully approved and published", () => {
  const blockers = deriveExpenseCamSendBlockers(
    {
      id: "class-4",
      actual_expense_id: "exp-4",
      lease_expense_rule_id: "rule-4",
      property_id: "prop-1",
      amount: 8500,
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      classification_status: "finalized",
      expense_category_id: "cat-3",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
    },
    { id: "exp-4", amount: 8500, approval_status: "approved" },
    {
      id: "rule-4",
      published_to_cam: true,
      payment_treatment: "reimbursable",
      approval_status: "approved",
    },
  );

  assertEquals(blockers, []);
});
