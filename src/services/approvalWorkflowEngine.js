import { can, canApprove, normalizeRole, validateRejectionAction } from "@/lib/authorizationEngine";
import { getPolicyResolutionTrace, resolveApprovalChainForTransaction } from "@/services/approvalPolicyService";
import { logAudit } from "@/services/audit";
import { createNotificationsForEvent } from "@/services/notificationService";
import { supabase } from "@/services/supabaseClient";

export const WORKFLOW_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  FINANCE_REVIEW: "FINANCE_REVIEW",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  PARTIALLY_APPROVED: "PARTIALLY_APPROVED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  RETURNED_FOR_CHANGES: "RETURNED_FOR_CHANGES",
  RESUBMITTED: "RESUBMITTED",
  SIGNED: "SIGNED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});

const ACTION_TO_STATUS = Object.freeze({
  submit: WORKFLOW_STATUSES.SUBMITTED,
  review: WORKFLOW_STATUSES.UNDER_REVIEW,
  validate: WORKFLOW_STATUSES.FINANCE_REVIEW,
  approve: WORKFLOW_STATUSES.PARTIALLY_APPROVED,
  reject: WORKFLOW_STATUSES.REJECTED,
  return_for_changes: WORKFLOW_STATUSES.RETURNED_FOR_CHANGES,
  resubmit: WORKFLOW_STATUSES.RESUBMITTED,
  sign: WORKFLOW_STATUSES.SIGNED,
  cancel: WORKFLOW_STATUSES.CANCELLED,
});

const ADVANCING_ACTIONS = new Set(["review", "validate", "approve", "sign"]);

const ACTION_PERMISSION = Object.freeze({
  submit: "submit",
  review: "review",
  validate: "validate",
  approve: "approve",
  reject: "reject",
  return_for_changes: "reject",
  resubmit: "submit",
  sign: "sign",
  cancel: "configure",
});

function getOrderedSteps(workflow = {}) {
  return [...(workflow.steps || [])].sort((a, b) => (a.sequence_number || 0) - (b.sequence_number || 0));
}

function getCurrentStep(workflow = {}) {
  const steps = getOrderedSteps(workflow);
  return (
    workflow.current_step ||
    steps.find((step) => workflow.current_step_id && step.id === workflow.current_step_id) ||
    steps.find((step) => step.status === "ACTIVE") ||
    steps.find((step) => step.stage_key === workflow.current_stage) ||
    steps[0] ||
    null
  );
}

function getNextPendingStep(workflow = {}, currentStep = null) {
  const steps = getOrderedSteps(workflow);
  if (steps.length === 0) return null;
  const currentSequence = currentStep?.sequence_number || 0;
  return steps.find((step) => step.status === "PENDING" && (step.sequence_number || 0) > currentSequence) || null;
}

export function getEffectiveWorkflowAction({ workflow = {}, action }) {
  const currentStep = getCurrentStep(workflow);
  const requiredAction = currentStep?.action_required;
  if (action === "approve" && ["review", "validate", "sign"].includes(requiredAction)) {
    return requiredAction;
  }
  return action;
}

function userRole(user = {}, options = {}) {
  return options.membership?.role || user?.memberships?.[0]?.role || user?.role || null;
}

function currentStepAllowsUser(currentStep, user, options = {}) {
  if (!currentStep) return true;
  if (currentStep.approver_user_id && currentStep.approver_user_id !== user?.id) return false;

  const requiredRole = currentStep.required_role || currentStep.approver_role;
  if (!requiredRole || requiredRole === "authorized_signatory") return true;
  return normalizeRole(requiredRole) === normalizeRole(userRole(user, options));
}

function permissionActionForWorkflowAction(action, currentStep = null) {
  if (["reject", "return_for_changes"].includes(action) && currentStep?.action_required) {
    return currentStep.action_required;
  }
  return ACTION_PERMISSION[action] || action;
}

