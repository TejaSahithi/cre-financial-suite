import { normalizeText } from "./leaseExpenseRuleParsers";
import {
  getEffectiveReviewStatus,
  getEffectiveApprovalStatus,
  getRawReviewStatus,
  getEffectiveRowStatus
} from "@/lib/ruleStatus";
import {
  deriveRuleCamEligible,
  deriveRuleRecoverableFromTenant,
} from "./leaseExpenseRuleDecisions";

export function isRuleSuperseded(rule) {
  return [rule?.row_status, rule?.status, rule?.extraction_status]
    .some((value) => normalizeText(value) === "superseded");
}

export function isRuleApproved(rule) {
  // Logic-preserving migration to the central helper. See src/lib/ruleStatus.js.
  return getEffectiveReviewStatus(rule) === "approved"
    && getEffectiveApprovalStatus(rule) === "approved";
}

export function isManualOverrideRule(rule) {
  return [
    rule?.created_from,
    rule?.generation_source,
    rule?.source_type,
  ].some((value) => ["manual", "manual_override", "user_override"].includes(normalizeText(value))) ||
    normalizeText(rule?.row_status) === "manually_added";
}

export function isProtectedHumanRule(rule) {
  return isRuleApproved(rule) ||
    Boolean(rule?.published_to_cam) ||
    isManualOverrideRule(rule);
}

export function isRuleRejected(rule) {
  // Bare review_status read (no "reviewed" → "approved" promotion) preserves
  // original semantics from before the helper consolidation.
  const rowStatus = normalizeText(rule?.row_status || rule?.status);
  return getRawReviewStatus(rule) === "rejected"
    || getEffectiveApprovalStatus(rule) === "rejected"
    || rowStatus === "rejected";
}

export function isRuleNotApplicable(rule) {
  const rowStatus = normalizeText(rule?.row_status || rule?.status || rule?.extraction_status);
  if (["unmapped", "not_found", "not_mentioned", "not_applicable", "na", "n/a"].includes(rowStatus)) return true;
  return Boolean(rule?.is_excluded) &&
    deriveRuleRecoverableFromTenant(rule) === "no" &&
    deriveRuleCamEligible(rule) === "no" &&
    ["approved", "rejected"].includes(normalizeText(rule?.approval_status));
}

export function isRuleActiveForRuleSetStatus(rule) {
  if (isRuleSuperseded(rule)) return false;
  const rowStatus = normalizeText(rule?.row_status || rule?.status);
  return !["archived", "deleted", "void", "voided", "superseded"].includes(rowStatus);
}

export function isRuleResolvedForRuleSetStatus(rule) {
  return isRuleApproved(rule) || isRuleRejected(rule) || isRuleNotApplicable(rule);
}

export function deriveRuleSetStatusFromRules(rules = []) {
  const activeRules = (rules || []).filter(isRuleActiveForRuleSetStatus);
  if (activeRules.length === 0) return "draft";
  if (activeRules.every(isRuleResolvedForRuleSetStatus)) return "approved";
  if (activeRules.some((rule) => {
    const rowStatus = getEffectiveRowStatus(rule);
    return getRawReviewStatus(rule) === "needs_review" ||
      getEffectiveApprovalStatus(rule) === "needs_review" ||
      rowStatus === "needs_review" ||
      rowStatus === "uncertain" ||
      rowStatus === "missing_value";
  })) {
    return "needs_review";
  }
  return "draft";
}
