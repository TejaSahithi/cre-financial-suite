import {
  getEffectiveApprovalStatus,
} from "@/lib/ruleStatus";
import {
  getRuleCamExclusionReason,
  getRuleClassificationExclusionReason,
  getRuleSourceText,
  hasValidRuleEvidence,
  isCoverageGapRule,
  isLeaseDerivedRule,
  isRuleSuperseded as isSupersededRule,
  normalizeDecision,
  normalizeToken,
} from "@/services/utils/ruleDecisionEngine";

function firstPresent(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const COVERAGE_GAP_TOKENS = new Set([
  "original_lease_required",
  "not_found",
  "not_mentioned",
  "missing_source_evidence",
  "template_checklist",
  "amount_only_gap",
  "text_fallback_keyword",
  "unsupported",
  "unsupported_fallback",
]);

function isApprovedRuleWorkflow(rule = {}) {
  return getRuleClassificationExclusionReason(rule, { scopeMatch: true }) !== "not_approved";
}

function isRuleClassificationEligible(rule = {}, options = {}) {
  return getRuleClassificationExclusionReason(rule, options) === null;
}

function isRuleCamEligible(rule = {}, options = {}) {
  return getRuleCamExclusionReason(rule, options) === null;
}

function getActualClassificationExclusionReason(actual = {}, { scopeMatch = true } = {}) {
  if (!scopeMatch) return "wrong_scope";
  const source = normalizeToken(firstPresent(actual.source, actual.source_type, actual.cam_input_type));
  if (["lease_import", "lease_rule_amount"].includes(source)) return "not_actual_expense";

  const generation = normalizeToken(firstPresent(actual.generation_source, actual.created_from));
  if (generation === "original_lease_required") return "original_lease_required";
  if (COVERAGE_GAP_TOKENS.has(generation)) return "coverage_gap";

  const rowStatus = normalizeToken(actual.row_status);
  if (rowStatus === "superseded") return "superseded";
  if (rowStatus === "coverage_gap") return "coverage_gap";

  const approval = getEffectiveApprovalStatus(actual);
  const review = normalizeToken(actual.review_status);
  const status = normalizeToken(actual.status);
  if ([approval, review, status, rowStatus].includes("rejected")) return "rejected";
  if ([approval, review, status, rowStatus].includes("draft")) return "draft";
  if ([approval, review].includes("needs_review")) return "needs_review";
  if (![approval, review, status].some((value) => ["approved", "finalized", "active", "executed"].includes(value))) return "not_approved";

  const amount = asNumber(actual.amount);
  if (amount === null || amount === 0) return "missing_amount";
  return null;
}

function isActualClassificationEligible(actual = {}, options = {}) {
  return getActualClassificationExclusionReason(actual, options) === null;
}

export {
  getActualClassificationExclusionReason,
  getRuleCamExclusionReason,
  getRuleClassificationExclusionReason,
  getRuleSourceText,
  hasValidRuleEvidence,
  isActualClassificationEligible,
  isApprovedRuleWorkflow,
  isCoverageGapRule,
  isLeaseDerivedRule,
  isRuleCamEligible,
  isRuleClassificationEligible,
  isSupersededRule,
  normalizeDecision,
  normalizeToken,
};