export function resolveWorkflowActionTransition({ workflow = {}, action }) {
  const currentStep = getCurrentStep(workflow);
  const nextPendingStep = getNextPendingStep(workflow, currentStep);
  const now = new Date().toISOString();
  const nextStatus = ACTION_TO_STATUS[action] || workflow.status;

  if (ADVANCING_ACTIONS.has(action)) {
    if (nextPendingStep) {
      return {
        currentStep,
        nextStep: nextPendingStep,
        stepStatus: action === "sign" ? "APPROVED" : "APPROVED",
        nextStepStatus: "ACTIVE",
        workflowUpdate: {
          status: WORKFLOW_STATUSES.PARTIALLY_APPROVED,
          current_stage: nextPendingStep.stage_key,
          current_step_id: nextPendingStep.id || null,
          updated_at: now,
        },
      };
    }

    return {
      currentStep,
      nextStep: null,
      stepStatus: "APPROVED",
      nextStepStatus: null,
      workflowUpdate: {
        status: action === "sign" ? WORKFLOW_STATUSES.SIGNED : WORKFLOW_STATUSES.APPROVED,
        current_stage: action === "sign" ? "signed" : "approved",
        current_step_id: null,
        approved_at: action === "sign" ? workflow.approved_at || now : now,
        completed_at: now,
        updated_at: now,
      },
    };
  }

  if (action === "reject" || action === "return_for_changes") {
    return {
      currentStep,
      nextStep: null,
      stepStatus: action === "reject" ? "REJECTED" : "RETURNED_FOR_CHANGES",
      nextStepStatus: null,
      workflowUpdate: {
        status: nextStatus,
        current_stage: action === "reject" ? "rejected" : "returned_for_changes",
        rejected_at: action === "reject" ? now : null,
        updated_at: now,
      },
    };
  }

  return {
    currentStep,
    nextStep: null,
    stepStatus: null,
    nextStepStatus: null,
    workflowUpdate: {
      status: nextStatus,
      updated_at: now,
    },
  };
}

function approvalStageEventTypesFor(workflowType, transition = {}) {
  if (!transition.nextStep) return [`${workflowType}.approved`];

  if (workflowType === "lease") {
    const nextRole = normalizeRole(transition.nextStep.approver_role || transition.nextStep.required_role);
    if (nextRole === "org_owner") return ["lease.org_owner_approval_required"];
    if (nextRole === "asset_owner" || nextRole === "property_owner") return ["lease.pm_approved", "lease.asset_owner_approval_required"];
    return ["lease.ready_for_approval"];
  }

  if (["expense", "cam", "budget"].includes(workflowType)) {
    return [`${workflowType}.final_approval_required`];
  }

  return [`${workflowType}.approved`];
}

function eventTypesFor(workflowType, action, transition = {}) {
  if (action === "approve") return approvalStageEventTypesFor(workflowType, transition);
  if (action === "reject") return [`${workflowType}.rejected`];
  if (action === "return_for_changes") return [`${workflowType}.correction_required`];
  if (action === "submit" || action === "resubmit") return [`${workflowType}.review_required`];
  return [`${workflowType}.${action}`];
}

export function buildWorkflowSteps({ approvalType, amount = 0, resource = {}, policies = [] }) {
  const { policy, steps } = resolveApprovalChainForTransaction({
    policies,
    workflowType: approvalType,
    amount,
    resource,
  });

  return {
    policy,
    steps: steps.map((step, index) => ({
      sequence_number: index + 1,
      stage_key: step.stage_key || `${step.role || step.approver_role || "approver"}_${step.action || "approve"}`,
      action_required: step.action || step.action_required || "approve",
      approver_role: step.role || step.approver_role || null,
      approver_user_id: step.user_id || step.approver_user_id || null,
      status: index === 0 ? "ACTIVE" : "PENDING",
      metadata: step.metadata || {},
    })),
  };
}

