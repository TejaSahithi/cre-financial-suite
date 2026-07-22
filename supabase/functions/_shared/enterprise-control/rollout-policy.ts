// @ts-nocheck
export function rolloutAllowedByGates(input) {
  const failures = [];
  if (!input.errorBudget?.rolloutAllowed) failures.push("error_budget_blocks_rollout");
  if (!input.backupHealthy) failures.push("backup_health_required");
  if (!input.drExerciseComplete) failures.push("dr_exercise_required");
  if (input.criticalSecurityFindings > 0) failures.push("critical_security_findings_present");
  if (input.legacyUsageActive) failures.push("legacy_usage_active");
  return { allowed: failures.length === 0, reasonCodes: failures.length ? failures : ["rollout_gates_passed"] };
}