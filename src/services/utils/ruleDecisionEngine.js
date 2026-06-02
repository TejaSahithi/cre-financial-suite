import {
  getEffectiveApprovalStatus,
  getEffectiveReviewStatus,
  getRawReviewStatus,
  getEffectiveRowStatus,
} from "@/lib/ruleStatus";
import {
  deriveRuleExactSourceText,
  deriveRuleSourcePage,
  isWeakSourceText,
} from "./leaseExpenseRuleFormatting";
import {
  firstPresent,
  normalizeCategoryKey,
  normalizeText,
} from "./leaseExpenseRuleParsers";

const DECISIVE_RULE_STATUSES = new Set(["approved", "rejected", "finalized", "not_applicable"]);
const NOT_APPLICABLE_ROW_STATUSES = new Set(["unmapped", "not_found", "not_mentioned", "not_applicable", "na", "n/a"]);
const INACTIVE_ROW_STATUSES = new Set(["archived", "deleted", "void", "voided", "superseded"]);
const NEEDS_REVIEW_ROW_STATUSES = new Set(["needs_review", "uncertain", "missing_value"]);

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

const WEAK_FALLBACK_TOKENS = new Set([
  "weak_evidence",
  "inferred",
  "text_fallback",
  "deterministic_template",
  ...COVERAGE_GAP_TOKENS,
]);

const CORE_CAM_CATEGORIES = new Set([
  "common_area_maintenance",
  "operating_expenses",
  "real_estate_taxes",
  "property_insurance",
  "utilities",
  "electricity",
  "water",
  "sewer",
  "gas",
  "janitorial",
  "trash_removal",
  "security",
  "landscaping",
  "snow_removal",
  "repairs_maintenance",
  "management_fees",
  "administrative_fees",
]);

