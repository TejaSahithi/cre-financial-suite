// @ts-nocheck
export const RELEASE10_REQUIRED_GATES = ["database_migration", "rls_policy", "tenant_isolation", "contract_compatibility", "benchmark_regression", "error_budget_health", "backup_health", "dr_readiness", "security_scan", "dependency_scan", "frontend_build", "backend_checks", "staging_smoke"];
export function evaluateReleaseGates(results) {
  const failed = RELEASE10_REQUIRED_GATES.filter((gate) => results[gate] !== "passed");
  return { passed: failed.length === 0, failed, reasonCodes: failed.length ? ["release_gate_failed"] : ["release_gates_passed"] };
}