export function validateWorkflowAction({ user, workflow = {}, action, comments = "", rejectionReason = "", entityVersion, options = {} }) {
  const effectiveAction = getEffectiveWorkflowAction({ workflow, action });
  const currentStep = getCurrentStep(workflow);

  if (!currentStepAllowsUser(currentStep, user, options)) {
    return {
      allowed: false,
      reason: "User is not assigned to the current workflow step",
    };
  }

  if (["reject", "return_for_changes"].includes(action)) {
    const rejection = validateRejectionAction({
      reason: rejectionReason,
      comments,
      rejectedBy: user?.id,
      workflowStage: workflow.current_stage || workflow.status,
      entityVersion,
    });
    if (!rejection.valid) {
      return {
        allowed: false,
        reason: `Missing ${rejection.missing.join(", ")}`,
      };
    }
  }

  if (effectiveAction === "approve") {
    const allowed = canApprove(user, { ...workflow, current_step: currentStep }, options);
    return {
      allowed,
      reason: allowed ? null : "User lacks approval authority for this request",
    };
  }

  const permissionAction = permissionActionForWorkflowAction(effectiveAction, currentStep);
  if (workflow.workflow_type && permissionAction) {
    const allowed = can(user, `${workflow.workflow_type}.${permissionAction}`, workflow, options);
    return {
      allowed,
      reason: allowed ? null : `User lacks ${workflow.workflow_type}.${permissionAction} permission for this request`,
    };
  }

  return { allowed: true, reason: null };
}

export async function createWorkflowInstance({
  orgId,
  workflowType,
  entityType,
  entityId,
  amount = null,
  resource = {},
  policies = [],
  submittedBy = null,
  metadata = {},
}) {
  const { policy, steps } = buildWorkflowSteps({
    approvalType: workflowType,
    amount: amount ?? 0,
    resource: { ...resource, org_id: orgId },
    policies,
  });

  const instancePayload = {
    org_id: orgId,
    policy_id: policy?.id || null,
    workflow_type: workflowType,
    entity_type: entityType,
    entity_id: entityId,
    portfolio_id: resource.portfolio_id || null,
    property_id: resource.property_id || null,
    building_id: resource.building_id || null,
    unit_id: resource.unit_id || null,
    lease_id: resource.lease_id || (entityType === "lease" ? entityId : null),
    amount,
    status: WORKFLOW_STATUSES.SUBMITTED,
    current_stage: steps[0]?.stage_key || "submitted",
    submitted_by: submittedBy,
    submitted_at: new Date().toISOString(),
    metadata: {
      ...metadata,
      policy_resolution: getPolicyResolutionTrace({ policies, workflowType, resource: { ...resource, org_id: orgId } }),
    },
  };

  if (!supabase) {
    return {
      ...instancePayload,
      id: `${workflowType}-${entityId}`,
      steps,
    };
  }

  const { data: instance, error } = await supabase
    .from("approval_workflow_instances")
    .insert(instancePayload)
    .select()
    .single();
  if (error) throw error;

  let persistedSteps = steps;
  if (steps.length > 0) {
    const { data: insertedSteps, error: stepError } = await supabase
      .from("approval_workflow_steps")
      .insert(steps.map((step) => ({ ...step, workflow_instance_id: instance.id })))
      .select();
    if (stepError) throw stepError;
    persistedSteps = insertedSteps || steps;

    const firstStep = [...persistedSteps].sort((a, b) => (a.sequence_number || 0) - (b.sequence_number || 0))[0];
    if (firstStep?.id) {
      const { error: currentStepError } = await supabase
        .from("approval_workflow_instances")
        .update({ current_step_id: firstStep.id })
        .eq("id", instance.id);
      if (currentStepError) throw currentStepError;
      instance.current_step_id = firstStep.id;
    }
  }

  await logAudit({
    action: `${workflowType}_submitted`,
    entityType,
    entityId,
    orgId,
    details: {
      amount,
      current_stage: instancePayload.current_stage,
      approval_steps: steps,
    },
  });

  await createNotificationsForEvent({
    org_id: orgId,
    event_type: `${workflowType}.review_required`,
    entity_type: entityType,
    entity_id: entityId,
    portfolio_id: resource.portfolio_id || null,
    property_id: resource.property_id || null,
    metadata: { workflow_instance_id: instance.id },
  });

  return {
    ...instance,
    steps: persistedSteps,
  };
}

