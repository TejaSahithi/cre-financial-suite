import {
  getEffectiveApprovalStatus,
  getEffectiveReviewStatus,
} from "@/lib/ruleStatus";

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeToken(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeDecision(value) {
  const token = normalizeToken(value);
  if (["yes", "true", "recoverable"].includes(token)) return "yes";
  if (["no", "false", "non_recoverable", "excluded"].includes(token)) return "no";
  if (["conditional", "needs_review"].includes(token)) return token;
  return "";
}

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

const WEAK_FALLBACK_TOKENS = new Set([
  "weak_evidence",
  "inferred",
  "text_fallback",
  "deterministic_template",
  ...COVERAGE_GAP_TOKENS,
]);

const GENERIC_SOURCE_PATTERNS = [
  /^llm extracted$/i,
  /^derived from/i,
  /^calculated from/i,
  /^workflow placeholder/i,
  /^[a-z0-9_]+:\s*[^.]{1,120}$/i,
  /field key/i,
  /not found/i,
  /unknown/i,
];

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

function isSupersededRule(rule = {}) {
  return [rule.row_status, rule.status, rule.extraction_status, rule.rule_status]
    .some((value) => normalizeToken(value) === "superseded");
}

function isApprovedRuleWorkflow(rule = {}) {
  // Logic-preserving migration to the central helper (src/lib/ruleStatus.js).
  return getEffectiveReviewStatus(rule) === "approved"
    && getEffectiveApprovalStatus(rule) === "approved";
}

function isManualOverrideRule(rule = {}) {
  return ruleTokens(rule).some((token) => ["manual", "manual_override", "user_override", "manually_added"].includes(token));
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
    rule.exact_source_text,
    rule.source_clause_text,
    rule.source_text,
    rule.evidence_text,
    rule.source
  ) || "").trim();
}

function getRuleSourcePage(rule = {}) {
  return firstPresent(rule.source_page, rule.page_number, rule.evidence_page_number, rule.page);
}

function isGenericSourceText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  if (trimmed.length < 8) return true;
  return GENERIC_SOURCE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function hasValidRuleEvidence(rule = {}) {
  const text = getRuleSourceText(rule);
  const page = getRuleSourcePage(rule);
  if (text && !isGenericSourceText(text)) return true;
  return page !== null && page !== undefined && String(page).trim() !== "";
}

function isWeakOrFallbackRule(rule = {}) {
  return ruleTokens(rule).some((token) => WEAK_FALLBACK_TOKENS.has(token));
}

function isCoverageGapRule(rule = {}) {
  if (isSupersededRule(rule)) return false;
  if (isManualOverrideRule(rule) && manualOverrideNote(rule)) return false;
  if (ruleTokens(rule).some((token) => COVERAGE_GAP_TOKENS.has(token))) return true;
  return !hasValidRuleEvidence(rule);
}

function isLeaseDerivedRule(rule = {}) {
  if (isSupersededRule(rule)) return false;
  if (isManualOverrideRule(rule) && manualOverrideNote(rule)) return true;
  if (isCoverageGapRule(rule)) return false;
  if (isWeakOrFallbackRule(rule)) return false;
  return hasValidRuleEvidence(rule);
}

function getRuleCategory(rule = {}) {
  return firstPresent(rule.expense_category, rule.category_name, rule.category, rule.normalized_key, rule.expense_subcategory);
}

function getPaymentTreatment(rule = {}) {
  return normalizeToken(firstPresent(rule.payment_treatment, rule.billing_treatment, rule.recovery_method));
}

function getRecoverableDecision(rule = {}) {
  const explicit = normalizeDecision(firstPresent(rule.recoverable_from_tenant, rule.recoverability_result, rule.recovery_status));
  if (explicit) return explicit;
  if (rule.is_recoverable === true) return "yes";
  if (rule.is_recoverable === false) return "no";
  return "";
}

function getCamEligibleDecision(rule = {}) {
  const explicit = normalizeDecision(rule.cam_eligible);
  if (explicit) return explicit;
  if (rule.is_cam_eligible === true) return "yes";
  if (rule.is_cam_eligible === false) return "no";
  return "";
}

