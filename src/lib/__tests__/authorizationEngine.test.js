import { describe, expect, it } from "vitest";
import {
  can,
  canApprove,
  getApprovalLimit,
  getRequiredApprovalChain,
  getNotificationRecipients,
  hasScope,
  validateRejectionAction,
} from "@/lib/authorizationEngine";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const PORTFOLIO_A = "portfolio-a";
const PORTFOLIO_B = "portfolio-b";
const PROPERTY_A = "property-a";
const PROPERTY_B = "property-b";

function user(id, role, membership = {}) {
  return {
    id,
    role,
    org_id: ORG,
    memberships: [
      {
        id: `${id}-membership`,
        user_id: id,
        org_id: ORG,
        role,
        status: "active",
        capabilities: {},
        ...membership,
      },
    ],
  };
}

const propertyAExpense = {
  org_id: ORG,
  approval_type: "expense",
  entity_type: "expense",
  property_id: PROPERTY_A,
  portfolio_id: PORTFOLIO_A,
  amount: 4000,
  created_by_user_id: "uploader",
};

describe("authorizationEngine", () => {
  it("grants Organization Owner organization-wide visibility and major approval authority", () => {
    const owner = user("owner", "org_owner");

    expect(can(owner, "expense.view", propertyAExpense)).toBe(true);
    expect(canApprove(owner, { ...propertyAExpense, amount: 750000 })).toBe(true);
  });

  it("maps legacy owner memberships to Organization Owner authority in the granular engine", () => {
    const owner = user("owner", "owner");

    expect(can(owner, "expense.view", propertyAExpense)).toBe(true);
    expect(canApprove(owner, { ...propertyAExpense, amount: 750000 })).toBe(true);
  });

  it("keeps Organization Admin operational but not a default final business approver", () => {
    const admin = user("admin", "org_admin");

    expect(can(admin, "user.assign", { org_id: ORG })).toBe(true);
    expect(can(admin, "expense.review", propertyAExpense)).toBe(true);
    expect(canApprove(admin, { ...propertyAExpense, amount: 1000 })).toBe(false);
  });

  it("allows delegated Organization Admin approval within delegated limits", () => {
    const admin = user("admin", "org_admin", {
      capabilities: {
        permissions: {
          expense: { approve: true },
        },
      },
    });

    const delegations = [
      {
        delegate_user_id: "admin",
        permission: "expense.approve",
        scope: "property",
        scope_id: PROPERTY_A,
        maximum_approval_amount: 50000,
        start_date: "2020-01-01T00:00:00Z",
        end_date: "2099-12-31T23:59:59Z",
        status: "active",
      },
    ];

    expect(getApprovalLimit(admin, "expense", propertyAExpense, { delegations })).toBe(50000);
    expect(canApprove(admin, { ...propertyAExpense, amount: 45000 }, { delegations })).toBe(true);
    expect(canApprove(admin, { ...propertyAExpense, amount: 55000 }, { delegations })).toBe(false);
  });

  it("matches DB-shaped delegations by starts_at/ends_at and does not leak across scope", () => {
    const admin = user("admin", "org_admin", {
      capabilities: {
        permissions: {
          expense: { approve: true },
        },
      },
    });

    const delegations = [
      {
        delegate_user_id: "admin",
        permission: "expense.approve",
        scope_type: "property",
        scope_id: PROPERTY_A,
        maximum_approval_amount: 50000,
        starts_at: "2020-01-01T00:00:00Z",
        ends_at: "2099-12-31T23:59:59Z",
        status: "active",
      },
    ];

    expect(canApprove(admin, { ...propertyAExpense, amount: 45000 }, { delegations })).toBe(true);
    expect(canApprove(admin, { ...propertyAExpense, property_id: PROPERTY_B, amount: 45000 }, { delegations })).toBe(false);
  });

  it("isolates Portfolio Managers to assigned portfolios", () => {
    const pm = user("pm", "portfolio_manager", {
      assigned_portfolios: [PORTFOLIO_A],
    });

    expect(hasScope(pm, propertyAExpense)).toBe(true);
    expect(can(pm, "budget.review", propertyAExpense)).toBe(true);
    expect(can(pm, "budget.review", { ...propertyAExpense, portfolio_id: PORTFOLIO_B, property_id: PROPERTY_B })).toBe(false);
  });

  it("isolates Property Managers to assigned properties", () => {
    const propertyManager = user("property-manager", "property_manager", {
      capabilities: {
        scope_access: {
          properties: [PROPERTY_A],
        },
      },
    });

    expect(can(propertyManager, "expense.create", propertyAExpense)).toBe(true);
    expect(can(propertyManager, "expense.create", { ...propertyAExpense, property_id: PROPERTY_B })).toBe(false);
  });

  it("isolates Property Owners to owned property assignments", () => {
    const owner = user("external-owner", "property_owner", {
      assigned_owners: [PROPERTY_A],
    });

    expect(can(owner, "revenue.view", propertyAExpense)).toBe(true);
    expect(can(owner, "revenue.view", { ...propertyAExpense, property_id: PROPERTY_B })).toBe(false);
  });

  it("keeps Auditor read-only", () => {
    const auditor = user("auditor", "auditor", {
      assigned_portfolios: [PORTFOLIO_A],
    });

    expect(can(auditor, "expense.view", propertyAExpense)).toBe(true);
    expect(can(auditor, "expense.edit", propertyAExpense)).toBe(false);
    expect(canApprove(auditor, propertyAExpense)).toBe(false);
  });

  it("allows Finance validation without default final business approval", () => {
    const finance = user("finance", "finance", {
      assigned_portfolios: [PORTFOLIO_A],
    });

    expect(can(finance, "expense.validate", propertyAExpense)).toBe(true);
    expect(can(finance, "expense.approve", propertyAExpense)).toBe(false);
    expect(canApprove(finance, propertyAExpense)).toBe(false);
  });

  it("prevents creators from approving their own work by default", () => {
    const propertyManager = user("creator", "property_manager", {
      assigned_portfolios: [PORTFOLIO_A],
    });

    expect(canApprove(propertyManager, { ...propertyAExpense, created_by_user_id: "creator" })).toBe(false);
    expect(canApprove(propertyManager, { ...propertyAExpense, created_by_user_id: "creator" }, { allowSelfApproval: true })).toBe(true);
  });

  it("supports custom roles through the same permission and scope engine", () => {
    const custom = user("custom", "custom_role", {
      custom_role: "regional_finance_manager",
      assigned_portfolios: [PORTFOLIO_A],
    });
    const roleDefinitions = [
      {
        role_key: "regional_finance_manager",
        permissions: {
          expense: { view: true, review: true },
          cam: { view: true, review: true },
        },
      },
    ];

    expect(can(custom, "expense.review", propertyAExpense, { roleDefinitions })).toBe(true);
    expect(can(custom, "expense.approve", propertyAExpense, { roleDefinitions })).toBe(false);
  });

  it("routes approval chains by amount and most-specific policy", () => {
    const propertyPolicy = {
      workflow_type: "expense",
      scope_type: "property",
      scope_id: PROPERTY_A,
      thresholds: [
        {
          min_amount: 0,
          max_amount: 50000,
          steps: [{ role: "org_owner", action: "approve" }],
        },
        {
          min_amount: 50000.01,
          max_amount: null,
          steps: [
            { role: "org_owner", action: "approve" },
            { role: "property_owner", action: "approve" },
          ],
        },
      ],
    };

    const small = getRequiredApprovalChain({
      approvalType: "expense",
      amount: 25000,
      resource: propertyAExpense,
      policies: [propertyPolicy],
    });
    const large = getRequiredApprovalChain({
      approvalType: "expense",
      amount: 75000,
      resource: propertyAExpense,
      policies: [propertyPolicy],
    });

    expect(small.steps).toEqual([{ role: "org_owner", action: "approve" }]);
    expect(large.steps.map((step) => step.role)).toEqual(["org_owner", "property_owner"]);
  });

  it("requires full rejection context", () => {
    expect(validateRejectionAction({ reason: "", comments: "Fix amount" }).valid).toBe(false);
    expect(
      validateRejectionAction({
        reason: "missing_invoice",
        comments: "Attach invoice support.",
        rejectedBy: "reviewer",
        workflowStage: "FINANCE_REVIEW",
        entityVersion: 2,
      }).valid
    ).toBe(true);
  });

  it("filters notification recipients by permission and scope", () => {
    const propertyManager = user("property-manager", "property_manager", {
      assigned_portfolios: [PORTFOLIO_A],
    });
    const wrongScope = user("wrong-scope", "property_manager", {
      assigned_portfolios: [PORTFOLIO_B],
    });

    const recipients = getNotificationRecipients(
      {
        module: "expense",
        action: "review",
        resource: propertyAExpense,
      },
      [propertyManager, wrongScope]
    );

    expect(recipients.map((recipient) => recipient.id)).toEqual(["property-manager"]);
  });

  it("denies cross-organization access", () => {
    const propertyManager = user("property-manager", "property_manager", {
      assigned_portfolios: [PORTFOLIO_A],
    });

    expect(can(propertyManager, "expense.view", { ...propertyAExpense, org_id: OTHER_ORG })).toBe(false);
  });
});
