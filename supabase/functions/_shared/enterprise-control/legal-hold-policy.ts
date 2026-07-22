// @ts-nocheck
export function legalHoldDecision(policy, artifact) {
  return policy?.legalHold || artifact?.legalHold ? { blocked: true, reasonCodes: ["legal_hold_active"] } : { blocked: false, reasonCodes: ["no_legal_hold"] };
}