function normalizeToken(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeTriStateDecision(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "yes" : "no";
  const normalized = normalizeToken(value);
  if (["yes", "true", "recoverable", "approved"].includes(normalized)) return "yes";
  if (["no", "false", "non_recoverable", "excluded", "not_recoverable"].includes(normalized)) return "no";
  if (["needs_review", "manual_review", "unknown", "unclear"].includes(normalized)) return "needs_review";
  if (["conditional", "shared", "maybe", "review"].includes(normalized)) return "conditional";
  return fallback;
}

function normalizeDecision(value) {
  return normalizeTriStateDecision(value, "");
}

function ruleTokens(rule = {}) {
  return [
    rule.generation_source,
    rule.source_type,
    rule.created_from,
    rule.extraction_source,
    rule.extraction_status,
    rule.row_status,
    rule.status,
    rule.rule_status,
  ].map(normalizeToken).filter(Boolean);
}

function isRuleSuperseded(rule = {}) {
  return [rule?.row_status, rule?.status, rule?.extraction_status, rule?.rule_status]
    .some((value) => normalizeToken(value) === "superseded");
}

function isManualOverrideRule(rule = {}) {
  return ruleTokens(rule).some((token) =>
    ["manual", "manual_override", "user_override", "manually_added"].includes(token)
  );
}

function manualOverrideNote(rule = {}) {
  return String(firstPresent(
    rule.manual_override_note,
    rule.manual_review_note,
    rule.review_note,
    rule.notes,
    rule.reasoning_summary,
    rule.reason
  ) || "").trim();
}

function getRuleSourceText(rule = {}) {
  return String(firstPresent(
    deriveRuleExactSourceText(rule),
    rule.exact_source_text,
    rule.source_clause_text,
    rule.source_text,
    rule.evidence_text,
    rule.source
  ) || "").trim();
}

function getRuleSourcePage(rule = {}) {
  return firstPresent(rule.source_page, rule.page_number, rule.evidence_page_number, rule.page, deriveRuleSourcePage(rule));
}

function hasValidRuleEvidence(rule = {}) {
  const text = getRuleSourceText(rule);
  const page = getRuleSourcePage(rule);
  if (text && !isWeakSourceText(text)) return true;
  return page !== null && page !== undefined && String(page).trim() !== "";
}

function isWeakOrFallbackRule(rule = {}) {
  return ruleTokens(rule).some((token) => WEAK_FALLBACK_TOKENS.has(token));
}

function isCoverageGapRule(rule = {}) {
  if (isRuleSuperseded(rule)) return false;
  if (isManualOverrideRule(rule) && manualOverrideNote(rule)) return false;
  if (ruleTokens(rule).some((token) => COVERAGE_GAP_TOKENS.has(token))) return true;
  return !hasValidRuleEvidence(rule);
}

function isLeaseDerivedRule(rule = {}) {
  if (isRuleSuperseded(rule)) return false;
  if (isManualOverrideRule(rule) && manualOverrideNote(rule)) return true;
  if (isCoverageGapRule(rule)) return false;
  if (isWeakOrFallbackRule(rule)) return false;
  return hasValidRuleEvidence(rule);
}

function deriveIncludedInBaseRent(rule = {}) {
  return Boolean(
    rule?.included_in_base_rent ??
    rule?.included_in_rent ??
    /included/.test(normalizeText(rule?.lease_treatment))
  );
}

function isRecoverableLike(rule = {}) {
  return ["yes", "conditional"].includes(normalizeTriStateDecision(rule?.recoverable_from_tenant));
}

function deriveOperationalResponsibility(rule = {}) {
  const explicit = normalizeText(firstPresent(rule?.operational_responsibility, rule?.responsibility));
  if (["landlord", "owner"].includes(explicit)) return "landlord";
  if (["tenant", "tenant_direct", "tenant_direct_contract"].includes(explicit)) return "tenant";
  if (["shared", "joint"].includes(explicit)) return "shared";
  if (deriveIncludedInBaseRent(rule)) return "landlord";
  if (rule?.is_excluded) return "tenant";
  if (isRecoverableLike(rule) || toLegacyRecoverableFromTenant(deriveRecoverabilityDecision(rule)) === "conditional") return "landlord";
  return "unknown";
}

function derivePaymentTreatment(rule = {}) {
  if (deriveIncludedInBaseRent(rule)) return "included_in_base_rent";
  const explicit = normalizeText(rule?.payment_treatment);
  if (["included_in_base_rent", "separately_billed", "tenant_direct_contract", "reimbursable", "not_applicable"].includes(explicit)) {
    return explicit;
  }
  const recoveryMethod = normalizeText(firstPresent(rule?.recovery_method, rule?.billing_treatment));
  if (recoveryMethod === "tenant_direct_contract" || rule?.is_excluded) return "tenant_direct_contract";
  if (isRecoverableLike(rule)) return "reimbursable";
  if (rule?.separately_billed === true) return "separately_billed";
  return "not_applicable";
}

function deriveRecoverabilityDecision(rule = {}) {
  const explicit = normalizeTriStateDecision(firstPresent(
    rule?.recoverable_from_tenant,
    rule?.recoverability_result,
    rule?.recovery_status
  ));
  if (explicit === "yes") return "recoverable";
  if (explicit === "no") return "not_recoverable";
  if (explicit === "conditional") return "conditional";
  if (explicit === "needs_review") return "unknown";
  if (typeof rule?.recoverable_flag === "boolean") return rule.recoverable_flag ? "recoverable" : "not_recoverable";
  if (typeof rule?.is_recoverable === "boolean") return rule.is_recoverable ? "recoverable" : "not_recoverable";
  const classification = normalizeToken(rule?.rule_classification);
  if (classification === "conditional") return "conditional";
  if (classification === "recoverable") return "recoverable";
  if (["non_recoverable", "not_recoverable", "excluded"].includes(classification)) return "not_recoverable";
  if (deriveIncludedInBaseRent(rule)) return "not_recoverable";
  if (normalizeToken(rule?.recovery_method) === "manual_review") return "conditional";
  return "not_recoverable";
}

function toLegacyRecoverableFromTenant(recoverability) {
  if (recoverability === "recoverable") return "yes";
  if (recoverability === "not_recoverable") return "no";
  if (recoverability === "conditional") return "conditional";
  return "needs_review";
}

function deriveCamEligibility(rule = {}) {
  const paymentTreatment = derivePaymentTreatment(rule);
  const recoverability = deriveRecoverabilityDecision(rule);

  if (deriveIncludedInBaseRent(rule) || paymentTreatment === "included_in_base_rent") return "not_eligible";
  if (paymentTreatment === "tenant_direct_contract") return "not_eligible";
  if (recoverability === "not_recoverable") return "not_eligible";
  if (recoverability === "conditional") return "conditional";

  const explicit = normalizeTriStateDecision(rule?.cam_eligible);
  if (explicit === "yes") return "eligible";
  if (explicit === "no") return "not_eligible";
  if (explicit === "conditional") return "conditional";
  if (explicit === "needs_review") return "unknown";

  const categoryKey = normalizeCategoryKey(firstPresent(
    rule?.normalized_key,
    rule?.expense_subcategory,
    rule?.expense_category,
    rule?.category_name
  ));
  if (CORE_CAM_CATEGORIES.has(categoryKey)) return "eligible";
  return "conditional";
}

function toLegacyCamEligible(camEligibility) {
  if (camEligibility === "eligible") return "yes";
  if (camEligibility === "not_eligible") return "no";
  if (camEligibility === "conditional") return "conditional";
  return "needs_review";
}

function deriveExclusionDecision(rule = {}) {
  const rowStatus = normalizeText(rule?.row_status || rule?.status || rule?.extraction_status);
  if (NOT_APPLICABLE_ROW_STATUSES.has(rowStatus)) return "not_applicable";
  const recoverability = deriveRecoverabilityDecision(rule);
  const camEligibility = deriveCamEligibility(rule);
  const approvalStatus = normalizeText(rule?.approval_status);
  if (Boolean(rule?.is_excluded) &&
    recoverability === "not_recoverable" &&
    camEligibility === "not_eligible" &&
    ["approved", "rejected"].includes(approvalStatus)) {
    return "not_applicable";
  }
  if (Boolean(rule?.is_excluded) || normalizeToken(rule?.rule_type) === "explicit_exclusion") return "excluded";
  return "included";
}

function deriveRuleStatus(rule = {}) {
  const approvalStatus = getEffectiveApprovalStatus(rule);
  const reviewStatus = getEffectiveReviewStatus(rule);
  const rawReviewStatus = getRawReviewStatus(rule);
  const rowStatus = getEffectiveRowStatus(rule);

  if (isRuleSuperseded(rule)) return "draft";
  if (deriveExclusionDecision(rule) === "not_applicable") return "not_applicable";
  if (approvalStatus === "rejected" || rawReviewStatus === "rejected" || rowStatus === "rejected") return "rejected";
  if (approvalStatus === "approved" && reviewStatus === "approved") return "approved";
  if (
    approvalStatus === "needs_review" ||
    rawReviewStatus === "needs_review" ||
    NEEDS_REVIEW_ROW_STATUSES.has(rowStatus)
  ) {
    return "needs_review";
  }
  return "draft";
}

function isRuleActiveForRuleSetStatus(rule = {}) {
  if (isRuleSuperseded(rule)) return false;
  const rowStatus = normalizeText(rule?.row_status || rule?.status);
  return !INACTIVE_ROW_STATUSES.has(rowStatus);
}

function deriveRuleSetStatus(rules = []) {
  const activeRules = (rules || []).filter(isRuleActiveForRuleSetStatus);
  if (activeRules.length === 0) return "draft";
  if (activeRules.every((rule) => {
    const status = deriveRuleStatus(rule);
    return ["approved", "rejected", "not_applicable"].includes(status);
  })) {
    return "approved";
  }
  if (activeRules.some((rule) => deriveRuleStatus(rule) === "needs_review")) return "needs_review";
  return "draft";
}

function addBlocker(blockingReasons, reason) {
  if (!blockingReasons.includes(reason)) blockingReasons.push(reason);
}

function derivePublishToCamEligibility(rule = {}) {
  const blockingReasons = [];
  const status = deriveRuleStatus(rule);
  const recoverability = deriveRecoverabilityDecision(rule);
  const camEligibility = deriveCamEligibility(rule);
  const paymentTreatment = derivePaymentTreatment(rule);
  const exclusion = deriveExclusionDecision(rule);

  if (rule?.published_to_cam === true) {
    return {
      status: "already_published",
      eligible: false,
      blockingReasons: ["already_published"],
    };
  }
  if (status !== "approved") addBlocker(blockingReasons, status === "needs_review" ? "needs_review" : "not_approved");
  if (recoverability !== "recoverable") addBlocker(blockingReasons, recoverability === "not_recoverable" ? "not_recoverable" : "conditional_unresolved");
  if (camEligibility !== "eligible") addBlocker(blockingReasons, camEligibility === "not_eligible" ? "not_cam_eligible" : "conditional_unresolved");
  if (deriveIncludedInBaseRent(rule) || paymentTreatment === "included_in_base_rent") addBlocker(blockingReasons, "included_in_base_rent");
  if (paymentTreatment === "tenant_direct_contract") addBlocker(blockingReasons, "tenant_direct");
  if (exclusion === "excluded" || exclusion === "not_applicable") addBlocker(blockingReasons, "explicit_exclusion");

  const hasLeaseEvidence = hasValidRuleEvidence(rule) && !isWeakSourceText(getRuleSourceText(rule));
  const hasManualOverride = isManualOverrideRule(rule) && manualOverrideNote(rule).length > 0;
  const weakOrFallback = isWeakOrFallbackRule(rule);
  if (weakOrFallback && !hasManualOverride) addBlocker(blockingReasons, "weak_fallback");
  if (!hasLeaseEvidence && !hasManualOverride) addBlocker(blockingReasons, "missing_lease_evidence");

  return {
    status: blockingReasons.length === 0 ? "eligible" : "blocked",
    eligible: blockingReasons.length === 0,
    blockingReasons,
  };
}

function getRuleClassificationExclusionReason(rule = {}, { scopeMatch = true } = {}) {
  if (!scopeMatch) return "wrong_scope";
  if (isRuleSuperseded(rule)) return "superseded";
  if (deriveRuleStatus(rule) !== "approved") return "not_approved";
  if (isCoverageGapRule(rule)) {
    return ruleTokens(rule).includes("original_lease_required") ? "original_lease_required" : "coverage_gap";
  }
  if (isWeakOrFallbackRule(rule) && !(isManualOverrideRule(rule) && manualOverrideNote(rule))) return "weak_fallback";
  if (!isLeaseDerivedRule(rule)) return "missing_source";
  if (!firstPresent(rule.expense_category, rule.category_name, rule.category, rule.normalized_key, rule.expense_subcategory)) return "missing_category";
  if (deriveIncludedInBaseRent(rule)) return "included_in_base_rent";
  if (derivePaymentTreatment(rule) === "tenant_direct_contract") return "tenant_direct";
  if (deriveExclusionDecision(rule) !== "included") return "explicit_exclusion";

  const recoverability = deriveRecoverabilityDecision(rule);
  const camEligibility = deriveCamEligibility(rule);
  if (recoverability === "not_recoverable") return "non_recoverable";
  if (!["recoverable", "conditional"].includes(recoverability)) return "needs_review";
  if (camEligibility === "not_eligible") return "non_cam";
  return null;
}

function getRuleCamExclusionReason(rule = {}, options = {}) {
  const classificationReason = getRuleClassificationExclusionReason(rule, options);
  if (classificationReason) return classificationReason;
  if (deriveRecoverabilityDecision(rule) !== "recoverable") return "conditional_unresolved";
  if (deriveCamEligibility(rule) !== "eligible") return "conditional_unresolved";
  if (rule.published_to_cam !== true) return "not_published_to_cam";
  return null;
}

function deriveRuleDecision(rule = {}) {
  const status = deriveRuleStatus(rule);
  const recoverability = deriveRecoverabilityDecision(rule);
  const exclusion = deriveExclusionDecision(rule);
  const camEligibility = deriveCamEligibility(rule);
  const publishToCam = derivePublishToCamEligibility(rule);
  return {
    status,
    recoverability,
    exclusion,
    camEligibility,
    publishToCamEligibility: publishToCam.status,
    blockingReasons: publishToCam.blockingReasons,
    legacy: {
      recoverableFromTenant: toLegacyRecoverableFromTenant(recoverability),
      camEligible: toLegacyCamEligible(camEligibility),
      paymentTreatment: derivePaymentTreatment(rule),
      includedInBaseRent: deriveIncludedInBaseRent(rule),
    },
  };
}

export {
  deriveCamEligibility,
  deriveExclusionDecision,
  deriveIncludedInBaseRent,
  deriveOperationalResponsibility,
  derivePaymentTreatment,
  derivePublishToCamEligibility,
  deriveRecoverabilityDecision,
  deriveRuleDecision,
  deriveRuleSetStatus,
  getRuleCamExclusionReason,
  getRuleClassificationExclusionReason,
  getRuleSourceText,
  hasValidRuleEvidence,
  isCoverageGapRule,
  isLeaseDerivedRule,
  isManualOverrideRule,
  isRuleActiveForRuleSetStatus,
  isRuleSuperseded,
  normalizeDecision,
  normalizeToken,
  normalizeTriStateDecision,
  toLegacyCamEligible,
  toLegacyRecoverableFromTenant,
};