export async function recordWorkflowAction({
  workflow,
  user,
  action,
  comments = "",
  rejectionReason = "",
  entityVersion = null,
  options = {},
}) {
  const effectiveAction = getEffectiveWorkflowAction({ workflow, action });
  const validation = validateWorkflowAction({
    user,
    workflow,
    action: effectiveAction,
    comments,
    rejectionReason,
    entityVersion,
    options,
  });
  if (!validation.allowed) {
    const error = new Error(validation.reason);
    error.code = "WORKFLOW_ACTION_NOT_ALLOWED";
    throw error;
  }

  const transition = resolveWorkflowActionTransition({ workflow, action: effectiveAction });
  const currentStep = transition.currentStep;
  const nextStatus = transition.workflowUpdate.status || ACTION_TO_STATUS[effectiveAction] || workflow.status;
  const actionPayload = {
    workflow_instance_id: workflow.id,
    workflow_step_id: currentStep?.id || workflow.current_step_id || null,
    org_id: workflow.org_id,
    actor_user_id: user?.id || null,
    actor_role: user?.role || null,
    action: effectiveAction,
    comments,
    rejection_reason: rejectionReason || null,
    entity_version: entityVersion,
    previous_status: workflow.status,
    new_status: nextStatus,
    delegated_from_user_id: options.delegation?.delegator_user_id || options.delegatedFromUserId || null,
    delegated_authority_id: options.delegation?.id || options.delegatedAuthorityId || null,
    metadata: {
      ...(options.metadata || {}),
      requested_action: action,
      delegated_authority: options.delegation || null,
    },
  };

  if (!supabase) {
    return {
      ...actionPayload,
      id: `${workflow.id}-${action}`,
    };
  }

  const { data, error } = await supabase
    .from("approval_actions")
    .insert(actionPayload)
    .select()
    .single();
  if (error) throw error;

  if (currentStep?.id && transition.stepStatus) {
    const { error: stepUpdateError } = await supabase
      .from("approval_workflow_steps")
      .update({
        status: transition.stepStatus,
        completed_at: new Date().toISOString(),
        comments,
        updated_at: new Date().toISOString(),
      })
      .eq("id", currentStep.id);
    if (stepUpdateError) throw stepUpdateError;
  }

  if (transition.nextStep?.id && transition.nextStepStatus) {
    const { error: nextStepError } = await supabase
      .from("approval_workflow_steps")
      .update({
        status: transition.nextStepStatus,
        assigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", transition.nextStep.id);
    if (nextStepError) throw nextStepError;
  }

  const { error: updateError } = await supabase
    .from("approval_workflow_instances")
    .update(transition.workflowUpdate)
    .eq("id", workflow.id);
  if (updateError) throw updateError;

  await logAudit({
    action: `${workflow.workflow_type}_${effectiveAction}`,
    entityType: workflow.entity_type,
    entityId: workflow.entity_id,
    orgId: workflow.org_id,
    details: actionPayload,
  });

  for (const eventType of eventTypesFor(workflow.workflow_type, effectiveAction, transition)) {
    await createNotificationsForEvent({
      org_id: workflow.org_id,
      event_type: eventType,
      entity_type: workflow.entity_type,
      entity_id: workflow.entity_id,
      portfolio_id: workflow.portfolio_id || null,
      property_id: workflow.property_id || null,
      metadata: { workflow_instance_id: workflow.id, action_id: data.id },
    });
  }

  return data;
}
