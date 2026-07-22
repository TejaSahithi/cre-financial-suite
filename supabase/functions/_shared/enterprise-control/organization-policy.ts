// @ts-nocheck
export function mayUseCapability(entitlement, requestedMode = "production") {
  if (!entitlement?.enabled) return { allowed: false, reasonCodes: ["capability_not_entitled"] };
  const order = ["disabled", "diagnostic", "enforced_internal", "pilot", "production", "broad_ga"];
  return order.indexOf(entitlement.rolloutMode) >= order.indexOf(requestedMode)
    ? { allowed: true, reasonCodes: ["capability_entitled"] }
    : { allowed: false, reasonCodes: ["rollout_mode_too_low"] };
}
export function validateOnboardingChecklist(checks) {
  const missing = Object.entries(checks || {}).filter(([, value]) => !value).map(([key]) => key);
  return { ready: missing.length === 0, missing, reasonCodes: missing.length ? ["onboarding_incomplete"] : ["onboarding_complete"] };
}