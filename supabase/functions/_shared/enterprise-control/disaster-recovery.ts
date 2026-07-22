// @ts-nocheck
export const DR_TARGETS = { tier0: { rpoMinutes: 5, rtoMinutes: 60 }, tier1: { rpoMinutes: 15, rtoMinutes: 240 }, tier2: { rpoMinutes: 1440, rtoMinutes: 1440 } };
export function evaluateDrExercise(exercise) {
  const target = DR_TARGETS[exercise.tier];
  if (!target) return { passed: false, reasonCodes: ["unknown_reliability_tier"] };
  const failures = [];
  if (exercise.observedRpoMinutes > target.rpoMinutes) failures.push("rpo_target_missed");
  if (exercise.observedRtoMinutes > target.rtoMinutes) failures.push("rto_target_missed");
  if (!exercise.auditContinuityPreserved) failures.push("audit_continuity_required");
  return { passed: failures.length === 0, reasonCodes: failures.length ? failures : ["dr_targets_met"] };
}
export function degradedModeDecision(serviceTier, dependency) {
  if (serviceTier === "tier0" && dependency.unavailable) return { mode: "fail_closed", reasonCodes: ["tier0_dependency_unavailable"] };
  if (serviceTier === "tier1" && dependency.unavailable) return { mode: "last_known_valid", reasonCodes: ["tier1_degraded"] };
  if (dependency.unavailable) return { mode: "disable_optional", reasonCodes: ["tier2_degraded"] };
  return { mode: "normal", reasonCodes: ["dependency_available"] };
}