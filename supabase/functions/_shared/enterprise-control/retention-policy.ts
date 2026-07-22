// @ts-nocheck
export const RETENTION_CLASSES = ["source_document", "azure_provider_output", "openai_request", "openai_response", "canonical_layout", "claims", "evidence", "semantic_records", "portfolio_facts", "integration_events", "workflow_records", "audit_events", "exports", "diagnostic_logs", "benchmark_artifacts"];
export function evaluateRetention(policy, artifact, now = new Date()) {
  if (!policy) return { deletable: false, reasonCodes: ["retention_policy_missing"] };
  if (policy.legalHold || artifact.legalHold) return { deletable: false, reasonCodes: ["legal_hold_active"] };
  const minimumDays = Math.max(policy.retentionDays, policy.minimumComplianceDays || 0);
  const ageDays = Math.floor((now.getTime() - Date.parse(artifact.createdAt)) / 86400000);
  return ageDays >= minimumDays ? { deletable: true, reasonCodes: ["retention_elapsed"] } : { deletable: false, reasonCodes: ["retention_not_elapsed"] };
}