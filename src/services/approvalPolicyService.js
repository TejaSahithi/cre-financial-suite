import {
  DEFAULT_APPROVAL_THRESHOLDS,
  getRequiredApprovalChain,
  resolveApprovalPolicy,
} from "@/lib/authorizationEngine";
import { logAudit } from "@/services/audit";
import { supabase } from "@/services/supabaseClient";

const SCOPE_SPECIFICITY = {
  property: 3,
  portfolio: 2,
  organization: 1,
  system: 0,
};

function normalizeThreshold(threshold = {}) {
  const minAmount = Number(threshold.min_amount ?? threshold.minAmount ?? 0);
  const maxRaw = threshold.max_amount ?? threshold.maxAmount ?? null;
  return {
    min_amount: Number.isFinite(minAmount) ? minAmount : 0,
    max_amount: maxRaw == null ? null : Number(maxRaw),
    steps: Array.isArray(threshold.steps)
      ? threshold.steps
      : Array.isArray(threshold.approval_chain)
        ? threshold.approval_chain
        : [],
  };
}

export function buildApprovalPolicyPayload({
  orgId = null,
  workflowType,
  entityType = workflowType,
  scopeType = orgId ? "organization" : "system",
  scopeId = null,
  name,
  description = "",
  thresholds = DEFAULT_APPROVAL_THRESHOLDS[workflowType] || [],
  requirePropertyOwnerApproval = false,
  allowSelfApproval = false,
}) {
  if (!workflowType) throw new Error("workflowType is required");
  if (scopeType !== "system" && !orgId) throw new Error("orgId is required for non-system approval policies");
  if (["portfolio", "property"].includes(scopeType) && !scopeId) {
    throw new Error("scopeId is required for portfolio and property approval policies");
  }

  return {
    org_id: orgId,
    workflow_type: workflowType,
    entity_type: entityType,
    scope_type: scopeType,
    scope_id: scopeId,
    name: name || `${scopeType} ${workflowType} approval policy`,
    description,
    thresholds: thresholds.map(normalizeThreshold),
    require_property_owner_approval: Boolean(requirePropertyOwnerApproval),
    allow_self_approval: Boolean(allowSelfApproval),
    is_active: true,
  };
}

export function rankPoliciesForResource(policies = [], resource = {}) {
  return [...policies]
    .map((policy) => {
      let matches = false;
      if (policy.scope_type === "property") matches = policy.scope_id === resource.property_id;
      else if (policy.scope_type === "portfolio") matches = policy.scope_id === resource.portfolio_id;
      else if (policy.scope_type === "organization") matches = policy.org_id === (resource.org_id || resource.organization_id);
      else if (policy.scope_type === "system") matches = true;

      return {
        policy,
        matches,
        rank: matches ? SCOPE_SPECIFICITY[policy.scope_type] ?? -1 : -1,
      };
    })
    .filter((row) => row.matches)
    .sort((a, b) => b.rank - a.rank)
    .map((row) => row.policy);
}

export function resolveApprovalChainForTransaction({ policies = [], workflowType, amount = 0, resource = {} }) {
  const normalizedPolicies = policies.map((policy) => ({
    ...policy,
    thresholds: (policy.thresholds || []).map(normalizeThreshold),
  }));
  const ranked = rankPoliciesForResource(normalizedPolicies, resource);
  return getRequiredApprovalChain({
    approvalType: workflowType,
    amount,
    resource,
    policies: ranked,
  });
}

export function getPolicyResolutionTrace({ policies = [], workflowType, resource = {} }) {
  const ranked = rankPoliciesForResource(
    policies.filter((policy) => !policy.workflow_type || policy.workflow_type === workflowType),
    resource
  );
  const selected = resolveApprovalPolicy({ approvalType: workflowType, resource, policies: ranked });
  return {
    order: ranked.map((policy) => ({
      id: policy.id,
      name: policy.name,
      scope_type: policy.scope_type,
      scope_id: policy.scope_id,
    })),
    selected,
  };
}

export async function listApprovalPolicies(orgId, workflowType = null) {
  if (!supabase) return [];
  let query = supabase
    .from("approval_policies")
    .select("*")
    .or(`org_id.eq.${orgId},scope_type.eq.system`)
    .eq("is_active", true);
  if (workflowType) query = query.eq("workflow_type", workflowType);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function upsertApprovalPolicy(input) {
  if (!supabase) return buildApprovalPolicyPayload(input);
  const payload = buildApprovalPolicyPayload(input);

  let existingQuery = supabase
    .from("approval_policies")
    .select("id")
    .eq("workflow_type", payload.workflow_type)
    .eq("scope_type", payload.scope_type)
    .eq("is_active", true)
    .limit(1);

  existingQuery = payload.org_id ? existingQuery.eq("org_id", payload.org_id) : existingQuery.is("org_id", null);
  existingQuery = payload.scope_id ? existingQuery.eq("scope_id", payload.scope_id) : existingQuery.is("scope_id", null);

  const { data: existingPolicy, error: existingError } = await existingQuery.maybeSingle();
  if (existingError) throw existingError;

  const writeQuery = existingPolicy?.id
    ? supabase
        .from("approval_policies")
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq("id", existingPolicy.id)
    : supabase
        .from("approval_policies")
        .insert(payload);

  const { data, error } = await writeQuery.select().single();
  if (error) throw error;

  await logAudit({
    action: "approval_policy_upserted",
    entityType: "ApprovalPolicy",
    entityId: data?.id,
    orgId: payload.org_id,
    details: {
      workflow_type: payload.workflow_type,
      scope_type: payload.scope_type,
      scope_id: payload.scope_id,
      thresholds: payload.thresholds,
    },
  });

  return data;
}

export async function disableApprovalPolicy({ orgId, policyId }) {
  if (!supabase) return { id: policyId, org_id: orgId, is_active: false };
  const { data, error } = await supabase
    .from("approval_policies")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", policyId)
    .eq("org_id", orgId)
    .select()
    .single();
  if (error) throw error;

  await logAudit({
    action: "approval_policy_disabled",
    entityType: "ApprovalPolicy",
    entityId: policyId,
    orgId,
  });

  return data;
}
