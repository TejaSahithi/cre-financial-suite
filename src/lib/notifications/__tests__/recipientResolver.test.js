import { describe, expect, it } from "vitest";
import {
  canApproveWorkflow,
  resolveNotificationRecipients,
} from "@/lib/notifications/recipientResolver";
import { NOTIFICATION_EVENT_POLICIES } from "@/lib/notifications/notificationPolicies";

const orgId = "org-1";
const portfolioA = "portfolio-a";
const portfolioB = "portfolio-b";
const propertyA = "property-a";
const propertyB = "property-b";

function membership(overrides) {
  return {
    user_id: overrides.user_id,
    org_id: orgId,
    role: overrides.role || "viewer",
    status: overrides.status || "active",
    email: `${overrides.user_id}@example.com`,
    phone: `+1555000${String(overrides.user_id).replace(/\D/g, "").slice(-4).padStart(4, "0")}`,
    capabilities: overrides.capabilities || {},
    module_permissions: overrides.module_permissions || {},
    page_permissions: overrides.page_permissions || {},
    assigned_portfolios: overrides.assigned_portfolios || [],
  };
}

function portfolioGrant(userId, portfolioId) {
  return {
    user_id: userId,
    org_id: orgId,
    scope: "portfolio",
    scope_id: portfolioId,
    is_active: true,
  };
}

