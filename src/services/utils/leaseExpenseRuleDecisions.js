import {
  deriveCamEligibility,
  deriveIncludedInBaseRent,
  deriveOperationalResponsibility,
  derivePaymentTreatment,
  deriveRecoverabilityDecision,
  normalizeTriStateDecision as normalizeCanonicalTriStateDecision,
  toLegacyCamEligible,
  toLegacyRecoverableFromTenant,
} from "./ruleDecisionEngine";

export function deriveRuleIncludedInBaseRent(rule) {
  return deriveIncludedInBaseRent(rule);
}

export function normalizeTriStateDecision(value, fallback = null) {
  return normalizeCanonicalTriStateDecision(value, fallback);
}

export function isRecoverableLike(rule) {
  return ["yes", "conditional"].includes(normalizeTriStateDecision(rule?.recoverable_from_tenant));
}

export function isCamEligibleLike(rule) {
  return ["yes", "conditional"].includes(normalizeTriStateDecision(rule?.cam_eligible));
}

export function deriveRuleOperationalResponsibility(rule) {
  return deriveOperationalResponsibility(rule);
}

export function deriveRulePaymentTreatment(rule) {
  return derivePaymentTreatment(rule);
}

export function deriveRuleRecoverableFromTenant(rule) {
  return toLegacyRecoverableFromTenant(deriveRecoverabilityDecision(rule));
}

export function deriveRuleCamEligible(rule) {
  return toLegacyCamEligible(deriveCamEligibility(rule));
}
