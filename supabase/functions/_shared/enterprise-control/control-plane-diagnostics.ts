// @ts-nocheck
export const RELEASE10_RLS_TABLES = ["organization_security_policies", "organization_data_residency_policies", "organization_retention_policies", "organization_feature_entitlements", "organization_usage_quotas", "organization_usage_counters", "organization_support_tiers", "organization_rollout_states", "enterprise_audit_events", "compliance_evidence_records", "backup_verification_runs", "disaster_recovery_exercises", "service_level_measurements", "error_budget_snapshots", "legacy_path_usage", "legacy_retirement_exceptions", "production_change_records"];
export const RELEASE10_FEATURE_FLAGS = ["ENABLE_ENTERPRISE_RBAC_V10", "ENABLE_DELEGATED_ADMIN", "ENABLE_SUPPORT_ACCESS_CONTROL", "ENABLE_COMPLIANCE_EVIDENCE", "ENABLE_RETENTION_ENFORCEMENT", "ENABLE_RESIDENCY_ENFORCEMENT", "ENABLE_ORGANIZATION_QUOTAS", "ENABLE_ERROR_BUDGET_GATES", "ENABLE_ASYNC_EXPORTS", "ENABLE_LEGACY_RETIREMENT_CONTROLS", "ENABLE_BROAD_GA"];
export const RELEASE10_APPEND_ONLY_TABLES = ["enterprise_audit_events", "compliance_evidence_records", "backup_verification_runs", "disaster_recovery_exercises", "service_level_measurements", "error_budget_snapshots", "legacy_path_usage"];
export function summarizeControlPlaneDiagnostics(input) {
  const failures = [];
  if (!input.rlsVerified) failures.push("rls_not_verified");
  if (!input.auditAppendOnly) failures.push("audit_not_append_only");
  if (!input.backupHealthy) failures.push("backup_not_healthy");
  if (!input.errorBudgetsHealthy) failures.push("error_budget_not_healthy");
  return { status: failures.length ? "not_ready" : "ready", reasonCodes: failures.length ? failures : ["control_plane_ready"] };
}