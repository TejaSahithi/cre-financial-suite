import { describe, expect, it } from "vitest";
import {
  buildApprovalPolicyPayload,
  getPolicyResolutionTrace,
  resolveApprovalChainForTransaction,
} from "@/services/approvalPolicyService";
import {
  buildCustomRolePayload,
  mergeCustomRoleIntoMembershipCapabilities,
} from "@/services/customRoleService";
import {
  buildWorkflowSteps,
  getEffectiveWorkflowAction,
  recordWorkflowAction,
  resolveWorkflowActionTransition,
  validateWorkflowAction,
  WORKFLOW_STATUSES,
} from "@/services/approvalWorkflowEngine";
import {
  buildApprovalWorkflowInput,
} from "@/services/moduleApprovalAdapters";

const orgId = "org-1";
const propertyA = "property-a";
const portfolioA = "portfolio-a";

function user(id, role, membership = {}) {
  return {
    id,
    role,
    memberships: [
      {
        user_id: id,
        org_id: orgId,
        role,
        status: "active",
        assigned_portfolios: [portfolioA],
        capabilities: {},
        ...membership,
      },
    ],
  };
}

describe("enterprise workflow services", () => {
  it("builds durable custom-role payloads from inline User Management permissions", () => {
    const payload = buildCustomRolePayload({
      orgId,
      name: "Regional Finance Manager",
      permissions: {
        expense: { view: true, review: true },
        cam: { view: true, validate: true },
      },
      approvalLimits: { expense: 25000 },
      notificationPreferences: { expense_review: true },
    });

    expect(payload.role_key).toBe("regional_finance_manager");
    expect(payload.role_type).toBe("custom");
    expect(payload.default_capabilities.permissions.expense.review).toBe(true);
    expect(payload.approval_limits.expense).toBe(25000);
  });

  it("clones a standard role into a custom-role payload", () => {
    const payload = buildCustomRolePayload({
      orgId,
      name: "Assistant Property Manager",
      cloneFromRole: "property_manager",
      permissions: {
        expense: { approve: false },
      },
    });

    expect(payload.permission_set.expense.view).toBe(true);
    expect(payload.permission_set.expense.approve).toBe(false);
  });

  it("merges custom-role capabilities into a membership assignment", () => {
    const merged = mergeCustomRoleIntoMembershipCapabilities(
      { notification_preferences: { digest: true } },
      {
        role_key: "regional_finance_manager",
        label: "Regional Finance Manager",
        default_capabilities: {
          permissions: { expense: { review: true } },
          approval_limits: { expense: 25000 },
        },
      }
    );

    expect(merged.roles).toEqual(["custom"]);
    expect(merged.custom_role).toBe("regional_finance_manager");
    expect(merged.custom_role_label).toBe("Regional Finance Manager");
    expect(merged.custom_permissions.expense.review).toBe(true);
    expect(merged.approval_limits.expense).toBe(25000);
  });

  it("builds approval policies with normalized threshold chains", () => {
    const payload = buildApprovalPolicyPayload({
      orgId,
      workflowType: "expense",
      scopeType: "property",
      scopeId: propertyA,
      thresholds: [
        {
          minAmount: 0,
          maxAmount: 50000,
          steps: [{ role: "org_owner", action: "approve" }],
        },
      ],
    });

    expect(payload.scope_type).toBe("property");
    expect(payload.thresholds[0]).toEqual({
      min_amount: 0,
      max_amount: 50000,
      steps: [{ role: "org_owner", action: "approve" }],
    });
  });

  it("resolves property policy before portfolio, organization, and system defaults", () => {
    const policies = [
      {
        id: "org-policy",
        org_id: orgId,
        workflow_type: "expense",
        scope_type: "organization",
        thresholds: [{ min_amount: 0, steps: [{ role: "finance", action: "validate" }] }],
      },
      {
        id: "property-policy",
        org_id: orgId,
        workflow_type: "expense",
        scope_type: "property",
        scope_id: propertyA,
        thresholds: [{ min_amount: 0, steps: [{ role: "property_owner", action: "approve" }] }],
      },
    ];

    const resource = { org_id: orgId, portfolio_id: portfolioA, property_id: propertyA };
    const trace = getPolicyResolutionTrace({ policies, workflowType: "expense", resource });
    const chain = resolveApprovalChainForTransaction({ policies, workflowType: "expense", amount: 100, resource });

    expect(trace.order[0].id).toBe("property-policy");
    expect(chain.steps).toEqual([{ role: "property_owner", action: "approve" }]);
  });

  it("builds reusable workflow steps from approval policies", () => {
    const { steps } = buildWorkflowSteps({
      approvalType: "expense",
      amount: 100,
      resource: { org_id: orgId, property_id: propertyA },
      policies: [
        {
          workflow_type: "expense",
          scope_type: "property",
          scope_id: propertyA,
          thresholds: [
            {
              min_amount: 0,
              steps: [
                { role: "finance", action: "validate" },
                { role: "org_owner", action: "approve" },
              ],
            },
          ],
        },
      ],
    });

    expect(steps).toHaveLength(2);
    expect(steps[0].status).toBe("ACTIVE");
    expect(steps[1].status).toBe("PENDING");
  });

  it("advances a multi-step approval to the next active step", () => {
    const transition = resolveWorkflowActionTransition({
      action: "approve",
      workflow: {
        status: WORKFLOW_STATUSES.SUBMITTED,
        current_step_id: "step-1",
        steps: [
          { id: "step-1", sequence_number: 1, stage_key: "finance_validate", status: "ACTIVE" },
          { id: "step-2", sequence_number: 2, stage_key: "owner_approve", status: "PENDING" },
        ],
      },
    });

    expect(transition.currentStep.id).toBe("step-1");
    expect(transition.nextStep.id).toBe("step-2");
    expect(transition.workflowUpdate).toMatchObject({
      status: WORKFLOW_STATUSES.PARTIALLY_APPROVED,
      current_stage: "owner_approve",
      current_step_id: "step-2",
    });
  });

  it("closes a workflow when the final approval step is completed", () => {
    const transition = resolveWorkflowActionTransition({
      action: "approve",
      workflow: {
        status: WORKFLOW_STATUSES.PARTIALLY_APPROVED,
        current_step_id: "step-2",
        steps: [
          { id: "step-1", sequence_number: 1, stage_key: "finance_validate", status: "APPROVED" },
          { id: "step-2", sequence_number: 2, stage_key: "owner_approve", status: "ACTIVE" },
        ],
      },
    });

    expect(transition.nextStep).toBeNull();
    expect(transition.workflowUpdate).toMatchObject({
      status: WORKFLOW_STATUSES.APPROVED,
      current_stage: "approved",
      current_step_id: null,
    });
  });

  it("rejects silent rejections and returns-for-changes", () => {
    const result = validateWorkflowAction({
      user: { id: "reviewer" },
      workflow: { status: "FINANCE_REVIEW" },
      action: "reject",
      comments: "",
      rejectionReason: "",
      entityVersion: 3,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("rejection reason");
  });

  it("uses the active workflow step action when a module-level approve button advances review or validation", () => {
    const workflow = {
      status: WORKFLOW_STATUSES.SUBMITTED,
      current_step_id: "step-1",
      steps: [
        {
          id: "step-1",
          sequence_number: 1,
          action_required: "validate",
          approver_role: "finance",
          status: "ACTIVE",
        },
      ],
    };

    expect(getEffectiveWorkflowAction({ workflow, action: "approve" })).toBe("validate");
  });

  it("enforces active-step role and granular review/validate/sign permissions", () => {
    const workflow = {
      id: "workflow-1",
      org_id: orgId,
      workflow_type: "expense",
      entity_type: "expense",
      entity_id: "expense-1",
      portfolio_id: portfolioA,
      property_id: propertyA,
      amount: 1000,
      status: WORKFLOW_STATUSES.SUBMITTED,
      current_step_id: "finance-step",
      steps: [
        {
          id: "finance-step",
          sequence_number: 1,
          action_required: "validate",
          approver_role: "finance",
          status: "ACTIVE",
        },
      ],
    };

    expect(validateWorkflowAction({ user: user("finance", "finance"), workflow, action: "approve" }).allowed).toBe(true);
    expect(validateWorkflowAction({ user: user("pm", "property_manager"), workflow, action: "approve" }).allowed).toBe(false);
  });

  it("keeps finance from acting as final business approver on an approval step", () => {
    const workflow = {
      id: "workflow-1",
      org_id: orgId,
      workflow_type: "expense",
      entity_type: "expense",
      entity_id: "expense-1",
      portfolio_id: portfolioA,
      property_id: propertyA,
      amount: 75000,
      status: WORKFLOW_STATUSES.PARTIALLY_APPROVED,
      current_step_id: "owner-step",
      created_by_user_id: "submitter",
      steps: [
        {
          id: "owner-step",
          sequence_number: 3,
          action_required: "approve",
          approver_role: "org_owner",
          status: "ACTIVE",
        },
      ],
    };

    expect(validateWorkflowAction({ user: user("finance", "finance"), workflow, action: "approve" }).allowed).toBe(false);
    expect(validateWorkflowAction({ user: user("owner", "org_owner"), workflow, action: "approve" }).allowed).toBe(true);
  });

  it("records delegated authority metadata on workflow actions", async () => {
    const action = await recordWorkflowAction({
      workflow: {
        id: "workflow-1",
        org_id: orgId,
        workflow_type: "expense",
        entity_type: "expense",
        entity_id: "expense-1",
        portfolio_id: portfolioA,
        property_id: propertyA,
        amount: 1000,
        status: WORKFLOW_STATUSES.SUBMITTED,
        current_step_id: "step-1",
        steps: [
          {
            id: "step-1",
            sequence_number: 1,
            action_required: "approve",
            approver_role: "org_admin",
            status: "ACTIVE",
          },
        ],
      },
      user: user("admin", "org_admin", {
        capabilities: { permissions: { expense: { approve: true } } },
      }),
      action: "approve",
      options: {
        delegations: [
          {
            id: "delegation-1",
            delegator_user_id: "owner",
            delegate_user_id: "admin",
            permission: "expense.approve",
            scope_type: "property",
            scope_id: propertyA,
            maximum_approval_amount: 5000,
            starts_at: "2020-01-01T00:00:00Z",
            ends_at: "2099-12-31T23:59:59Z",
            status: "active",
          },
        ],
        delegation: {
          id: "delegation-1",
          delegator_user_id: "owner",
        },
      },
    });

    expect(action.delegated_from_user_id).toBe("owner");
    expect(action.delegated_authority_id).toBe("delegation-1");
    expect(action.metadata.delegated_authority.id).toBe("delegation-1");
  });

  it("maps module entities into generic workflow input contracts", () => {
    const expenseInput = buildApprovalWorkflowInput({
      workflowType: "expense",
      entityType: "expense",
      entity: {
        id: "expense-1",
        org_id: orgId,
        portfolio_id: portfolioA,
        property_id: propertyA,
        amount: 123,
      },
      amount: 123,
      submittedBy: "user-1",
    });

    expect(expenseInput).toMatchObject({
      orgId,
      workflowType: "expense",
      entityType: "expense",
      entityId: "expense-1",
      amount: 123,
      submittedBy: "user-1",
      resource: {
        org_id: orgId,
        portfolio_id: portfolioA,
        property_id: propertyA,
      },
    });
  });
});
