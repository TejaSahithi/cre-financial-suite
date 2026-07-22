// @ts-nocheck
export function legacyRetirementDecision(input) {
  const failures = [];
  if (input.activeUsageCount > 0) failures.push("legacy_usage_active");
  if (!input.replacementParityVerified) failures.push("replacement_parity_required");
  if (!input.rollbackAvailable) failures.push("rollback_required");
  if (!input.supportSignoff || !input.securitySignoff) failures.push("support_and_security_signoff_required");
  return { allowed: failures.length === 0, reasonCodes: failures.length ? failures : ["legacy_retirement_allowed"] };
}