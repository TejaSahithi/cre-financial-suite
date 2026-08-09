// @ts-nocheck
import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";

/**
 * Phase 5A Governance & Security Hardening Unit Tests:
 *   1. Frozen Historical Role-at-Approval Preservation
 *   2. Server-Side Financial Tie-Out Verification
 *   3. Strict Status = 'locked' Enforcement for Approved Export
 *   4. File Naming Rules & Watermarks
 */

// ── Mock Helper ─────────────────────────────────────────────────────────────

function mockLockedBudget(overrides = {}) {
  return {
    id: overrides.id || "budget-locked-123",
    org_id: overrides.org_id || "org-1",
    property_id: overrides.property_id || "prop-1",
    budget_year: 2027,
    status: overrides.status || "locked",
    total_revenue: 210000,
    total_expenses: 150000,
    cam_total: 25000,
    noi: overrides.noi !== undefined ? overrides.noi : 60000,
    approved_at: "2026-08-08T12:00:00Z",
    approved_by: "user-owner-1",
    approved_by_role: overrides.approved_by_role || "owner", // Frozen role-at-approval
    approval_comment: "Approved FY2027 budget",
    locked_at: "2026-08-08T12:00:00Z",
    locked_by: "user-owner-1",
    version_hash: "hash-12345",
  };
}

function mockLineItems() {
  return [
    { line_type: "expense", category: "utilities", amount: 50000 },
    { line_type: "expense", category: "maintenance", amount: 100000 },
    { line_type: "revenue", category: "base_rent", amount: 180000 },
    { line_type: "revenue", category: "other_income", amount: 5000 },
    { line_type: "revenue", category: "cam_recovery", amount: 25000 },
  ];
}

// ── Pure Payload Helper ─────────────────────────────────────────────────────

function resolveApproverRole(budget, currentProfileRole) {
  // Historical role-at-approval (budget.approved_by_role) is authoritative over currentProfileRole
  return budget.approved_by_role || currentProfileRole || "owner_or_org_admin";
}

function validateApprovedStatusRequirement(budget) {
  if (budget.status !== "locked") {
    throw new Error(`Approved budget export requires status='locked'. Current status is '${budget.status}'.`);
  }
  return true;
}

function validateExportPayloadTieOuts(budget, lineItems) {
  const totalRevenue = Number(budget.total_revenue);
  const totalExpenses = Number(budget.total_expenses);
  const noi = Number(budget.noi);

  // 1. NOI tie-out
  if (Math.abs((totalRevenue - totalExpenses) - noi) > 0.02) {
    throw new Error(`[tie-out error] NOI (${noi}) does not match Total Revenue (${totalRevenue}) - Total Expenses (${totalExpenses})`);
  }

  // 2. Line items tie-out
  const expSum = lineItems
    .filter((li) => li.line_type === "expense")
    .reduce((s, li) => s + Number(li.amount), 0);
  const revSum = lineItems
    .filter((li) => li.line_type === "revenue")
    .reduce((s, li) => s + Number(li.amount), 0);

  if (Math.abs(expSum - totalExpenses) > 0.02) {
    throw new Error(`[tie-out error] Line item expense sum (${expSum}) does not match budget.total_expenses (${totalExpenses})`);
  }
  if (Math.abs(revSum - totalRevenue) > 0.02) {
    throw new Error(`[tie-out error] Line item revenue sum (${revSum}) does not match budget.total_revenue (${totalRevenue})`);
  }

  return true;
}

function resolveFilename(budget, propertyName) {
  const sanitize = (s) => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const isLocked = budget.status === "locked";
  return `${sanitize(propertyName)}_FY${budget.budget_year}_${isLocked ? "Approved" : "DRAFT"}_Budget.xlsx`;
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test("Phase 5A Governance: Preserves historical role-at-approval even if current membership role changes", () => {
  // Owner approved Budget A when role was 'owner'
  const budget = mockLockedBudget({ approved_by_role: "owner" });

  // Later user's profile role changes to 'analyst'
  const currentProfileRole = "analyst";

  const resolvedRole = resolveApproverRole(budget, currentProfileRole);
  assertEquals(resolvedRole, "owner"); // Must still return 'owner', NOT 'analyst'
});

Deno.test("Phase 5A Contract: Rejects approved_budget_workbook request if status is draft", () => {
  const draftBudget = mockLockedBudget({ status: "draft" });

  assertThrows(
    () => {
      validateApprovedStatusRequirement(draftBudget);
    },
    Error,
    "requires status='locked'",
  );
});

Deno.test("Phase 5A Tie-Out: Valid locked budget payload passes all financial tie-outs", () => {
  const budget = mockLockedBudget();
  const lineItems = mockLineItems();

  const valid = validateExportPayloadTieOuts(budget, lineItems);
  assertEquals(valid, true);
});

Deno.test("Phase 5A Tie-Out: Rejects export payload when NOI fails tie-out", () => {
  const invalidBudget = mockLockedBudget({ noi: 999999 }); // Mismatched NOI!
  const lineItems = mockLineItems();

  assertThrows(
    () => {
      validateExportPayloadTieOuts(invalidBudget, lineItems);
    },
    Error,
    "tie-out error",
  );
});

Deno.test("Phase 5A Tie-Out: Rejects export payload when expense line sum fails tie-out", () => {
  const budget = mockLockedBudget();
  const badLineItems = mockLineItems().slice(1); // Drop utility expense line!

  assertThrows(
    () => {
      validateExportPayloadTieOuts(budget, badLineItems);
    },
    Error,
    "tie-out error",
  );
});

Deno.test("Phase 5A Naming: Approved budget resolves file name without DRAFT tag", () => {
  const budget = mockLockedBudget({ status: "locked" });
  const filename = resolveFilename(budget, "Highland Center");

  assertEquals(filename, "Highland_Center_FY2027_Approved_Budget.xlsx");
});

Deno.test("Phase 5A Naming: Unapproved/draft budget resolves file name WITH DRAFT tag", () => {
  const budget = mockLockedBudget({ status: "draft" });
  const filename = resolveFilename(budget, "Highland Center");

  assertEquals(filename, "Highland_Center_FY2027_DRAFT_Budget.xlsx");
});
