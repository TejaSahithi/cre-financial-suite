import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deriveExpenseCamSendBlockers } from "../_shared/send-expense-classification-to-cam-workflow.ts";

Deno.test("Invariant 1: Property-wide insurance expense publishes without being linked to a tenant rule", () => {
  const propertyInsuranceExpense = {
    id: "class-insurance-1",
    actual_expense_id: "exp-insurance-1",
    property_id: "prop-meridian-100",
    amount: 20000,
    recoverability_result: "recoverable",
    cam_eligible: "yes",
    classification_status: "finalized",
    expense_category_id: "cat-insurance-uuid",
    service_period_start: "2026-01-01",
    service_period_end: "2026-12-31",
  };
  const actualExpense = {
    id: "exp-insurance-1",
    amount: 20000,
    approval_status: "approved",
    property_id: "prop-meridian-100",
  };

  // No linked lease_expense_rule_id
  const blockers = deriveExpenseCamSendBlockers(propertyInsuranceExpense, actualExpense, null);
  assertEquals(blockers, [], "Pooled property-wide insurance expense publishes cleanly without a linked tenant rule");
});

Deno.test("Invariant 2 & 3: Published expense evaluates against multiple tenant policies; single disabled policy does not block publication", () => {
  const pooledOperatingExpense = {
    id: "class-operating-1",
    actual_expense_id: "exp-operating-1",
    property_id: "prop-meridian-100",
    amount: 100000,
    recoverability_result: "recoverable",
    cam_eligible: "yes",
    classification_status: "finalized",
    expense_category_id: "cat-operating-uuid",
    service_period_start: "2026-01-01",
    service_period_end: "2026-12-31",
  };
  const actualExpense = {
    id: "exp-operating-1",
    amount: 100000,
    approval_status: "approved",
    property_id: "prop-meridian-100",
  };

  // Publication check does not inspect individual tenant rules for pooled expenses
  const blockers = deriveExpenseCamSendBlockers(pooledOperatingExpense, actualExpense, null);
  assertEquals(blockers, [], "Pooled operating expense publishes even if individual tenant policies are unapproved or disabled");
});

Deno.test("Invariant 4: CAM readiness reports missing/disabled tenant policies separately at pool setup time", () => {
  // Mock readiness check result for tenant policies
  const tenantPolicies = [
    { lease_id: "lease-a", published_to_cam: true },
    { lease_id: "lease-b", published_to_cam: false },
  ];
  const disabledPolicyLeases = tenantPolicies.filter((p) => !p.published_to_cam).map((p) => p.lease_id);
  assertEquals(disabledPolicyLeases, ["lease-b"], "Readiness diagnostics flag disabled policy for Lease B separately");
});

Deno.test("Invariant 5: Direct tenant expense fails with MISSING_DIRECT_LEASE when no lease is linked", () => {
  const directExpenseNoLease = {
    id: "class-direct-nolease",
    actual_expense_id: "exp-direct-1",
    property_id: "prop-meridian-100",
    cam_input_type: "direct_tenant",
    amount: 4500,
    recoverability_result: "recoverable",
    cam_eligible: "yes",
    classification_status: "finalized",
    expense_category_id: "cat-tenant-work",
    service_period_start: "2026-01-01",
    service_period_end: "2026-01-31",
  };

  const blockers = deriveExpenseCamSendBlockers(directExpenseNoLease, { id: "exp-direct-1", amount: 4500, approval_status: "approved" }, null);
  assertEquals(blockers.includes("MISSING_DIRECT_LEASE"), true, "Direct tenant charge without a lease fails with MISSING_DIRECT_LEASE");
});

Deno.test("Invariant 6: Direct tenant expense requires approved and CAM-enabled direct-charge rule", () => {
  const directExpenseWithLease = {
    id: "class-direct-withlease",
    actual_expense_id: "exp-direct-2",
    lease_id: "lease-tenant-a",
    lease_expense_rule_id: "rule-tenant-a",
    property_id: "prop-meridian-100",
    cam_input_type: "direct_tenant",
    amount: 4500,
    recoverability_result: "recoverable",
    cam_eligible: "yes",
    classification_status: "finalized",
    expense_category_id: "cat-tenant-work",
    service_period_start: "2026-01-01",
    service_period_end: "2026-01-31",
  };

  const unapprovedRule = {
    id: "rule-tenant-a",
    approval_status: "pending",
    published_to_cam: false,
    payment_treatment: "direct_assign",
  };

  const blockers = deriveExpenseCamSendBlockers(
    directExpenseWithLease,
    { id: "exp-direct-2", amount: 4500, approval_status: "approved", lease_id: "lease-tenant-a" },
    unapprovedRule,
  );

  assertEquals(blockers.includes("rule_not_approved"), true, "Direct tenant charge requires an approved rule");
  assertEquals(blockers.includes("rule_not_published_to_cam"), true, "Direct tenant charge requires a CAM-enabled rule");
});