function isIncludedInBaseRent(rule = {}) {
  const treatment = getPaymentTreatment(rule);
  return rule.included_in_base_rent === true || treatment === "included_in_base_rent";
}

function isTenantDirect(rule = {}) {
  return getPaymentTreatment(rule) === "tenant_direct_contract";
}

function isExplicitExclusion(rule = {}) {
  if (rule.is_excluded === true) return true;
  const type = normalizeToken(rule.rule_type);
  return type === "excluded" || type === "explicit_exclusion";
}

function getRuleClassificationExclusionReason(rule = {}, { scopeMatch = true } = {}) {
  if (!scopeMatch) return "wrong_scope";
  if (isSupersededRule(rule)) return "superseded";
  if (!isApprovedRuleWorkflow(rule)) return "not_approved";
  if (isCoverageGapRule(rule)) {
    return ruleTokens(rule).includes("original_lease_required") ? "original_lease_required" : "coverage_gap";
  }
  if (isWeakOrFallbackRule(rule) && !(isManualOverrideRule(rule) && manualOverrideNote(rule))) return "weak_fallback";
  if (!isLeaseDerivedRule(rule)) return "missing_source";
  if (!getRuleCategory(rule)) return "missing_category";
  if (isIncludedInBaseRent(rule)) return "included_in_base_rent";
  if (isTenantDirect(rule)) return "tenant_direct";
  if (isExplicitExclusion(rule)) return "explicit_exclusion";

  const recoverable = getRecoverableDecision(rule);
  const camEligible = getCamEligibleDecision(rule);
  if (recoverable === "no") return "non_recoverable";
  if (!["yes", "conditional"].includes(recoverable)) return "needs_review";
  if (camEligible === "no") return "non_cam";
  // Blank/unset cam_eligible is NOT the same as cam_eligible=no.
  // When recoverable=yes and cam_eligible is simply unset, the rule is
  // classification-eligible (treated as conditional/under-review) but is NOT
  // yet CAM-ready. The CAM gate (getRuleCamExclusionReason) still requires
  // cam_eligible=yes + published_to_cam=true, so blank never reaches CAM.
  // Only explicit cam_eligible=no (handled above) blocks classification.
  // If cam_eligible is conditional, allow through (still needs human review).

  return null;
}

function isRuleClassificationEligible(rule = {}, options = {}) {
  return getRuleClassificationExclusionReason(rule, options) === null;
}

function getRuleCamExclusionReason(rule = {}, options = {}) {
  const classificationReason = getRuleClassificationExclusionReason(rule, options);
  if (classificationReason) return classificationReason;
  if (getRecoverableDecision(rule) !== "yes") return "conditional_unresolved";
  if (getCamEligibleDecision(rule) !== "yes") return "conditional_unresolved";
  if (rule.published_to_cam !== true) return "not_published_to_cam";
  return null;
}

function isRuleCamEligible(rule = {}, options = {}) {
  return getRuleCamExclusionReason(rule, options) === null;
}

function getActualClassificationExclusionReason(actual = {}, { scopeMatch = true } = {}) {
  if (!scopeMatch) return "wrong_scope";
  const source = normalizeToken(firstPresent(actual.source, actual.source_type, actual.cam_input_type));
  if (["lease_import", "lease_rule_amount"].includes(source)) return "not_actual_expense";

  // Coverage-gap / synthesis metadata can leak onto actual expense rows if
  // upstream code stamps generation_source or row_status with extraction
  // sentinels. Actuals carrying those tokens are not real bills and must not
  // enter classification regardless of approval state.
  const generation = normalizeToken(firstPresent(actual.generation_source, actual.created_from));
  if (generation === "original_lease_required") return "original_lease_required";
  if (COVERAGE_GAP_TOKENS.has(generation)) return "coverage_gap";

  const rowStatus = normalizeToken(actual.row_status);
  if (rowStatus === "superseded") return "superseded";
  if (rowStatus === "coverage_gap") return "coverage_gap";

  // Use the centralized status helpers so eligibility agrees with the rest
  // of the codebase on what "approved" / "rejected" / "draft" mean. We keep
  // a separate raw review_status read because the original logic does not
  // promote "reviewed" → "approved" when checking for rejected/needs_review.
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
