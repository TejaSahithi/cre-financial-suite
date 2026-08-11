import { recordWorkflowAction } from "@/services/approvalWorkflowEngine";
import {
  submitBudgetApprovalWorkflow,
  submitCamApprovalWorkflow,
  submitExpenseApprovalWorkflow,
  submitLeaseApprovalWorkflow,
} from "@/services/moduleApprovalAdapters";
import { supabase } from "@/services/supabaseClient";

const PENDING_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "FINANCE_REVIEW",
  "PENDING_APPROVAL",
  "PARTIALLY_APPROVED",
  "RESUBMITTED",
];

export function isApprovalSchemaMissing(error) {
  const message = String(error?.message || "");
  return error?.code === "42P01" || message.includes("approval_workflow") || message.includes("schema cache") || message.includes("does not exist");
}

function orgIdFor(entity = {}) {
  return entity.org_id || entity.organization_id || null;
}

function entityPayload(workflowType, entity) {
  if (workflowType === "expense") return { expense: entity };
  if (workflowType === "budget") return { budget: entity };
  if (workflowType === "lease") return { lease: entity };
  if (workflowType === "cam") return { camRun: entity };
  throw new Error(`Unsupported approval workflow type: ${workflowType}`);
}

function submitter(workflowType) {
  if (workflowType === "expense") return submitExpenseApprovalWorkflow;
  if (workflowType === "budget") return submitBudgetApprovalWorkflow;
  if (workflowType === "lease") return submitLeaseApprovalWorkflow;
  if (workflowType === "cam") return submitCamApprovalWorkflow;
  throw new Error(`Unsupported approval workflow type: ${workflowType}`);
}

async function findOpenWorkflow({ workflowType, entity }) {
  if (!supabase || !entity?.id || !orgIdFor(entity)) return null;
  const { data, error } = await supabase
    .from("approval_workflow_instances")
    .select("*")
    .eq("org_id", orgIdFor(entity))
    .eq("workflow_type", workflowType)
    .eq("entity_id", entity.id)
    .in("status", PENDING_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function attachWorkflowSteps(workflow) {
  if (!supabase || !workflow?.id) return workflow;
  const { data, error } = await supabase
    .from("approval_workflow_steps")
    .select("*")
    .eq("workflow_instance_id", workflow.id)
    .order("sequence_number", { ascending: true });
  if (error) throw error;
  return { ...workflow, steps: data || [] };
}

export async function submitOrReuseModuleApprovalWorkflow({ workflowType, entity, user = null, metadata = {} }) {
  if (!entity?.id) return { skipped: true, reason: "missing_entity" };
  try {
    const existing = await findOpenWorkflow({ workflowType, entity });
    if (existing) return { workflow: existing, reused: true };

    const fn = submitter(workflowType);
    const workflow = await fn({
      ...entityPayload(workflowType, entity),
      submittedBy: user?.id || null,
      metadata,
    });
    return { workflow, created: true };
  } catch (error) {
    if (isApprovalSchemaMissing(error)) {
      console.warn(`[ApprovalBridge] ${workflowType} approval workflow skipped until migration is applied:`, error?.message || error);
      return { skipped: true, reason: "schema_missing", error };
    }
    throw error;
  }
}

export async function recordModuleApprovalAction({ workflowType, entity, user = null, action, comments = "", rejectionReason = "", metadata = {} }) {
  if (!entity?.id) return { skipped: true, reason: "missing_entity" };
  try {
    const openWorkflow = await findOpenWorkflow({ workflowType, entity });
    if (!openWorkflow) return { skipped: true, reason: "no_open_workflow" };
    const workflow = await attachWorkflowSteps(openWorkflow);
    const result = await recordWorkflowAction({
      workflow,
      user,
      action,
      comments,
      rejectionReason,
      options: { metadata: { source: "module_bridge", ...metadata } },
    });
    return { action: result };
  } catch (error) {
    if (isApprovalSchemaMissing(error)) {
      console.warn(`[ApprovalBridge] ${workflowType} approval action skipped until migration is applied:`, error?.message || error);
      return { skipped: true, reason: "schema_missing", error };
    }
    throw error;
  }
}
