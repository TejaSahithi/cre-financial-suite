import {
  deriveExclusionDecision,
  deriveRuleDecision,
  deriveRuleSetStatus,
  isManualOverrideRule as isCanonicalManualOverrideRule,
  isRuleActiveForRuleSetStatus as isCanonicalRuleActiveForRuleSetStatus,
  isRuleSuperseded as isCanonicalRuleSuperseded,
} from "./ruleDecisionEngine";

export function isRuleSuperseded(rule) {
  return isCanonicalRuleSuperseded(rule);
}

export function isRuleApproved(rule) {
  return deriveRuleDecision(rule).status === "approved";
}

export function isManualOverrideRule(rule) {
  return isCanonicalManualOverrideRule(rule);
}

export function isProtectedHumanRule(rule) {
  return isRuleApproved(rule) ||
    Boolean(rule?.published_to_cam) ||
    isManualOverrideRule(rule);
}

export function isRuleRejected(rule) {
  return deriveRuleDecision(rule).status === "rejected";
}

export function isRuleNotApplicable(rule) {
  return deriveExclusionDecision(rule) === "not_applicable";
}

export function isRuleActiveForRuleSetStatus(rule) {
  return isCanonicalRuleActiveForRuleSetStatus(rule);
}

export function isRuleResolvedForRuleSetStatus(rule) {
  return isRuleApproved(rule) || isRuleRejected(rule) || isRuleNotApplicable(rule);
}

export function deriveRuleSetStatusFromRules(rules = []) {
  return deriveRuleSetStatus(rules);
}
