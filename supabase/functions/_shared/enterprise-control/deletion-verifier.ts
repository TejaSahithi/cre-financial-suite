// @ts-nocheck
export function verifyDeletion(plan, observedRemainingIds) {
  const remaining = new Set(observedRemainingIds || []);
  const failures = plan.filter((item) => item.deletable && remaining.has(item.artifactId)).map((item) => item.artifactId);
  return { verified: failures.length === 0, failures, reasonCodes: failures.length ? ["deletion_verification_failed"] : ["deletion_verified"] };
}