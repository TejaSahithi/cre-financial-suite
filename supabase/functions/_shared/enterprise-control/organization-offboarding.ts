// @ts-nocheck
export const OFFBOARDING_STEPS = ["disable_ingestion", "disable_integrations", "revoke_credentials", "export_authorized_data", "freeze_modifications", "apply_retention_policy", "delete_eligible_data", "verify_deletion", "retain_audit_evidence", "close_organization"];
export function buildOffboardingReport(state) {
  const completed = new Set(state.completedSteps || []);
  const missing = OFFBOARDING_STEPS.filter((step) => !completed.has(step));
  return { organizationId: state.organizationId, complete: missing.length === 0, missingSteps: missing, dataCategoriesFound: state.dataCategoriesFound || [], exportStatus: state.exportStatus, credentialRevocation: state.credentialRevocation, deletionStatus: state.deletionStatus, retainedRecords: state.retainedRecords || [], legalHoldExceptions: state.legalHoldExceptions || [], verificationResult: missing.length === 0 ? "verified" : "incomplete" };
}