describe("role-based notification recipient resolver", () => {
  it("notifies only the property manager scoped to the event portfolio", () => {
    const result = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "expense.review_required",
        portfolio_id: portfolioA,
        property_id: propertyA,
      },
      {
        memberships: [
          membership({ user_id: "pm-a", role: "property_manager" }),
          membership({ user_id: "pm-b", role: "property_manager" }),
        ],
        userAccess: [portfolioGrant("pm-a", portfolioA), portfolioGrant("pm-b", portfolioB)],
      }
    );

    expect(result.recipients.map((recipient) => recipient.userId)).toContain("pm-a");
    expect(result.recipients.map((recipient) => recipient.userId)).not.toContain("pm-b");
  });

  it("sends lease review and approval notifications only to explicitly assigned eligible users", () => {
    const customLeaseReviewer = membership({
      user_id: "lease-reviewer",
      role: "viewer",
      capabilities: {
        custom_role: "Lease Reviewer",
        permissions: {
          lease: { view: true, review: true, approve: false },
        },
      },
    });

    const reviewResult = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "lease.review_required",
        portfolio_id: portfolioA,
        property_id: propertyA,
        assigned_user_ids: ["lease-reviewer"],
      },
      {
        memberships: [customLeaseReviewer],
        userAccess: [portfolioGrant("lease-reviewer", portfolioA)],
      }
    );

    const approvalResult = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "lease.ready_for_approval",
        portfolio_id: portfolioA,
        property_id: propertyA,
        assigned_user_ids: ["lease-reviewer"],
      },
      {
        memberships: [customLeaseReviewer],
        userAccess: [portfolioGrant("lease-reviewer", portfolioA)],
      }
    );

    expect(reviewResult.recipients.map((recipient) => recipient.userId)).toContain("lease-reviewer");
    expect(approvalResult.recipients.map((recipient) => recipient.userId)).not.toContain("lease-reviewer");
  });

  it("limits a custom budget reviewer to assigned portfolios", () => {
    const customBudgetReviewer = membership({
      user_id: "budget-reviewer",
      role: "viewer",
      capabilities: {
        custom_role: "Budget Reviewer",
        permissions: {
          budget: { view: true, review: true },
        },
      },
    });

    const portfolioAResult = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "budget.review_required",
        portfolio_id: portfolioA,
        property_id: propertyA,
      },
      {
        memberships: [customBudgetReviewer],
        userAccess: [portfolioGrant("budget-reviewer", portfolioA)],
      }
    );

    const portfolioBResult = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "budget.review_required",
        portfolio_id: portfolioB,
        property_id: propertyB,
      },
      {
        memberships: [customBudgetReviewer],
        userAccess: [portfolioGrant("budget-reviewer", portfolioA)],
      }
    );

    expect(portfolioAResult.recipients.map((recipient) => recipient.userId)).toContain("budget-reviewer");
    expect(portfolioBResult.recipients.map((recipient) => recipient.userId)).not.toContain("budget-reviewer");
  });

  it("deduplicates a finance user who also has a custom budget reviewer role", () => {
    const result = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "budget.review_required",
        portfolio_id: portfolioA,
        property_id: propertyA,
      },
      {
        memberships: [
          membership({
            user_id: "finance-budget-reviewer",
            role: "finance",
            capabilities: {
              custom_role: "Budget Reviewer",
              permissions: {
                budget: { view: true, review: true },
              },
            },
          }),
        ],
        userAccess: [portfolioGrant("finance-budget-reviewer", portfolioA)],
      }
    );

    const recipients = result.recipients.filter((recipient) => recipient.userId === "finance-budget-reviewer");
    expect(recipients).toHaveLength(1);
    expect(recipients[0].channels).toEqual(["email", "sms"]);
    expect(recipients[0].matchingReasons.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps email and sms mandatory even when preferences are disabled", () => {
    const result = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "budget.review_required",
        portfolio_id: portfolioA,
        property_id: propertyA,
      },
      {
        memberships: [membership({ user_id: "finance-user", role: "finance" })],
        notificationPreferences: [
          { user_id: "finance-user", email_enabled: false, sms_enabled: false },
        ],
      }
    );

    const recipient = result.recipients.find((item) => item.userId === "finance-user");
    expect(recipient.channels).toEqual(["email", "sms"]);
  });

  it("defines mandatory email and sms delivery channels for every notification policy event", () => {
    Object.keys(NOTIFICATION_EVENT_POLICIES).forEach((eventType) => {
      const result = resolveNotificationRecipients(
        {
          org_id: orgId,
          event_type: eventType,
          portfolio_id: portfolioA,
          property_id: propertyA,
          tenant_id: "tenant-a",
          published_to_tenant: true,
          audit_required: true,
        },
        {
          memberships: [
            membership({ user_id: "owner-user", role: "owner", status: "owner" }),
            membership({ user_id: "admin-user", role: "org_admin" }),
            membership({ user_id: "pm-user", role: "property_manager" }),
            membership({ user_id: "finance-user", role: "finance" }),
            membership({ user_id: "accounting-user", role: "accounting" }),
            membership({ user_id: "auditor-user", role: "auditor" }),
          ],
          userAccess: [portfolioGrant("pm-user", portfolioA)],
          stakeholders: [
            { id: "asset-owner-a", org_id: orgId, role: "asset_owner", property_id: propertyA, email: "asset@example.com", phone: "+15551234567" },
            { id: "tenant-a", tenant_id: "tenant-a", org_id: orgId, role: "tenant", property_id: propertyA, email: "tenant@example.com", phone: "+15557654321" },
          ],
        }
      );

      result.recipients.forEach((recipient) => {
        expect(recipient.channels, eventType).toEqual(["email", "sms"]);
      });
    });
  });

  it("requires org owner action for final expense approval", () => {
    const result = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "expense.final_approval_required",
        portfolio_id: portfolioA,
        property_id: propertyA,
      },
      {
        memberships: [
          membership({ user_id: "owner-user", role: "owner", status: "owner" }),
          membership({ user_id: "admin-user", role: "org_admin" }),
        ],
      }
    );

    const owner = result.recipients.find((recipient) => recipient.userId === "owner-user");
    const admin = result.recipients.find((recipient) => recipient.userId === "admin-user");

    expect(owner.notificationType).toBe("APPROVAL_REQUIRED");
    expect(owner.requiresAction).toBe(true);
    expect(owner.channels).toEqual(["email", "sms"]);
    expect(admin.notificationType).toBe("INFORMATIONAL");
  });

  it("does not let a custom expense approver bypass mandatory org owner final approval", () => {
    const context = {
      memberships: [
        membership({
          user_id: "regional-approver",
          role: "viewer",
          capabilities: {
            custom_role: "Regional Expense Approver",
            permissions: {
              expense: { view: true, review: true, approve: true },
            },
          },
        }),
      ],
      userAccess: [portfolioGrant("regional-approver", portfolioA)],
    };

    const result = canApproveWorkflow({
      userId: "regional-approver",
      orgId,
      eventType: "expense.final_approval_required",
      portfolioId: portfolioA,
      propertyId: propertyA,
      context,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("ORG_OWNER_FINAL_APPROVAL_REQUIRED");
  });

  it("scopes asset-owner notifications to the owned property", () => {
    const result = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "property.created",
        property_id: propertyA,
      },
      {
        stakeholders: [
          { id: "asset-owner-a", org_id: orgId, role: "asset_owner", property_id: propertyA, email: "a@example.com" },
          { id: "asset-owner-b", org_id: orgId, role: "asset_owner", property_id: propertyB, email: "b@example.com" },
        ],
      }
    );

    expect(result.recipients.map((recipient) => recipient.id)).toContain("asset-owner-a");
    expect(result.recipients.map((recipient) => recipient.id)).not.toContain("asset-owner-b");
  });

  it("notifies scoped internal and asset-owner recipients when a building is created", () => {
    const result = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "building.created",
        portfolio_id: portfolioA,
        property_id: propertyA,
        entity_id: "building-a",
      },
      {
        memberships: [
          membership({ user_id: "owner", role: "owner" }),
          membership({ user_id: "pm-a", role: "property_manager" }),
          membership({ user_id: "pm-b", role: "property_manager" }),
        ],
        userAccess: [portfolioGrant("pm-a", portfolioA), portfolioGrant("pm-b", portfolioB)],
        stakeholders: [
          { id: "asset-owner-a", org_id: orgId, role: "asset_owner", property_id: propertyA, email: "a@example.com" },
          { id: "asset-owner-b", org_id: orgId, role: "asset_owner", property_id: propertyB, email: "b@example.com" },
        ],
      }
    );

    expect(result.recipients.map((recipient) => recipient.userId)).toContain("owner");
    expect(result.recipients.map((recipient) => recipient.userId)).toContain("pm-a");
    expect(result.recipients.map((recipient) => recipient.userId)).not.toContain("pm-b");
    expect(result.recipients.map((recipient) => recipient.id)).toContain("asset-owner-a");
    expect(result.recipients.map((recipient) => recipient.id)).not.toContain("asset-owner-b");
  });

  it("keeps tenants out of internal CAM review and includes them after reconciliation publication", () => {
    const context = {
      stakeholders: [
        { id: "tenant-a", tenant_id: "tenant-a", org_id: orgId, role: "tenant", property_id: propertyA, email: "tenant@example.com" },
      ],
    };

    const internalReview = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "cam.review_required",
        property_id: propertyA,
        tenant_id: "tenant-a",
      },
      context
    );

    const publishedReconciliation = resolveNotificationRecipients(
      {
        org_id: orgId,
        event_type: "cam.reconciliation_ready",
        property_id: propertyA,
        tenant_id: "tenant-a",
        published_to_tenant: true,
      },
      context
    );

    expect(internalReview.recipients.map((recipient) => recipient.id)).not.toContain("tenant-a");
    expect(publishedReconciliation.recipients.map((recipient) => recipient.id)).toContain("tenant-a");
  });

  it("stops future custom role notifications after required permission is removed", () => {
    const beforeRemoval = membership({
      user_id: "custom-reviewer",
      role: "viewer",
      capabilities: {
        custom_role: "Expense Reviewer",
        permissions: { expense: { view: true, review: true } },
      },
    });
    const afterRemoval = membership({
      user_id: "custom-reviewer",
      role: "viewer",
      capabilities: {
        custom_role: "Expense Reviewer",
        permissions: { expense: { view: true, review: false } },
      },
    });

    const event = {
      org_id: orgId,
      event_type: "expense.review_required",
      portfolio_id: portfolioA,
      property_id: propertyA,
    };

    expect(resolveNotificationRecipients(event, {
      memberships: [beforeRemoval],
      userAccess: [portfolioGrant("custom-reviewer", portfolioA)],
    }).recipients.map((recipient) => recipient.userId)).toContain("custom-reviewer");

    expect(resolveNotificationRecipients(event, {
      memberships: [afterRemoval],
      userAccess: [portfolioGrant("custom-reviewer", portfolioA)],
    }).recipients.map((recipient) => recipient.userId)).not.toContain("custom-reviewer");
  });

  it("denies approval authority after the permission is removed", () => {
    const result = canApproveWorkflow({
      userId: "custom-approver",
      orgId,
      eventType: "lease.ready_for_approval",
      portfolioId: portfolioA,
      propertyId: propertyA,
      context: {
        memberships: [
          membership({
            user_id: "custom-approver",
            role: "viewer",
            capabilities: {
              custom_role: "Lease Approver",
              permissions: { lease: { view: true, approve: false } },
            },
          }),
        ],
        userAccess: [portfolioGrant("custom-approver", portfolioA)],
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("MISSING_PERMISSION");
  });
});
