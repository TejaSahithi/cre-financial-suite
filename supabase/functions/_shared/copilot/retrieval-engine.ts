// @ts-nocheck
const INTENT_KEYS = {
  lease_expiration_search: ["expiration", "lease_expiration", "renewal"],
  cam_cap_search: ["cam_cap", "operating_expense_cap", "expense_cap"],
  rent_change_explanation: ["base_rent", "rent", "amendment_effect"],
  current_field_value: ["base_rent", "expiration_date", "commencement_date", "tenant", "landlord", "renewal"],
  amendment_explanation: ["amendment_effect", "renewal", "base_rent", "term"],
  executive_summary: ["lease_summary", "portfolio_summary", "base_rent", "expiration_date", "tenant", "portfolio_fact"],
  blocked_review_explanation: ["review_blocker", "missing_evidence", "needs_review"],
};

export function retrieveKnowledgeGraph(args) {
  const { intent, organizationId, targetOrganizationId, generationId, nodes = [], permissionDecision } = args;
  if (!permissionDecision?.allowed) return { nodes: [], blocked: true, reasonCodes: ["permission_denied"] };
  if (targetOrganizationId && targetOrganizationId !== organizationId) return { nodes: [], blocked: true, reasonCodes: ["cross_tenant_retrieval_denied"] };
  const relevantKeys = INTENT_KEYS[intent] || [];
  const selected = nodes.filter((node) => node.organizationId === organizationId)
    .filter((node) => node.status !== "stale")
    .filter((node) => !generationId || !node.generationId || node.generationId === generationId)
    .filter((node) => node.status === "approved" || node.status === "reviewed")
    .filter((node) => relevantKeys.length === 0 || relevantKeys.some((key) => node.key.includes(key) || node.nodeType.includes(key)));
  return { nodes: selected, blocked: false, reasonCodes: selected.length ? ["grounded_nodes_retrieved"] : ["no_grounded_nodes"] };
}

export function selectEvidence(nodes, limit = 5) {
  return nodes.flatMap((node) => (node.evidence || []).map((evidence) => ({ ...evidence, nodeId: node.id, fieldKey: node.key, confidence: node.confidence, reviewerStatus: node.status, documentFamilyId: node.documentFamilyId, amendmentSourceId: node.amendmentSourceId }))).slice(0, limit);
}