import {
  RULE_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  deriveRuleExactSourceText,
  deriveRuleSourcePage,
  deriveRuleConfidence,
  normalizeConfidenceScore,
  extractRuleValue,
  extractRuleClauses,
  isWeakSourceText,
  hasStrongRuleEvidence,
  deriveRuleCategoryName,
  deriveRuleSubcategoryName,
  deriveRuleNormalizedKey,
  resolveCanonicalExpenseCategory,
  isRuleExcludedFromLeaseExpenses
} from "./utils/leaseExpenseRuleFormatting";

import {
  isRuleSuperseded,
  isRuleApproved,
  isProtectedHumanRule,
  isRuleRejected,
  isRuleNotApplicable,
  deriveRuleSetStatusFromRules
} from "./utils/leaseExpenseRuleStatus";

import {
  deriveRuleCamEligible,
  deriveRuleIncludedInBaseRent,
  deriveRuleOperationalResponsibility,
  deriveRulePaymentTreatment,
  deriveRuleRecoverableFromTenant,
  isRecoverableLike,
  normalizeTriStateDecision,
} from "./utils/leaseExpenseRuleDecisions";

import {
  asNumber,
  asArray,
  normalizeFrequency,
  normalizeRuleSource,
  normalizeCategoryToken,
  normalizeCategoryKey,
  humanizeLabel,
  normalizeText,
  isUuid,
  firstPresent,
  isLlmGeneratedRule,
  isApprovedWorkflowStatus,
  isEvidenceAlignedVersion,
  EVIDENCE_ALIGNED_EXTRACTION_VERSION,
  LEGACY_EXTRACTION_VERSION
} from "./utils/leaseExpenseRuleParsers";

import { supabase } from "@/services/supabaseClient";
import { getCurrentOrgId } from "@/services/api";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import { saveLeaseConfig } from "@/services/camConfig";
import { devLog, devTable, devWarn } from "./utils/logger";

import {
  getEffectiveReviewStatus,
} from "@/lib/ruleStatus";
import {
  derivePublishToCamEligibility,
} from "./utils/ruleDecisionEngine";
























function isRuleCamPublishable(rule) {
  return derivePublishToCamEligibility(rule).status === "eligible";
}

function derivePublishedToCam(rule) {
  if (isRuleNotApplicable(rule) || isRuleRejected(rule)) return false;
  const eligibility = derivePublishToCamEligibility(rule);
  return eligibility.status === "eligible" || eligibility.status === "already_published";
}

function pickPreferredRuleSetWithApprovedChildren(ruleSets = [], rulesBySet = new Map()) {
  if (!Array.isArray(ruleSets) || ruleSets.length === 0) return null;
  const sorted = [...ruleSets].sort((a, b) => {
    const aVersion = Number(a?.version) || 0;
    const bVersion = Number(b?.version) || 0;
    if (aVersion !== bVersion) return bVersion - aVersion;
    return Date.parse(b?.updated_at || b?.created_at || "") - Date.parse(a?.updated_at || a?.created_at || "");
  });

  const latestV3WithEvidence = sorted.find((ruleSet) => {
    if (!isEvidenceAlignedVersion(ruleSet?.extraction_version)) return false;
    return (rulesBySet.get(ruleSet?.id) || []).some((rule) =>
      !isRuleSuperseded(rule) &&
      isEvidenceAlignedVersion(rule?.extraction_version) &&
      normalizeText(rule?.generation_source) !== "template_checklist" &&
      Boolean(String(firstPresent(rule?.exact_source_text, rule?.source) || "").trim())
    );
  });
  if (latestV3WithEvidence) return latestV3WithEvidence;

  const v3ApprovedOrPublished = sorted.find((ruleSet) =>
    isEvidenceAlignedVersion(ruleSet?.extraction_version) &&
    (
      isApprovedWorkflowStatus(ruleSet?.status) ||
      (rulesBySet.get(ruleSet?.id) || []).some((rule) =>
        !isRuleSuperseded(rule) && (isRuleApproved(rule) || Boolean(rule?.published_to_cam))
      )
    )
  );
  if (v3ApprovedOrPublished) return v3ApprovedOrPublished;

  const latestNonSuperseded = sorted.find((ruleSet) =>
    (rulesBySet.get(ruleSet?.id) || []).some((rule) => !isRuleSuperseded(rule))
  );
  if (latestNonSuperseded) return latestNonSuperseded;

  const olderApprovedRuleSet = sorted.find((ruleSet) =>
    isApprovedWorkflowStatus(ruleSet?.status) ||
    isApprovedWorkflowStatus(ruleSet?.approval_status) ||
    isApprovedWorkflowStatus(ruleSet?.review_status) ||
    (rulesBySet.get(ruleSet?.id) || []).some(isRuleApproved)
  );
  return olderApprovedRuleSet || sorted[0] || null;
}

function selectPreferredRuleSet(ruleSets = [], rulesBySet = new Map()) {
  return pickPreferredRuleSetWithApprovedChildren(ruleSets, rulesBySet);
}

export {
  deriveRuleCamEligible,
  deriveRuleRecoverableFromTenant,
};

function deriveRuleBillingTreatment(rule) {
  const explicit = normalizeText(rule?.billing_treatment);
  if (["included", "direct_bill", "cam_estimate", "reconciliation", "none"].includes(explicit)) {
    return explicit;
  }

  const paymentTreatment = deriveRulePaymentTreatment(rule);
  const recoveryMethod = normalizeText(firstPresent(rule?.recovery_method, deriveRuleRecoveryMethod(rule)));
  if (paymentTreatment === "included_in_base_rent") return "included";
  if (["direct_bill", "actual_usage", "tenant_direct_contract"].includes(recoveryMethod)) return "direct_bill";
  if (["base_year", "expense_stop", "base_year_excess", "expense_stop_excess", "reconciliation"].includes(recoveryMethod)) return "reconciliation";
  if (["fixed_monthly", "pro_rata_share", "monthly_reimbursement", "pass_through"].includes(recoveryMethod)) return "cam_estimate";
  return "none";
}

function deriveRuleRecoveryMethod(rule) {
  const paymentTreatment = deriveRulePaymentTreatment(rule);
  const recoverable = deriveRuleRecoverableFromTenant(rule);
  const camEligible = deriveRuleCamEligible(rule);
  const explicit = normalizeText(firstPresent(rule?.recovery_method));

  if (deriveRuleIncludedInBaseRent(rule) || paymentTreatment === "included_in_base_rent") {
    return "included_in_base_rent";
  }
  if (paymentTreatment === "tenant_direct_contract") {
    return "tenant_direct_contract";
  }

  const derived = firstPresent(
    rule?.recovery_method,
    rule?.base_year ? "base_year" : null,
    rule?.expense_stop_amount ? "expense_stop" : null,
    rule?.included_in_base_rent || rule?.included_in_rent ? "included_in_base_rent" : null,
    rule?.billing_frequency === "monthly" ? "monthly_reimbursement" : null,
    ["yes", "conditional"].includes(deriveRuleRecoverableFromTenant(rule)) ? "pass_through" : null,
  );

  if ((recoverable === "no" || camEligible === "no") && ["pass_through", "pro_rata_share"].includes(explicit || derived)) {
    return "not_applicable";
  }

  return derived || "not_applicable";
}

function deriveRuleAllocationBasis(rule) {
  const recoverable = deriveRuleRecoverableFromTenant(rule);
  const camEligible = deriveRuleCamEligible(rule);
  if (!["yes", "conditional"].includes(recoverable) || !["yes", "conditional"].includes(camEligible)) {
    return null;
  }
  return firstPresent(rule?.allocation_basis, rule?.allocation_method, rule?.pro_rata_basis, "pro_rata_share");
}

function deriveRuleExtractionStatus(rule) {
  if (rule?.extraction_status) return rule.extraction_status;
  if (normalizeRuleStatus(rule) === "not_mentioned") return "not_found";
  return "extracted";
}

// Auto-approve any rule whose extractor confidence is ≥ 80% AND has some
// real evidence backing it (source text present + not a not-found row).
// Anything below that — or rules that came back as not_found /
// missing_source_evidence — defaults to needs_review for a human to ratify.
// Manually-added rules and rules with explicit review_status pass through.
function deriveRuleReviewStatus(rule) {
  if (rule?.review_status) {
    return normalizeText(rule.review_status) === "reviewed" ? "approved" : rule.review_status;
  }
  if (isLlmGeneratedRule(rule)) return "needs_review";
  const status = normalizeRuleStatus(rule);
  if (status === "not_mentioned") return "not_found";
  if (status === "manually_added") return "approved"; // explicit human input

  const extractionStatus = normalizeText(rule?.extraction_status || rule?.status);
  if (extractionStatus === "not_found" || extractionStatus === "missing_source_evidence") {
    return "needs_review";
  }

  const confidence = deriveRuleConfidence(rule);
  const sourceText = deriveRuleExactSourceText(rule);
  if (typeof confidence === "number" && confidence >= RULE_AUTO_APPROVE_CONFIDENCE_THRESHOLD && sourceText) {
    return "approved";
  }
  return "needs_review";
}

function deriveRuleApprovalStatus(rule, ruleSetStatus = "draft") {
  const explicitApprovalStatus = normalizeText(rule?.approval_status);
  if (deriveRuleReviewStatus(rule) === "approved") return "approved";
  if (explicitApprovalStatus) return rule.approval_status;
  return ruleSetStatus === "approved" ? "approved" : "draft";
}

function deriveRuleReconciliationRequired(rule) {
  if (typeof rule?.reconciliation_required === "boolean") return rule.reconciliation_required;
  const recoveryMethod = normalizeText(deriveRuleRecoveryMethod(rule));
  return ["base_year", "expense_stop", "pass_through"].includes(recoveryMethod);
}

function deriveRuleReconciliationFrequency(rule) {
  return firstPresent(
    rule?.reconciliation_frequency,
    deriveRuleReconciliationRequired(rule) ? "annual" : null,
  );
}













function isRuleResponsibilityKnown(rule) {
  const responsibility = normalizeText(firstPresent(rule?.operational_responsibility, rule?.responsibility, deriveRuleOperationalResponsibility(rule)));
  return Boolean(responsibility) && !["unknown", "manual_review"].includes(responsibility);
}

function isRuleRecoverableKnown(rule) {
  if (normalizeTriStateDecision(rule?.recoverable_from_tenant)) return true;
  if (typeof rule?.is_recoverable === "boolean") return true;
  if (deriveRuleIncludedInBaseRent(rule) || rule?.is_excluded) return true;
  return ["recoverable", "conditional", "non_recoverable", "excluded"].includes(normalizeText(rule?.rule_classification));
}

function isRuleRecoveryMethodSpecific(rule) {
  const recoveryMethod = normalizeText(firstPresent(rule?.recovery_method, deriveRuleRecoveryMethod(rule)));
  return Boolean(recoveryMethod) && !["manual_review", "none", "unknown"].includes(recoveryMethod);
}

function resolveRuleWorkflowState(rule, ruleSetStatus = "draft") {
  if (isRuleSuperseded(rule)) {
    return {
      exactSourceText: deriveRuleExactSourceText(rule),
      confidence: normalizeConfidenceScore(firstPresent(rule?.confidence_score, rule?.confidence)),
      strongEvidence: false,
      extractionStatus: "superseded",
      reviewStatus: "needs_review",
      approvalStatus: "draft",
      rowStatus: "superseded",
      publishedToCam: false,
    };
  }

  const exactSourceText = deriveRuleExactSourceText(rule);
  const confidence = normalizeConfidenceScore(firstPresent(rule?.confidence_score, rule?.confidence));
  const strongEvidence = hasStrongRuleEvidence({ ...rule, exact_source_text: exactSourceText });
  const explicitExtractionStatus = normalizeText(rule?.extraction_status || rule?.status);
  // Auto-approve when confidence ≥ 80% AND there's *some* source evidence
  // (real text, not just an inferred classification). Multi-condition gate
  // was too strict — it forced too many rules into needs_review even when
  // the LLM was highly confident.
  const notFoundRow = explicitExtractionStatus === "not_found"
    || explicitExtractionStatus === "missing_source_evidence";
  const autoApproved =
    !isLlmGeneratedRule(rule) &&
    !notFoundRow &&
    Boolean(exactSourceText) &&
    confidence != null &&
    confidence >= RULE_AUTO_APPROVE_CONFIDENCE_THRESHOLD;

  const extractionStatus = explicitExtractionStatus || (strongEvidence ? "extracted" : "inferred");
  const explicitReviewStatus = getEffectiveReviewStatus(rule);
  const reviewStatus = explicitReviewStatus || (autoApproved ? "approved" : "needs_review");
  const approvalStatus =
    reviewStatus === "approved"
      ? "approved"
      : (normalizeText(rule?.approval_status) || (autoApproved && ruleSetStatus === "approved" ? "approved" : "draft"));
  const rowStatus =
    extractionStatus === "not_found"
      ? "not_mentioned"
      : (autoApproved || normalizeText(rule?.row_status) === "manually_added")
        ? normalizeText(rule?.row_status) || "mapped"
        : "needs_review";
  return {
    exactSourceText,
    confidence,
    strongEvidence,
    extractionStatus,
    reviewStatus,
    approvalStatus,
    rowStatus,
    publishedToCam: derivePublishedToCam({
      ...rule,
      review_status: reviewStatus,
      approval_status: approvalStatus,
      row_status: rowStatus,
    }),
  };
}

function getRuleValidation(rule) {
  const includedInBaseRent = deriveRuleIncludedInBaseRent(rule);
  const paymentTreatment = deriveRulePaymentTreatment(rule);
  const recoverableFromTenant = deriveRuleRecoverableFromTenant(rule);
  const camEligible = deriveRuleCamEligible(rule);
  const recoveryMethod = deriveRuleRecoveryMethod(rule);
  const allocationBasis = deriveRuleAllocationBasis(rule);
  // Fall back to the derived status when no explicit field is present.
  const reviewStatus = getEffectiveReviewStatus(rule) || normalizeText(deriveRuleReviewStatus(rule));
  const approvalStatus = normalizeText(rule?.approval_status || deriveRuleApprovalStatus(rule));
  const sourcePage = deriveRuleSourcePage(rule);
  const exactSourceText = deriveRuleExactSourceText(rule);
  const publishEligibility = derivePublishToCamEligibility(rule);
  const alreadyPublished = publishEligibility.status === "already_published";
  const hasValidSourcePage = Number.isFinite(Number(sourcePage)) && Number(sourcePage) > 0;
  const hasLeaseSourceText = Boolean(String(exactSourceText || "").trim());
  const strongSourceText = hasLeaseSourceText && !isWeakSourceText(exactSourceText);
  const issues = [];
  const warnings = [];

  if (includedInBaseRent && paymentTreatment !== "included_in_base_rent") {
    issues.push("Included in rent rules must use payment treatment included_in_base_rent.");
  }
  if ((recoverableFromTenant === "no" || camEligible === "no") && ["pass_through", "pro_rata_share"].includes(normalizeText(recoveryMethod))) {
    issues.push("Non-recoverable or CAM-ineligible rules cannot use pass_through or pro_rata_share recovery.");
  }
  if (recoverableFromTenant === "no" && camEligible === "yes") {
    issues.push("CAM Eligible cannot be yes when Recoverable is no.");
  }
  if (recoverableFromTenant === "no" && camEligible === "conditional") {
    warnings.push("CAM Eligible is conditional even though Recoverable is no; verify the clause before publishing.");
  }
  if (includedInBaseRent && Boolean(rule?.published_to_cam)) {
    issues.push("Included in rent rules cannot be published to CAM.");
  }
  if (!["yes", "conditional"].includes(recoverableFromTenant) && allocationBasis) {
    warnings.push("Allocation basis is ignored unless the rule is recoverable and CAM-eligible.");
  }
  if (!hasValidSourcePage) {
    warnings.push("Source page is missing. Use the real lease document page number before approval.");
  }
  if (!hasLeaseSourceText) {
    warnings.push("Exact source text is missing. Approval should reference the actual lease clause.");
  } else if (!strongSourceText) {
    warnings.push("Exact source text appears inferred or too weak. Confirm the actual lease clause before approval.");
  }

  // Blocker labels are SHORT — they render in a tight column. Verbose
  // explanations belong in tooltips/help text, not the table cell.
  const approvalBlockers = [];
  const isManual = rule?.created_from === "manual" || rule?.generation_source === "manual";

  if (isManual) {
    if (!hasValidSourcePage && !(rule?.notes && String(rule.notes).trim().length > 0)) {
      warnings.push("Missing notes for manual override");
    }
  } else {
    // Make these warnings instead of strict blockers so the user can approve them
    if (!hasValidSourcePage) warnings.push("Missing source page");
    if (!hasLeaseSourceText) warnings.push("Missing source text");
    if (hasLeaseSourceText && !strongSourceText) warnings.push("Source text too weak");
  }

  const publishBlockerLabels = {
    already_published: "Already published",
    conditional_unresolved: "Conditional rule",
    explicit_exclusion: "Excluded",
    included_in_base_rent: "Included in rent",
    missing_lease_evidence: "Missing lease evidence",
    needs_review: "Not reviewed",
    not_approved: "Not approved",
    not_cam_eligible: "Not CAM eligible",
    not_recoverable: "Not recoverable",
    tenant_direct: "Tenant direct contract",
    weak_fallback: "Missing lease evidence",
  };
  const publishBlockers = [
    ...approvalBlockers,
    ...publishEligibility.blockingReasons.map((reason) => publishBlockerLabels[reason] || reason),
    ...issues,
  ];

  return {
    includedInBaseRent,
    paymentTreatment,
    recoverableFromTenant,
    camEligible,
    recoveryMethod,
    allocationBasis,
    reviewStatus,
    approvalStatus,
    sourcePage,
    exactSourceText,
    approvalBlockers,
    issues,
    warnings,
    publishBlockers,
    canApprove: approvalBlockers.length === 0,
    canPublishToCam: publishEligibility.status === "eligible" && issues.length === 0 && approvalBlockers.length === 0,
    publishedToCam: alreadyPublished,
  };
}

function buildCamRuleLineItem(rule, lease, categoriesById = new Map()) {
  const category = categoriesById.get(rule?.expense_category_id);
  const validation = getRuleValidation(rule);
  return {
    lease_expense_rule_id: rule.id,
    rule_key: rule.rule_key || null,
    category: firstPresent(rule?.expense_category, rule?.category_name, category?.category_name, deriveRuleCategoryName(rule)),
    subcategory: firstPresent(rule?.expense_subcategory, rule?.subcategory_name, category?.subcategory_name, deriveRuleSubcategoryName(rule)),
    recovery_method: validation.recoveryMethod,
    allocation_basis: validation.allocationBasis,
    cap_amount: asNumber(firstPresent(rule?.cap_amount, rule?.cap_value)),
    cap_percent: asNumber(rule?.cap_percent),
    admin_fee_percent: asNumber(rule?.admin_fee_percent),
    gross_up_percent: asNumber(rule?.gross_up_percent),
    reconciliation_required: Boolean(rule?.reconciliation_required ?? deriveRuleReconciliationRequired(rule)),
    lease_id: lease?.id || rule?.lease_id || null,
    tenant_id: lease?.tenant_id || rule?.tenant_id || null,
    property_id: lease?.property_id || rule?.property_id || null,
    building_id: lease?.building_id || rule?.building_id || null,
    unit_id: lease?.unit_id || rule?.unit_id || null,
    
    exact_source_text: validation.exactSourceText,
    published_scope: {
      property_id: lease?.property_id || rule?.property_id || null,
      building_id: lease?.building_id || rule?.building_id || null,
      unit_id: lease?.unit_id || rule?.unit_id || null,
    },
  };
}

function canonicalRuleDedupKey(rule, index = 0) {
  const category = resolveCanonicalExpenseCategory(rule, index);
  return `${category.normalizedKey}::${normalizeCategoryKey(category.subcategoryName) || ""}`;
}

function scoreRuleForDedup(rule) {
  const state = resolveRuleWorkflowState(rule, normalizeText(rule?.approval_status) === "approved" ? "approved" : "draft");
  return [
    state.approvalStatus === "approved" ? 500 : 0,
    state.reviewStatus === "approved" ? 250 : 0,
    state.strongEvidence ? 200 : 0,
    Number.isFinite(Number(rule?.source_page)) ? 120 : 0,
    state.confidence != null ? Math.round(state.confidence * 100) : 0,
    deriveRuleExactSourceText(rule) ? 40 : 0,
    extractRuleValue(rule) != null ? 25 : 0,
  ].reduce((sum, score) => sum + score, 0);
}

function finalizeLeaseExpenseRules(rules = [], ruleSetStatus = "draft") {
  const deduped = new Map();

  (rules || []).forEach((rule, index) => {
    const category = resolveCanonicalExpenseCategory(rule, index);
    if (isRuleExcludedFromLeaseExpenses(rule, category.canonicalKey)) return;

    const workflowState = resolveRuleWorkflowState(rule, ruleSetStatus);
    const recoverableFromTenant = deriveRuleRecoverableFromTenant(rule);
    const operationalResponsibility = deriveRuleOperationalResponsibility(rule);
    const paymentTreatment = deriveRulePaymentTreatment(rule);
    const camEligible = deriveRuleCamEligible(rule);
    const billingTreatment = deriveRuleBillingTreatment(rule);
    const normalizedRule = {
      ...rule,
      normalized_key: category.normalizedKey,
      fallback_category_key: category.normalizedKey,
      category_name: category.categoryName,
      subcategory_name: category.subcategoryName || null,
      expense_category: category.categoryName,
      expense_subcategory: category.subcategoryName || null,
      operational_responsibility: isRuleResponsibilityKnown(rule) ? operationalResponsibility : "unknown",
      responsibility: isRuleResponsibilityKnown(rule) ? operationalResponsibility : "unknown",
      payment_treatment: paymentTreatment,
      included_in_base_rent: deriveRuleIncludedInBaseRent(rule),
      recoverable_from_tenant: recoverableFromTenant,
      cam_eligible: camEligible,
      billing_treatment: billingTreatment,
      recovery_method: firstPresent(rule?.recovery_method, deriveRuleRecoveryMethod(rule), "manual_review"),
      allocation_basis: firstPresent(rule?.allocation_basis, deriveRuleAllocationBasis(rule)),
      exact_source_text: workflowState.exactSourceText,
      
      confidence: workflowState.confidence ?? deriveRuleConfidence(rule),
      confidence_score: workflowState.confidence ?? deriveRuleConfidence(rule),
      extraction_status: workflowState.extractionStatus,
      review_status: workflowState.reviewStatus,
      approval_status: workflowState.approvalStatus,
      published_to_cam: workflowState.publishedToCam,
      row_status: workflowState.rowStatus,
      source: firstPresent(rule?.source, workflowState.exactSourceText),
      is_recoverable: ["yes", "conditional"].includes(recoverableFromTenant),
      is_fallback: rule?.is_fallback || workflowState.extractionStatus === "inferred",
    };

    const dedupKey = canonicalRuleDedupKey(normalizedRule, index);
    const existing = deduped.get(dedupKey);
    if (!existing || scoreRuleForDedup(normalizedRule) >= scoreRuleForDedup(existing)) {
      deduped.set(dedupKey, normalizedRule);
    }
  });

  return [...deduped.values()];
}

function normalizeRuleStatus(rule) {
  const raw = String(rule?.row_status || "").trim().toLowerCase();
  return raw || "needs_review";
}

function canonicalRulePersistenceKey(rule) {
  const category = normalizeCategoryKey(firstPresent(
    rule?.normalized_key,
    rule?.fallback_category_key,
    rule?.expense_category,
    rule?.category_name,
    rule?.category,
  ));
  const subcategory = normalizeCategoryKey(firstPresent(rule?.expense_subcategory, rule?.subcategory_name));
  const paymentTreatment = normalizeCategoryKey(firstPresent(rule?.payment_treatment, deriveRulePaymentTreatment(rule)));
  const recoveryMethod = normalizeCategoryKey(firstPresent(rule?.recovery_method, deriveRuleRecoveryMethod(rule)));
  return [category, subcategory, paymentTreatment, recoveryMethod].join("::");
}

function scorePersistedRuleForMerge(rule) {
  return [
    isProtectedHumanRule(rule) ? 1000 : 0,
    isRuleApproved(rule) ? 500 : 0,
    Boolean(rule?.published_to_cam) ? 300 : 0,
    isEvidenceAlignedVersion(rule?.extraction_version) ? 200 : 0,
    normalizeText(rule?.generation_source) === "template_checklist" ? -100 : 0,
    deriveRuleExactSourceText(rule) ? 80 : 0,
    Number.isFinite(Number(rule?.confidence_score || rule?.confidence))
      ? Math.round(Number(rule?.confidence_score || rule?.confidence) * 100)
      : 0,
  ].reduce((sum, score) => sum + score, 0);
}

function getMissingColumnName(error) {
  const errorMessage = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
  return (
    errorMessage.match(/Could not find the '([^']+)' column/i)?.[1] ||
    errorMessage.match(/column "?([a-zA-Z0-9_]+)"? of relation/i)?.[1] ||
    errorMessage.match(/column "?([a-zA-Z0-9_]+)"? does not exist/i)?.[1] ||
    null
  );
}

function isMissingColumnError(error) {
  return error?.code === "PGRST204" || error?.code === "42703" || Boolean(getMissingColumnName(error));
}

async function updateWithMissingColumnFallback(makeQuery, patch, { maxAttempts = 12 } = {}) {
  let nextPatch = { ...patch };
  const droppedColumns = [];
  let attemptsRemaining = maxAttempts;

  while (Object.keys(nextPatch).length > 0 && attemptsRemaining > 0) {
    const { data, error } = await makeQuery(nextPatch);
    if (!error) {
      return { data, droppedColumns, appliedPatch: nextPatch };
    }

    const missingColumn = getMissingColumnName(error);
    if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in nextPatch)) {
      throw error;
    }
    droppedColumns.push(missingColumn);
    const { [missingColumn]: _stripped, ...rest } = nextPatch;
    nextPatch = rest;
    attemptsRemaining -= 1;
  }

  return { data: null, droppedColumns, appliedPatch: nextPatch };
}

async function supersedeUnresolvedRules({ leaseId, ruleSetId, orgId, extractionVersion }) {
  if (!leaseId || !ruleSetId) return { superseded: 0, deleted: 0, droppedColumns: [] };

  const { data: existingRows, error: existingError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .eq("lease_id", leaseId)
    .eq("rule_set_id", ruleSetId);
  if (existingError) throw existingError;

  const targetIds = (existingRows || [])
    .filter((rule) => !isProtectedHumanRule(rule))
    .map((rule) => rule.id)
    .filter(Boolean);
  if (targetIds.length === 0) return { superseded: 0, deleted: 0, droppedColumns: [] };

  // Per spec: post-upsert count must reflect (new rules + preserved approved
  // rows), not stale rows + new rows. Marking rows with row_status="superseded"
  // leaves them physically present in the table — every downstream count and
  // listing still sees them. So we DELETE stale unresolved rows first.
  // If the delete fails (e.g. RLS), fall back to marker columns so at
  // least the row state is updated; never silently succeed when both
  // paths fail.
  const deleteQuery = supabase
    .from("lease_expense_rules")
    .delete()
    .in("id", targetIds)
    .eq("lease_id", leaseId)
    .eq("rule_set_id", ruleSetId);
  const scopedDelete = orgId ? deleteQuery.eq("org_id", orgId) : deleteQuery;
  const { data: deletedRows, error: deleteError } = await scopedDelete.select("id");

  if (!deleteError) {
    return { superseded: 0, deleted: deletedRows?.length || targetIds.length, droppedColumns: [] };
  }

  devWarn(
    "[leaseExpenseRuleService] supersedeUnresolvedRules DELETE failed; falling back to marker update.",
    {
      code: deleteError.code,
      message: deleteError.message,
      details: deleteError.details,
      hint: deleteError.hint,
      targetIdCount: targetIds.length,
    },
  );

  const now = new Date().toISOString();
  const patch = {
    row_status: "superseded",
    status: "superseded",
    extraction_status: "superseded",
    review_status: "needs_review",
    approval_status: "draft",
    published_to_cam: false,
    superseded_at: now,
    superseded_by_version: extractionVersion || EVIDENCE_ALIGNED_EXTRACTION_VERSION,
    updated_at: now,
  };

  const result = await updateWithMissingColumnFallback(
    (nextPatch) => supabase
      .from("lease_expense_rules")
      .update(nextPatch)
      .in("id", targetIds)
      .eq("lease_id", leaseId)
      .eq("rule_set_id", ruleSetId)
      .select("id"),
    patch,
  );

  const markerColumns = ["row_status", "status", "extraction_status"];
  const appliedMarker = markerColumns.some((column) => Object.prototype.hasOwnProperty.call(result.appliedPatch || {}, column));
  if (!appliedMarker) {
    // Both DELETE and any marker-column UPDATE failed. Surface the original
    // delete error so the caller knows cleanup is incomplete.
    throw deleteError;
  }

  if (result.droppedColumns.length > 0) {
    devWarn("[leaseExpenseRuleService] supersedeUnresolvedRules marker UPDATE stripped unsupported columns:", result.droppedColumns);
  }
  return { superseded: result.data?.length || targetIds.length, deleted: 0, droppedColumns: result.droppedColumns };
}

function normalizeRecoveryStatus(rule) {
  if (rule?.is_excluded) return "excluded";
  if (normalizeTriStateDecision(rule?.recoverable_from_tenant) === "conditional") return "conditional";
  if (normalizeRuleStatus(rule) === "uncertain") return "conditional";
  if (normalizeRuleStatus(rule) === "missing_value") return "needs_review";
  if (isRecoverableLike(rule) || ["yes", "conditional"].includes(deriveRuleRecoverableFromTenant(rule))) return "recoverable";
  if (rule?.mentioned_in_lease || deriveRuleExtractionStatus(rule) === "extracted") return "non_recoverable";
  return "needs_review";
}



function buildCategoryMatchIndex(categories = []) {
  const index = new Map();

  for (const category of categories) {
    const tokens = [
      category?.category_name,
      category?.subcategory_name,
      category?.normalized_key,
      [category?.category_name, category?.subcategory_name].filter(Boolean).join(" "),
    ]
      .map(normalizeCategoryToken)
      .filter(Boolean);

    for (const token of tokens) {
      if (!index.has(token)) {
        index.set(token, category);
      }
    }
  }

  return index;
}

function resolveCategoryForRule(rule, categories = [], categoryIndex = buildCategoryMatchIndex(categories)) {
  const directMatches = [
    rule?.expense_category_id ? categories.find((category) => category.id === rule.expense_category_id) : null,
    categoryIndex.get(normalizeCategoryToken(rule?.category_name)),
    categoryIndex.get(normalizeCategoryToken(rule?.subcategory_name)),
    categoryIndex.get(normalizeCategoryToken(rule?.normalized_key)),
    categoryIndex.get(normalizeCategoryToken([rule?.category_name, rule?.subcategory_name].filter(Boolean).join(" "))),
  ].filter(Boolean);

  if (directMatches.length > 0) return directMatches[0];

  const requestedCategory = normalizeCategoryToken(rule?.category_name);
  const requestedSubcategory = normalizeCategoryToken(rule?.subcategory_name);

  return categories.find((category) => {
    const categoryName = normalizeCategoryToken(category?.category_name);
    const subcategoryName = normalizeCategoryToken(category?.subcategory_name);
    return (
      (requestedCategory && (categoryName.includes(requestedCategory) || requestedCategory.includes(categoryName))) ||
      (requestedSubcategory && (subcategoryName.includes(requestedSubcategory) || requestedSubcategory.includes(subcategoryName)))
    );
  }) || null;
}

function buildRuleCategorySeed(rule, index = 0) {
  return {
    category_name: deriveRuleCategoryName(rule),
    subcategory_name: deriveRuleSubcategoryName(rule),
    normalized_key: deriveRuleNormalizedKey(rule, index),
  };
}

async function ensurePersistentCategories({ orgId, categories = [], rules = [] }) {
  const seededByKey = new Map();
  const allCategories = Array.isArray(categories) ? [...categories] : [];

  for (const category of allCategories) {
    const normalizedKey = normalizeCategoryKey(category?.normalized_key || category?.subcategory_name || category?.category_name);
    if (!normalizedKey) continue;
    seededByKey.set(normalizedKey, {
      ...category,
      normalized_key: normalizedKey,
      category_name: category?.category_name || humanizeLabel(normalizedKey),
      subcategory_name: category?.subcategory_name || null,
    });
  }

  rules.forEach((rule, index) => {
    const seed = buildRuleCategorySeed(rule, index);
    if (!seed.normalized_key || seededByKey.has(seed.normalized_key)) return;
    seededByKey.set(seed.normalized_key, seed);
  });

  const normalizedKeys = [...seededByKey.keys()];
  if (!orgId || normalizedKeys.length === 0) {
    return { categories: allCategories, rules };
  }

  try {
    const { data: existingCategories, error: existingError } = await supabase
      .from("expense_categories")
      .select("id, category_name, subcategory_name, normalized_key, display_order")
      .or(`org_id.eq.${orgId},org_id.is.null`)
      .in("normalized_key", normalizedKeys);

    if (existingError) throw existingError;

    const categoryByKey = new Map();
    for (const category of existingCategories || []) {
      if (!category?.normalized_key || categoryByKey.has(category.normalized_key)) continue;
      categoryByKey.set(category.normalized_key, category);
    }

    const missingKeys = normalizedKeys.filter((key) => !categoryByKey.has(key));
    if (missingKeys.length > 0) {
      const insertPayload = missingKeys.map((key, index) => {
        const seed = seededByKey.get(key);
        return {
          org_id: orgId,
          is_system_default: false,
          is_active: true,
          display_order: 1000 + index,
          normalized_key: key,
          category_name: seed?.category_name || humanizeLabel(key),
          subcategory_name: seed?.subcategory_name || null,
        };
      });

      const { data: insertedCategories, error: insertError } = await supabase
        .from("expense_categories")
        .insert(insertPayload)
        .select("id, category_name, subcategory_name, normalized_key, display_order");

      if (insertError) {
        // RLS denies the insert when the current user/role isn't permitted to
        // create org-scoped categories (e.g. anon key, restricted member).
        // Don't fail the whole rule-save — continue with whatever categories
        // already exist (the seeded system defaults). Rules for the missing
        // keys will fall through to the text-only path with expense_category
        // populated but expense_category_id NULL, which we now allow.
        const code = String(insertError.code || "");
        const message = `${insertError.message || ""} ${insertError.details || ""}`;
        const isRlsDenial =
          code === "42501" ||
          /row-level security/i.test(message) ||
          /permission denied/i.test(message);
        if (isRlsDenial) {
          devWarn(
            `[leaseExpenseRuleService] expense_categories INSERT denied by RLS for ${insertPayload.length} key(s) — using existing seeded categories. Missing keys:`,
            insertPayload.map((p) => p.normalized_key),
          );
        } else {
          throw insertError;
        }
      } else {
        for (const category of insertedCategories || []) {
          if (!category?.normalized_key) continue;
          categoryByKey.set(category.normalized_key, category);
        }
      }
    }

    const mergedCategories = [
      ...allCategories.filter((category) => isUuid(category?.id)),
      ...[...categoryByKey.values()].filter((category) =>
        !allCategories.some((existing) => existing?.id === category.id)
      ),
    ];

    const resolvedRules = (rules || []).map((rule, index) => {
      const resolvedCategory =
        (isUuid(rule?.expense_category_id) && mergedCategories.find((category) => category.id === rule.expense_category_id)) ||
        categoryByKey.get(deriveRuleNormalizedKey(rule, index)) ||
        null;

      if (!resolvedCategory?.id) {
        return {
          ...rule,
          category_name: firstPresent(rule?.category_name, deriveRuleCategoryName(rule)),
          subcategory_name: firstPresent(rule?.subcategory_name, deriveRuleSubcategoryName(rule)),
          normalized_key: firstPresent(rule?.normalized_key, deriveRuleNormalizedKey(rule, index)),
        };
      }

      return {
        ...rule,
        expense_category_id: resolvedCategory.id,
        category_name: firstPresent(rule?.category_name, resolvedCategory.category_name, deriveRuleCategoryName(rule)),
        subcategory_name: firstPresent(rule?.subcategory_name, resolvedCategory.subcategory_name, deriveRuleSubcategoryName(rule)),
        normalized_key: resolvedCategory.normalized_key || deriveRuleNormalizedKey(rule, index),
      };
    });

    return { categories: mergedCategories, rules: resolvedRules };
  } catch (error) {
    if (!isMissingExpenseRuleTable(error)) throw error;
    return { categories: allCategories, rules };
  }
}

function mapExtractedRulesToCategories(aiRules = [], categories = [], existingRules = []) {
  const categoryIndex = buildCategoryMatchIndex(categories);
  const existingByCategoryId = new Map(
    (existingRules || [])
      .filter((rule) => rule?.expense_category_id)
      .map((rule) => [rule.expense_category_id, rule])
  );

  return (aiRules || [])
    .map((rule) => {
      const matchedCategory = resolveCategoryForRule(rule, categories, categoryIndex);
      if (!matchedCategory?.id) return null;

      const existingRule = existingByCategoryId.get(matchedCategory.id) || {};
      return {
        ...existingRule,
        ...rule,
        expense_category_id: matchedCategory.id,
        category_name: matchedCategory.category_name,
        subcategory_name: matchedCategory.subcategory_name || null,
      };
    })
    .filter(Boolean);
}

function buildLeaseConfigFromRules(lease, rules = [], categoriesById = new Map()) {
  const approvedRules = rules.filter(isRuleApproved);
  const camPublishedRules = approvedRules.filter((rule) =>
    Boolean(getRuleValidation(rule).publishedToCam)
  );
  const excludedExpenses = approvedRules
    .filter((rule) => rule.is_excluded || deriveRuleRecoverableFromTenant(rule) === "no" || deriveRuleCamEligible(rule) === "no")
    .map((rule) => {
      const category = categoriesById.get(rule.expense_category_id);
      return category?.normalized_key || category?.subcategory_name || category?.category_name || null;
    })
    .filter(Boolean);

  const cappedRule = camPublishedRules.find((rule) => rule.is_subject_to_cap);
  const baseYearRule = camPublishedRules.find((rule) => rule.has_base_year);
  const adminRule = camPublishedRules.find((rule) => rule.admin_fee_applicable && asNumber(rule.admin_fee_percent) != null);

  return {
    cam_applicable: camPublishedRules.length > 0,
    cam_cap_type: cappedRule?.cap_type || lease?.cam_cap_type || "none",
    cam_cap_rate: cappedRule?.cap_type !== "fixed" ? asNumber(cappedRule?.cap_value ?? lease?.cam_cap_rate) : asNumber(lease?.cam_cap_rate),
    cam_cap: cappedRule?.cap_type === "fixed" ? asNumber(cappedRule?.cap_value ?? lease?.cam_cap) : asNumber(lease?.cam_cap),
    base_year: baseYearRule?.base_year_type || null,
    base_year_amount: asNumber(baseYearRule?.base_year_amount ?? lease?.base_year_amount),
    expense_stop_amount: asNumber(lease?.expense_stop_amount),
    gross_up_clause: camPublishedRules.some((rule) => rule.gross_up_applicable) || Boolean(lease?.gross_up_clause),
    allocation_method: lease?.allocation_method || "",
    weight_factor: asNumber(lease?.weight_factor),
    excluded_expenses: [...new Set(excludedExpenses)],
    management_fee_pct: asNumber(lease?.management_fee_pct),
    controllable_cap_rate: cappedRule?.is_controllable ? asNumber(cappedRule?.cap_value) : null,
    non_cumulative_cap_base_year: cappedRule?.cap_type === "non_cumulative" ? asNumber(lease?.base_year_amount) : null,
    admin_fee_pct: asNumber(adminRule?.admin_fee_percent ?? lease?.admin_fee_pct),
    cam_rule_lines: camPublishedRules.map((rule) => buildCamRuleLineItem(rule, lease, categoriesById)),
  };
}

async function resolveWorkflowOrgId(lease) {
  return resolveWritableOrgId(lease?.org_id || await getCurrentOrgId());
}

async function loadRuleDependencies(ruleSetId) {
  if (!ruleSetId) return { rules: [], valuesByRuleId: new Map(), clausesByRuleId: new Map() };

  const { data: rules, error: rulesError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .eq("rule_set_id", ruleSetId);
  if (rulesError) throw rulesError;

  const ruleIds = (rules || []).map((rule) => rule.id).filter(Boolean);
  const [{ data: values, error: valuesError }, { data: clauses, error: clausesError }] = await Promise.all([
    ruleIds.length > 0
      ? supabase.from("lease_expense_values").select("*").in("rule_id", ruleIds)
      : Promise.resolve({ data: [], error: null }),
    ruleIds.length > 0
      ? supabase.from("lease_expense_rule_clauses").select("*").in("lease_expense_rule_id", ruleIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (valuesError) throw valuesError;
  if (clausesError) throw clausesError;

  const valuesByRuleId = new Map();
  (values || []).forEach((value) => valuesByRuleId.set(value.rule_id, value));

  const clausesByRuleId = new Map();
  (clauses || []).forEach((clause) => {
    const existing = clausesByRuleId.get(clause.lease_expense_rule_id) || [];
    existing.push(clause);
    clausesByRuleId.set(clause.lease_expense_rule_id, existing);
  });

  return {
    rules: rules || [],
    valuesByRuleId,
    clausesByRuleId,
  };
}

function mergeRulesWithRelations(rules = [], valuesByRuleId = new Map(), clausesByRuleId = new Map()) {
  return (rules || []).map((rule) => {
    const valueRow = valuesByRuleId.get(rule.id) || null;
    return {
      ...rule,
      ...valueRow,
      clauses: clausesByRuleId.get(rule.id) || [],
    };
  });
}

function getLeaseExtractedValue(lease, fieldName) {
  if (!lease || !fieldName) return null;
  if (lease[fieldName] != null && lease[fieldName] !== "") return lease[fieldName];

  const extractedFields = lease?.extracted_fields && typeof lease.extracted_fields === "object"
    ? lease.extracted_fields
    : lease?.extraction_data?.extracted_fields && typeof lease.extraction_data.extracted_fields === "object"
      ? lease.extraction_data.extracted_fields
      : null;

  if (extractedFields && extractedFields[fieldName] != null && extractedFields[fieldName] !== "") {
    return extractedFields[fieldName];
  }

  const customField = asArray(lease?.extraction_data?.custom_fields)
    .find((field) => field?.field_key === fieldName && field?.value != null && field?.value !== "");

  return customField?.value ?? null;
}

function getLeaseWorkflowOutput(lease) {
  const workflow = lease?.extraction_data?.workflow_output;
  if (!workflow || typeof workflow !== "object") return null;
  if (Array.isArray(workflow?.records) && workflow.records[0]) return workflow.records[0];
  return workflow;
}

function getLeaseWorkflowExpenseRules(lease) {
  return asArray(getLeaseWorkflowOutput(lease)?.expense_rules);
}

function hasWorkflowExpenseRules(lease) {
  return getLeaseWorkflowExpenseRules(lease).length > 0;
}

function isMissingExpenseRuleTable(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  if (code === "PGRST205" || code === "42P01") return true;
  const text = String(error.message || error.details || error.hint || "").toLowerCase();
  return /expense_categories|scope_expense_categories|lease_expense_rule_sets|lease_expense_rules|lease_expense_values|lease_expense_rule_clauses/.test(text)
    && /does not exist|could not find/.test(text);
}

function workflowRuleCategoryId(rule, index) {
  const key = normalizeCategoryKey(
    rule?.expense_category ||
    rule?.category ||
    rule?.key ||
    rule?.expense_subcategory ||
    `workflow_rule_${index + 1}`
  );
  return `workflow:${key || `rule_${index + 1}`}`;
}

function workflowRuleStatus(rule) {
  const explicit = normalizeText(rule?.status);
  if (explicit === "manual_required") return "needs_review";
  if (explicit === "not_mentioned") return "not_mentioned";
  if (explicit === "missing_value") return "missing_value";

  const recoveryClass = normalizeText(rule?.rule_classification);
  if (recoveryClass === "conditional") return "uncertain";
  if (recoveryClass === "excluded") return "mapped";

  const explicitValue = asNumber(
    rule?.explicit_charge_amount ??
    rule?.charge_amount ??
    rule?.amount ??
    rule?.extracted_value
  );

  if (explicitValue != null || rule?.recoverable_flag != null || recoveryClass) {
    return "mapped";
  }
  return "needs_review";
}

function buildWorkflowRuleClause(rule, leaseId) {
  const clauseText = String(
    rule?.source_clause ??
    rule?.clause_text ??
    rule?.notes ??
    rule?.lease_treatment ??
    ""
  ).trim();
  if (!clauseText) return [];

  return [{
    lease_expense_rule_id: null,
    lease_id: leaseId,
    page_number: Number.isFinite(Number(rule?.source_page)) ? Number(rule.source_page) : null,
    clause_type: rule?.clause_type || "supporting_text",
    clause_text: clauseText,
    confidence: asNumber(rule?.confidence ?? rule?.confidence_score),
  }];
}

function buildFallbackRulesFromWorkflow(lease) {
  return getLeaseWorkflowExpenseRules(lease).map((rule, index) => {
    const categoryKey = deriveRuleNormalizedKey(rule, index);
    const subcategoryKey = normalizeCategoryKey(rule?.expense_subcategory);
    const explicitValue = asNumber(
      rule?.explicit_charge_amount ??
      rule?.charge_amount ??
      rule?.amount ??
      rule?.extracted_value
    );
    const recoveryClass = normalizeText(rule?.rule_classification);
    const categoryName = deriveRuleCategoryName(rule);
    const subcategoryName = deriveRuleSubcategoryName(rule);
    const ruleSetStatus = ["approved", "budget_ready", "active", "executed"].includes(
      normalizeText(lease?.abstract_status || lease?.status)
    )
      ? "approved"
      : "draft";
    const includedInBaseRent = deriveRuleIncludedInBaseRent(rule);
    const recoverableFromTenant = deriveRuleRecoverableFromTenant(rule);
    const exactSourceText = deriveRuleExactSourceText(rule);
    const confidence = deriveRuleConfidence(rule);

    const operationalResponsibility = deriveRuleOperationalResponsibility(rule);
    const paymentTreatment = deriveRulePaymentTreatment(rule);
    const camEligible = deriveRuleCamEligible(rule);
    const billingTreatment = deriveRuleBillingTreatment(rule);

    return {
      id: `workflow-rule-${lease.id}-${index}`,
      rule_set_id: `workflow-rule-set-${lease.id}`,
      lease_id: lease.id,
      tenant_id: lease.tenant_id || null,
      property_id: lease.property_id || null,
      building_id: lease.building_id || null,
      unit_id: lease.unit_id || null,
      expense_category_id: workflowRuleCategoryId(rule, index),
      category_name: categoryName,
      subcategory_name: subcategoryName,
      normalized_key: categoryKey || null,
      expense_category: categoryName,
      expense_subcategory: subcategoryName,
      operational_responsibility: operationalResponsibility,
      responsibility: operationalResponsibility,
      payment_treatment: paymentTreatment,
      included_in_base_rent: includedInBaseRent,
      recoverable_from_tenant: recoverableFromTenant,
      cam_eligible: camEligible,
      billing_treatment: billingTreatment,
      recovery_method: deriveRuleRecoveryMethod(rule),
      allocation_basis: deriveRuleAllocationBasis(rule),
      row_status: workflowRuleStatus(rule),
      mentioned_in_lease: true,
      is_recoverable: ["yes", "conditional"].includes(recoverableFromTenant) || recoveryClass === "recoverable" || recoveryClass === "conditional",
      is_excluded: recoveryClass === "excluded" || rule?.excluded_from_recovery === true,
      is_controllable: Boolean(rule?.is_controllable),
      is_subject_to_cap: Boolean(rule?.is_subject_to_cap || rule?.cap_type),
      cap_type: rule?.cap_type || null,
      cap_value: asNumber(rule?.cap_value ?? rule?.cap_amount),
      cap_amount: asNumber(rule?.cap_amount ?? rule?.cap_value),
      cap_percent: asNumber(rule?.cap_percent),
      has_base_year: Boolean(rule?.has_base_year || rule?.base_year_type),
      base_year_type: rule?.base_year_type || null,
      base_year: firstPresent(rule?.base_year, rule?.base_year_type),
      base_year_amount: asNumber(rule?.base_year_amount),
      expense_stop_amount: asNumber(rule?.expense_stop_amount),
      gross_up_applicable: Boolean(rule?.gross_up_applicable),
      gross_up_percent: asNumber(rule?.gross_up_percent),
      admin_fee_applicable: Boolean(rule?.admin_fee_applicable),
      admin_fee_percent: asNumber(rule?.admin_fee_percent),
      extracted_value: explicitValue,
      manual_value: null,
      final_value: explicitValue,
      frequency: normalizeFrequency(rule?.billing_frequency || rule?.frequency),
      billing_frequency: normalizeFrequency(rule?.billing_frequency || rule?.frequency),
      reconciliation_required: deriveRuleReconciliationRequired(rule),
      reconciliation_frequency: deriveRuleReconciliationFrequency(rule),
      
      exact_source_text: exactSourceText,
      confidence: confidence,
      confidence_score: confidence,
      extraction_status: deriveRuleExtractionStatus(rule),
      review_status: deriveRuleReviewStatus(rule),
      approval_status: deriveRuleApprovalStatus(rule, ruleSetStatus),
      published_to_cam: Boolean(rule?.published_to_cam),
      notes: rule?.notes || null,
      source: exactSourceText,
      clauses: buildWorkflowRuleClause(rule, lease.id),
      source_type: "workflow_output",
      is_fallback: true,
      fallback_category_key: subcategoryKey || categoryKey || null,
    };
  });
}

function buildFallbackRuleSetEntry(lease) {
  const rawRules = buildFallbackRulesFromWorkflow(lease);
  const fallbackStatus = ["approved", "budget_ready", "active", "executed"].includes(
    normalizeText(lease?.abstract_status || lease?.status)
  )
    ? "approved"
    : "draft";
  const rules = finalizeLeaseExpenseRules(rawRules, fallbackStatus);
  if (rules.length === 0) return null;

  return {
    leaseId: lease.id,
    ruleSet: {
      id: `workflow-rule-set-${lease.id}`,
      lease_id: lease.id,
      property_id: lease.property_id || null,
      version: 0,
      status: fallbackStatus,
      source: "workflow_output",
      is_fallback: true,
    },
    rules,
  };
}

async function fetchLeasesForFallback(leaseIds = []) {
  if (!supabase || !Array.isArray(leaseIds) || leaseIds.length === 0) return [];
  const { data, error } = await supabase
    .from("leases")
    .select("*")
    .in("id", leaseIds);
  if (error) throw error;
  return data || [];
}

function findCategoryByKeywords(categories = [], keywords = []) {
  const normalizedKeywords = keywords.map(normalizeCategoryToken).filter(Boolean);
  return categories.find((category) => {
    const haystack = [
      category?.category_name,
      category?.subcategory_name,
      category?.normalized_key,
    ]
      .map(normalizeCategoryToken)
      .filter(Boolean)
      .join(" ");

    return normalizedKeywords.some((keyword) => haystack.includes(keyword) || keyword.includes(haystack));
  }) || null;
}

function extractSnippet(text, pattern) {
  const match = String(text || "").match(pattern);
  return match?.[0] ? match[0].trim() : null;
}

/**
 * Inspect a lease clause snippet and classify the treatment without needing
 * a dollar amount. The classifier returns explicit yes / no / conditional
 * for recoverable_from_tenant and cam_eligible, plus payment_treatment and
 * rule_type, whenever the language clearly states the obligation. If the
 * snippet is ambiguous, classification keys are left undefined so the
 * caller falls back to "needs_review". Order matters — explicit-exclusion
 * checks must run before tenant-pays checks so a clause like "CAM shall
 * not include Tenant's pro rata share of capital expenditures" lands as
 * EXCLUDED, not RECOVERABLE.
 */
function classifyClauseTreatment(snippet) {
  const text = String(snippet || "");
  if (!text) return { ambiguous: true };

  // 1. Explicit exclusion — but only when there is NO exception/condition
  // that would carve the category back into recovery. Clauses like "CAM
  // shall not include capital expenditures except those required by law"
  // contain BOTH exclusion language and an exception, and must be
  // classified as conditional, not hard excluded.
  const hasExclusionPhrase =
    /\b(?:cam|operating\s+expenses?|recovery)\s+(?:shall\s+)?(?:not\s+include|excludes?)\b/i.test(text)
    || /\bexcluded\s+from\s+(?:cam|operating\s+expenses?|recovery)\b/i.test(text)
    || /\bshall\s+not\s+be\s+(?:included|recoverable|charged|passed[-\s]through)\b/i.test(text)
    || /\bnot\s+recoverable\b/i.test(text);
  const hasExceptionCarveout =
    /\bexcept(?:\s+(?:those|for|where|when|as|if|to\s+the\s+extent))?\b/i.test(text)
    || /\bunless\b/i.test(text)
    || /\bother\s+than\b/i.test(text)
    || /\bsave\s+(?:for|where|as)\b/i.test(text)
    || /\bif\s+(?:required\s+by\s+law|approved\s+(?:in\s+writing\s+)?by|amortized)/i.test(text)
    || /\bto\s+the\s+extent\b/i.test(text);

  if (hasExclusionPhrase && !hasExceptionCarveout) {
    return {
      recoverableFromTenant: "no",
      camEligible: "no",
      paymentTreatment: "not_applicable",
      isExcluded: true,
      ruleType: "excluded",
    };
  }
  if (hasExclusionPhrase && hasExceptionCarveout) {
    // Exclusion with an exception carve-out → conditional recovery.
    // Reviewer must confirm the carve-out applies to the actual expense.
    return {
      recoverableFromTenant: "conditional",
      camEligible: "conditional",
      paymentTreatment: "reimbursable",
      isConditional: true,
      ruleType: "conditional_recovery",
      classifierNote: "Excluded with exception — see clause for the carve-out condition (e.g. required by law, amortized over useful life, written approval).",
    };
  }

  // 2. Included in base rent / full-service / gross lease.
  if (
    /\bincluded\s+in\s+(?:base\s+)?rent\b/i.test(text)
    || /\bfull[\s-]service\s+(?:lease|rent|basis)\b/i.test(text)
    || /\bgross\s+lease\b/i.test(text)
  ) {
    return {
      recoverableFromTenant: "no",
      camEligible: "no",
      paymentTreatment: "included_in_base_rent",
      includedInBaseRent: true,
    };
  }

  // 3. Tenant direct contract / sole cost / separately metered.
  if (
    /\btenant\s+shall\s+(?:contract\s+(?:directly|with)|pay\s+directly)\b/i.test(text)
    || /\b(?:at\s+)?(?:tenant'?s\s+)?sole\s+cost(?:\s+and\s+expense)?\b/i.test(text)
    || /\bseparately\s+metered\b/i.test(text)
    || /\btenant\s+shall\s+(?:obtain|procure|maintain)[^.\n]{0,40}(?:directly|in\s+tenant'?s\s+name)\b/i.test(text)
  ) {
    return {
      recoverableFromTenant: "no",
      camEligible: "no",
      paymentTreatment: "tenant_direct_contract",
    };
  }

  // 4. Conditional treatment — clauses that allow recovery only under
  // specific conditions (legal requirement, written approval, cap, base
  // year, expense stop, etc.). These should NOT auto-promote to yes.
  const conditionalSignals = [
    /\bmay\s+be\s+included\s+only\s+if\b/i,
    /\bif\s+required\s+by\s+(?:law|legal\s+requirement)\b/i,
    /\bif\s+approved\s+(?:in\s+writing\s+)?by\b/i,
    /\bsubject\s+to\s+landlord'?s?\s+(?:prior\s+)?(?:written\s+)?(?:consent|approval)\b/i,
    /\b(?:not\s+to\s+exceed|capped\s+at|cap\s+of|subject\s+to\s+a?\s*cap)\b/i,
    /\b(?:base\s+year|expense\s+stop)\b/i,
    /\bamortized\s+over\s+(?:its|their)?\s*useful\s+life\b/i,
  ];
  if (conditionalSignals.some((rx) => rx.test(text))) {
    return {
      recoverableFromTenant: "conditional",
      camEligible: "conditional",
      paymentTreatment: "reimbursable",
      isConditional: true,
    };
  }

  // 5. Tenant pays / reimburses / pro rata share → recoverable yes.
  if (
    /\btenant\s+shall\s+(?:reimburse|pay)\s+(?:landlord\s+)?(?:for\s+)?(?:its\s+|tenant'?s\s+)?(?:pro[\s-]*rata\s+share|share\s+of|proportionate\s+share)\b/i.test(text)
    || /\btenant'?s\s+pro[\s-]*rata\s+share\b/i.test(text)
    || /\btenant\s+shall\s+pay\s+(?:as\s+)?additional\s+rent\b/i.test(text)
    || /\brecoverable\s+(?:from\s+tenant|as\s+additional\s+rent)\b/i.test(text)
    || /\bpass[-\s]through\b/i.test(text)
    || /\btenant\s+shall\s+reimburse\s+landlord\b/i.test(text)
  ) {
    return {
      recoverableFromTenant: "yes",
      camEligible: "yes",
      paymentTreatment: "reimbursable",
    };
  }

  // 6. Landlord-pays language with no tenant-reimbursement → not recoverable.
  if (
    /\blandlord\s+shall\s+(?:pay|be\s+responsible\s+for|provide|maintain|carry)\b/i.test(text)
    && !/\btenant\s+shall\s+(?:reimburse|pay)\b/i.test(text)
  ) {
    return {
      recoverableFromTenant: "no",
      camEligible: "no",
      paymentTreatment: "not_applicable",
    };
  }

  // 7. Ambiguous — caller should fall back to needs_review.
  return { ambiguous: true };
}

function buildDeterministicDraftRules({ lease, categories = [], sourceText = "", existingRules = [] }) {
  const draftRules = [];
  const existingByCategoryId = new Map(
    (existingRules || [])
      .filter((rule) => rule?.expense_category_id)
      .map((rule) => [rule.expense_category_id, rule]),
  );
  const workflowOutput = getLeaseWorkflowOutput(lease);
  const workflowRules = asArray(workflowOutput?.expense_rules);

  for (const workflowRule of workflowRules) {
    const category = findCategoryByKeywords(categories, [
      workflowRule?.expense_category,
      workflowRule?.expense_subcategory,
      String(workflowRule?.expense_category || "").replace(/_/g, " "),
    ].filter(Boolean));
    if (!category?.id) continue;

    const existing = existingByCategoryId.get(category.id) || {};
    const explicitValue = asNumber(workflowRule?.explicit_charge_amount);
    const recoveryClass = String(workflowRule?.rule_classification || "").trim().toLowerCase();
    const rowStatus =
      workflowRule?.status === "manual_required"
        ? "needs_review"
        : explicitValue != null || ["recoverable", "non_recoverable", "conditional", "excluded"].includes(recoveryClass)
          ? "mapped"
          : "needs_review";

    draftRules.push({
      ...existing,
      expense_category_id: category.id,
      category_name: category.category_name,
      subcategory_name: category.subcategory_name || null,
      row_status: rowStatus,
      mentioned_in_lease: true,
      is_recoverable: workflowRule?.recoverable_flag === true,
      is_excluded: recoveryClass === "excluded",
      is_controllable: true,
      is_subject_to_cap: false,
      has_base_year: false,
      gross_up_applicable: false,
      admin_fee_applicable: false,
      extracted_value: explicitValue,
      final_value: explicitValue,
      frequency: normalizeFrequency(workflowRule?.billing_frequency),
      confidence: asNumber(workflowRule?.confidence_score) ?? 0.74,
      notes: workflowRule?.notes || null,
      source: workflowRule?.source_clause || workflowRule?.lease_treatment || null,
      clauses: workflowRule?.source_clause
        ? [{
            clause_type: "supporting_text",
            clause_text: workflowRule.source_clause,
            page_number: workflowRule?.source_page ?? null,
            confidence: asNumber(workflowRule?.confidence_score) ?? 0.74,
          }]
        : [],
    });
  }

  const candidates = [
    {
      field: "cam_amount",
      keywords: ["cam", "common area maintenance"],
      notes: "Derived from extracted CAM amount",
    },
    {
      field: "nnn_amount",
      keywords: ["nnn", "triple net", "operating expenses"],
      notes: "Derived from extracted NNN amount",
    },
    {
      field: "insurance_reimbursement_amount",
      keywords: ["insurance"],
      notes: "Derived from extracted insurance reimbursement amount",
    },
    {
      field: "tax_reimbursement_amount",
      keywords: ["tax", "real estate tax"],
      notes: "Derived from extracted tax reimbursement amount",
    },
    {
      field: "utility_reimbursement_amount",
      keywords: ["utility", "utilities"],
      notes: "Derived from extracted utility reimbursement amount",
    },
    {
      field: "water_sewer_reimbursement_amount",
      keywords: ["water", "sewer", "utilities"],
      notes: "Derived from extracted water/sewer reimbursement amount",
    },
  ];
  const extractedUtilityAmount = asNumber(getLeaseExtractedValue(lease, "utility_reimbursement_amount"));
  const extractedWaterSewerAmount = asNumber(getLeaseExtractedValue(lease, "water_sewer_reimbursement_amount"));

  for (const candidate of candidates) {
    if (
      candidate.field === "utility_reimbursement_amount" &&
      extractedUtilityAmount != null &&
      extractedUtilityAmount > 0 &&
      extractedUtilityAmount === extractedWaterSewerAmount
    ) {
      continue;
    }

    const category = findCategoryByKeywords(categories, candidate.keywords);
    if (!category?.id) continue;

    const extractedValue = asNumber(getLeaseExtractedValue(lease, candidate.field));
    // Try to find a clause snippet for this category, with OR without an
    // amount. A rule is valid when EITHER (a) clause text supports the
    // category, OR (b) a lease abstract extracted_value is present. Amount
    // is NOT required. The loop only skips when neither signal exists.
    const snippetWithAmount = extractSnippet(
      sourceText,
      new RegExp(`${candidate.keywords.join("|")}[\\s\\S]{0,120}?\\$[\\d,]+(?:\\.\\d{2})?`, "i"),
    );
    const snippetClauseOnly = snippetWithAmount || extractSnippet(
      sourceText,
      new RegExp(`(?:^|[.\\n])\\s*([^.\\n]{0,40}(?:${candidate.keywords.join("|")})[^.\\n]{0,180})`, "i"),
    );
    const snippet = snippetWithAmount || snippetClauseOnly;
    const hasClauseEvidence = Boolean(snippet);
    const hasAmount = extractedValue != null && extractedValue > 0;
    if (!hasClauseEvidence && !hasAmount) continue;

    const existing = existingByCategoryId.get(category.id) || {};
    const isStrongMatch = hasClauseEvidence && hasAmount;

    // Classify the clause itself when we have one. If the snippet clearly
    // states the treatment (tenant reimburses / included in rent / tenant
    // direct / excluded / conditional), use it. Only fall back to
    // "needs_review" when the clause is genuinely ambiguous. Missing
    // amount alone does NOT force needs_review.
    const clauseClassification = hasClauseEvidence
      ? classifyClauseTreatment(snippet)
      : { ambiguous: true };
    const ambiguous = Boolean(clauseClassification.ambiguous);
    // Strong-match (clause + amount, no ambiguous-treatment override) keeps
    // the historical "auto-yes" behavior. Clause-only with a clear
    // classification follows the classifier's verdict. Truly ambiguous
    // clauses and amount-only-gap rows land as needs_review.
    const useClassifier = hasClauseEvidence && !ambiguous;
    const recoverableFromTenant = useClassifier
      ? clauseClassification.recoverableFromTenant
      : isStrongMatch
        ? "yes"
        : "needs_review";
    const camEligible = useClassifier
      ? clauseClassification.camEligible
      : isStrongMatch
        ? undefined /* derived downstream from recoverable */
        : "needs_review";
    const paymentTreatment = useClassifier ? clauseClassification.paymentTreatment : undefined;
    const isExcluded = Boolean(clauseClassification.isExcluded);
    const includedInBaseRent = Boolean(clauseClassification.includedInBaseRent);
    const isConditional = Boolean(clauseClassification.isConditional);

    // A clause that locks the rule into a definitive treatment (exclusion,
    // included-in-rent, tenant-direct) is "resolved" enough to leave
    // review_status / approval_status alone (downstream derives). A clause
    // that needs human confirmation (ambiguous, or amount-only gap) is
    // explicitly marked needs_review / draft.
    const needsHumanReview = ambiguous || !hasClauseEvidence;

    draftRules.push({
      ...existing,
      expense_category_id: category.id,
      category_name: category.category_name,
      subcategory_name: category.subcategory_name || null,
      row_status: hasClauseEvidence ? "mapped" : "needs_review",
      mentioned_in_lease: hasClauseEvidence,
      is_recoverable: useClassifier ? recoverableFromTenant === "yes" || recoverableFromTenant === "conditional" : isStrongMatch,
      recoverable_from_tenant: recoverableFromTenant,
      ...(camEligible !== undefined ? { cam_eligible: camEligible } : {}),
      ...(paymentTreatment !== undefined ? { payment_treatment: paymentTreatment } : {}),
      ...(includedInBaseRent ? { included_in_base_rent: true } : {}),
      is_excluded: isExcluded,
      is_controllable: true,
      is_subject_to_cap: isConditional && /\b(?:cap|not\s+to\s+exceed)/i.test(snippet || ""),
      has_base_year: isConditional && /\bbase\s+year\b/i.test(snippet || ""),
      gross_up_applicable: false,
      admin_fee_applicable: false,
      // Amount is OPTIONAL — preserve null when the lease doesn't include
      // an explicit dollar figure. Downstream must not treat null as 0.
      extracted_value: hasAmount ? extractedValue : null,
      final_value: hasAmount ? extractedValue : null,
      frequency: /monthly|per month/i.test(snippet || sourceText) ? "monthly" : "yearly",
      // Clear-clause classification gets higher confidence than ambiguous.
      confidence: isStrongMatch ? 0.78 : useClassifier ? 0.72 : hasClauseEvidence ? 0.55 : 0.50,
      notes: clauseClassification.classifierNote
        ? `${candidate.notes} — ${clauseClassification.classifierNote}`
        : candidate.notes,
      source: snippet || null,
      exact_source_text: snippet || null,
      generation_source: isStrongMatch
        ? "deterministic_amount"
        : useClassifier
          ? "clause_classified"
          : hasClauseEvidence
            ? "clause_evidence_ambiguous"
            : "amount_only_gap",
      ...(needsHumanReview ? { review_status: "needs_review", approval_status: "draft" } : {}),
      published_to_cam: false,
    });
  }

  const utilitiesCategory = findCategoryByKeywords(categories, ["utility", "utilities", "electric", "water", "sewer"]);
  const electricResponsibility = String(getLeaseExtractedValue(lease, "electric_responsibility") || "");
  if (utilitiesCategory?.id && electricResponsibility && /tenant/i.test(electricResponsibility)) {
    const existing = existingByCategoryId.get(utilitiesCategory.id) || {};
    draftRules.push({
      ...existing,
      expense_category_id: utilitiesCategory.id,
      category_name: utilitiesCategory.category_name,
      subcategory_name: utilitiesCategory.subcategory_name || null,
      row_status: "mapped",
      mentioned_in_lease: true,
      is_recoverable: false,
      is_excluded: true,
      is_controllable: true,
      is_subject_to_cap: false,
      has_base_year: false,
      gross_up_applicable: false,
      admin_fee_applicable: false,
      extracted_value: null,
      final_value: null,
      frequency: "yearly",
      confidence: 0.72,
      notes: "Tenant pays electric directly per lease clause.",
      source: electricResponsibility,
    });
  }

  const deduped = new Map();
  for (const rule of draftRules) {
    if (!rule?.expense_category_id) continue;
    const existing = deduped.get(rule.expense_category_id);
    if (!existing) {
      deduped.set(rule.expense_category_id, rule);
      continue;
    }

    const existingScore = (asNumber(existing.final_value) != null ? 2 : 0) + (existing.is_recoverable ? 1 : 0);
    const nextScore = (asNumber(rule.final_value) != null ? 2 : 0) + (rule.is_recoverable ? 1 : 0);
    if (nextScore >= existingScore) {
      deduped.set(rule.expense_category_id, rule);
    }
  }

  return [...deduped.values()];
}

export const leaseExpenseRuleService = {
  async getLeaseSourceText(leaseId, sourceFileId = null) {
    if (!supabase || !leaseId) return "";

    let uploadedFile = null;

    if (sourceFileId) {
      const { data } = await supabase
        .from("uploaded_files")
        .select("normalized_output, parsed_data, docling_raw")
        .eq("id", sourceFileId)
        .maybeSingle();
      uploadedFile = data || null;
    }

    if (!uploadedFile) {
      const { data } = await supabase
        .from("document_links")
        .select("uploaded_files(normalized_output, parsed_data, docling_raw)")
        .eq("entity_id", leaseId)
        .eq("entity_type", "lease")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      uploadedFile = data?.uploaded_files || null;
    }

    // Docling writes the OCR'd document body to `docling_raw.full_text`.
    // Earlier this function only checked `text` and `markdown` keys, which
    // are written by some pipelines but NOT by the Docling pipeline this
    // project uses — so getLeaseSourceText returned empty for every lease
    // and the fallback extractor silently failed. We now check every known
    // key so the extractor always finds the text when it exists.
    const candidates = [
      uploadedFile?.normalized_output?.raw_text,
      uploadedFile?.normalized_output?.text,
      uploadedFile?.parsed_data?.raw_text,
      uploadedFile?.parsed_data?.text,
      uploadedFile?.parsed_data?.full_text,
      uploadedFile?.docling_raw?.full_text,
      uploadedFile?.docling_raw?.markdown,
      uploadedFile?.docling_raw?.text,
      uploadedFile?.docling_raw?.body,
    ];
    for (const candidate of candidates) {
      const trimmed = String(candidate || "").trim();
      if (trimmed) return trimmed;
    }
    return "";
  },

  async loadRuleSet(leaseId) {
    if (!supabase || !leaseId) return { ruleSet: null, rules: [] };

    try {
      const { data: ruleSets, error } = await supabase
        .from("lease_expense_rule_sets")
        .select("*")
        .eq("lease_id", leaseId)
        .not("status", "eq", "archived")
        .order("version", { ascending: false });

      if (error) throw error;

      const setIds = (ruleSets || []).map((ruleSet) => ruleSet.id).filter(Boolean);
      const { data: ruleRows, error: ruleRowsError } = setIds.length > 0
        ? await supabase
          .from("lease_expense_rules")
          .select("*")
          .in("rule_set_id", setIds)
        : { data: [], error: null };
      if (ruleRowsError) throw ruleRowsError;

      const rulesBySet = new Map();
      for (const rule of ruleRows || []) {
        const existing = rulesBySet.get(rule.rule_set_id) || [];
        existing.push(rule);
        rulesBySet.set(rule.rule_set_id, existing);
      }

      const ruleSet = selectPreferredRuleSet(ruleSets || [], rulesBySet);
      if (!ruleSet) {
        return { ruleSet: null, rules: [] };
      }

      const { rules, valuesByRuleId, clausesByRuleId } = await loadRuleDependencies(ruleSet.id);
      const mergedRules = mergeRulesWithRelations(rules, valuesByRuleId, clausesByRuleId);
      const finalizedRules = finalizeLeaseExpenseRules(mergedRules, ruleSet?.status || "draft");

      return { ruleSet, rules: finalizedRules };
    } catch (error) {
      if (!isMissingExpenseRuleTable(error)) throw error;
      return { ruleSet: null, rules: [] };
    }
  },

  async loadRuleSets(leaseIds = []) {
    const tag = `[loadRuleSets leaseIds=${leaseIds?.length || 0}]`;
    if (!supabase || !Array.isArray(leaseIds) || leaseIds.length === 0) {
      devLog(`${tag} early return — no leaseIds`);
      return [];
    }

    try {
      const { data: ruleSets, error } = await supabase
        .from("lease_expense_rule_sets")
        .select("*")
        .in("lease_id", leaseIds)
        .not("status", "eq", "archived")
        .order("version", { ascending: false });

      if (error) {
        console.error(`${tag} rule_sets query failed:`, error);
        throw error;
      }
      devLog(`${tag} rule_sets read: ${ruleSets?.length || 0}`, ruleSets?.map((s) => ({ id: s.id?.slice(0, 8), lease: s.lease_id?.slice(0, 8), v: s.version, status: s.status })));

      const ruleSetsByLeaseId = new Map();
      for (const ruleSet of ruleSets || []) {
        const existing = ruleSetsByLeaseId.get(ruleSet.lease_id) || [];
        existing.push(ruleSet);
        ruleSetsByLeaseId.set(ruleSet.lease_id, existing);
      }

      const allRuleSetIds = (ruleSets || []).map((ruleSet) => ruleSet.id).filter(Boolean);
      if (allRuleSetIds.length === 0) {
        return [];
      }

      const { data: allRules, error: rulesError } = await supabase
        .from("lease_expense_rules")
        .select("*")
        .in("rule_set_id", allRuleSetIds);

      if (rulesError) {
        console.error(`${tag} rules query failed:`, rulesError);
        throw rulesError;
      }
      devLog(`${tag} rules read: ${allRules?.length || 0} for ${allRuleSetIds.length} rule_set(s)`);

      const rulesBySet = new Map();
      for (const rule of allRules || []) {
        const existing = rulesBySet.get(rule.rule_set_id) || [];
        existing.push(rule);
        rulesBySet.set(rule.rule_set_id, existing);
      }

      const latestRuleSets = [...ruleSetsByLeaseId.values()]
        .map((leaseRuleSets) => selectPreferredRuleSet(leaseRuleSets, rulesBySet))
        .filter(Boolean);
      const ruleSetIds = latestRuleSets.map((ruleSet) => ruleSet.id);
      if (ruleSetIds.length === 0) {
        return [];
      }

      const selectedRuleSetIdLookup = new Set(ruleSetIds);
      const rules = (allRules || []).filter((rule) => selectedRuleSetIdLookup.has(rule.rule_set_id));

      const ruleIds = (rules || []).map((rule) => rule.id).filter(Boolean);
      const [{ data: values, error: valuesError }, { data: clauses, error: clausesError }] = await Promise.all([
        ruleIds.length > 0
          ? supabase.from("lease_expense_values").select("*").in("rule_id", ruleIds)
          : Promise.resolve({ data: [], error: null }),
        ruleIds.length > 0
          ? supabase.from("lease_expense_rule_clauses").select("*").in("lease_expense_rule_id", ruleIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (valuesError) throw valuesError;
      if (clausesError) throw clausesError;

      const valuesByRuleId = new Map((values || []).map((value) => [value.rule_id, value]));
      const clausesByRuleId = new Map();
      (clauses || []).forEach((clause) => {
        const existing = clausesByRuleId.get(clause.lease_expense_rule_id) || [];
        existing.push(clause);
        clausesByRuleId.set(clause.lease_expense_rule_id, existing);
      });

      const persistedEntries = latestRuleSets.map((ruleSet) => {
        const rulesForSet = (rules || []).filter((rule) => rule.rule_set_id === ruleSet.id);
        const mergedRules = mergeRulesWithRelations(rulesForSet, valuesByRuleId, clausesByRuleId);
        const finalizedRules = finalizeLeaseExpenseRules(mergedRules, ruleSet.status || "draft");
        devLog(`${tag} lease ${ruleSet.lease_id?.slice(0, 8)} → ${rulesForSet.length} raw → ${finalizedRules.length} finalized (after dedup/exclude)`);
        return {
          leaseId: ruleSet.lease_id,
          ruleSet,
          rules: finalizedRules,
        };
      });
      devLog(`${tag} returning ${persistedEntries.length} entries`);

      return persistedEntries;
    } catch (error) {
      console.error(`${tag} FAILED`, error);
      return [];
    }
  },

  async recalculateRuleSetStatus(ruleSetId) {
    if (!supabase || !ruleSetId) return null;

    const { data: rules, error: rulesError } = await supabase
      .from("lease_expense_rules")
      .select("*")
      .eq("rule_set_id", ruleSetId);
    if (rulesError) throw rulesError;

    const nextStatus = deriveRuleSetStatusFromRules(rules || []);
    const patch = {
      status: nextStatus,
      approved_at: nextStatus === "approved" ? new Date().toISOString() : null,
    };

    const { data, error } = await supabase
      .from("lease_expense_rule_sets")
      .update(patch)
      .eq("id", ruleSetId)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  },

  // Diagnostic: dump the full state of the lease expense-rule pipeline for
  // a single lease. Used by the backfill UI before each persist attempt so
  // we can see EXACTLY where rules come from (or fail to come from). Pure
  // read-only — does not write anything.
  async diagnoseExpenseRulePipeline(lease) {
    if (!lease?.id) return { error: "no_lease_id" };
    const extraction = lease.extraction_data || {};
    const workflow = extraction.workflow_output || null;
    const wfRecord = Array.isArray(workflow?.records) ? workflow.records[0] : workflow;
    const expenseRules = asArray(wfRecord?.expense_rules);
    const camProfile = wfRecord?.cam_profile || null;
    const clauses = asArray(wfRecord?.lease_clauses);
    const sourceFileId = extraction.source_file_id || null;

    let sourceTextLength = 0;
    let sourceTextField = null;
    let uploadedFile = null;
    if (sourceFileId) {
      try {
        const { data } = await supabase
          .from("uploaded_files")
          .select("id, normalized_output, parsed_data, docling_raw, ui_review_payload, status")
          .eq("id", sourceFileId)
          .maybeSingle();
        uploadedFile = data || null;
        if (uploadedFile) {
          const candidates = [
            ["normalized_output.raw_text", uploadedFile?.normalized_output?.raw_text],
            ["normalized_output.text", uploadedFile?.normalized_output?.text],
            ["parsed_data.raw_text", uploadedFile?.parsed_data?.raw_text],
            ["parsed_data.text", uploadedFile?.parsed_data?.text],
            ["parsed_data.full_text", uploadedFile?.parsed_data?.full_text],
            ["docling_raw.full_text", uploadedFile?.docling_raw?.full_text],
            ["docling_raw.markdown", uploadedFile?.docling_raw?.markdown],
            ["docling_raw.text", uploadedFile?.docling_raw?.text],
            ["docling_raw.body", uploadedFile?.docling_raw?.body],
          ];
          for (const [field, value] of candidates) {
            const trimmed = String(value || "").trim();
            if (trimmed) {
              sourceTextLength = trimmed.length;
              sourceTextField = field;
              break;
            }
          }
        }
      } catch (err) {
        devWarn("[diagnose] uploaded_files lookup failed:", err?.message || err);
      }
    }

    // Existing persisted rules for this lease
    let existingRuleSets = [];
    let existingRules = [];
    try {
      const sets = await supabase
        .from("lease_expense_rule_sets")
        .select("id, status, version, created_at")
        .eq("lease_id", lease.id)
        .order("version", { ascending: false });
      existingRuleSets = sets.data || [];
      if (existingRuleSets.length > 0) {
        const setIds = existingRuleSets.map((s) => s.id);
        const rules = await supabase
          .from("lease_expense_rules")
          .select("id, rule_set_id, expense_category, review_status")
          .in("rule_set_id", setIds);
        existingRules = rules.data || [];
      }
    } catch (err) {
      devWarn("[diagnose] rule lookup failed:", err?.message || err);
    }

    return {
      lease_id: lease.id,
      tenant_name: lease.tenant_name,
      approved_lease_abstract_id: lease.approved_lease_abstract_id || lease.abstract_snapshot?.id || null,
      org_id: lease.org_id,
      property_id: lease.property_id,
      building_id: lease.building_id,
      unit_id: lease.unit_id,
      tenant_id: lease.tenant_id,
      abstract_status: lease.abstract_status,
      // Workflow payload state
      has_workflow_output: !!workflow,
      workflow_record_count: Array.isArray(workflow?.records) ? workflow.records.length : (workflow ? 1 : 0),
      expense_rules_count: expenseRules.length,
      expense_rule_categories: expenseRules.map((r) => r?.expense_category).filter(Boolean),
      cam_profile_present: !!camProfile,
      clause_records_count: clauses.length,
      // Source text state
      source_file_id: sourceFileId,
      source_file_found: !!uploadedFile,
      source_file_status: uploadedFile?.status || null,
      source_text_length: sourceTextLength,
      source_text_field: sourceTextField,
      // Persisted state
      existing_rule_sets_count: existingRuleSets.length,
      existing_rule_sets: existingRuleSets,
      existing_rules_count: existingRules.length,
    };
  },

  // Fast path used during Lease Approval. Reads the expense_rules array
  // the workflow extractor already produced (lives on
  // `lease.extraction_data.workflow_output.expense_rules`) and persists it
  // to `lease_expense_rule_sets` + `lease_expense_rules` without re-running
  // the LLM. Idempotent: if an existing rule set is provided, the rules are
  // upserted onto it; otherwise a new versioned set is created.
  //
  // Filters out anything that maps to base rent — base rent is a rent
  // schedule concept, not a lease expense rule (per product spec).
  // Returns whatever saveRuleSet returns ({ ruleSet, rules }).
  async persistExpenseRulesFromWorkflow({
    lease,
    categories = [],
    status = "draft",
    existingRuleSetId = null,
    createdFrom = "workflow",
    approver = null,
  } = {}) {
    const tag = `[persistExpenseRulesFromWorkflow lease=${lease?.id}]`;
    if (!supabase || !lease?.id) {
      devWarn(`${tag} skipped: no supabase or no lease.id`);
      return { ruleSet: null, rules: [] };
    }
    const workflowRules = getLeaseWorkflowExpenseRules(lease);
    devLog(`${tag} workflow_rules received: ${workflowRules.length}`);
    if (workflowRules.length === 0) {
      const wfOut = lease?.extraction_data?.workflow_output;
      devWarn(`${tag} no workflow expense_rules. extraction_data keys=`, Object.keys(lease?.extraction_data || {}), "workflow_output keys=", wfOut ? Object.keys(wfOut) : null);
      return { ruleSet: null, rules: [] };
    }

    // Strip base_rent / base rent / rent rules. saveRuleSet's resolver will
    // also drop unmappable rules but skipping here keeps the audit log clean.
    const BASE_RENT_KEYS = new Set(["base_rent", "rent", "minimum_rent", "fixed_rent"]);
    const filtered = workflowRules.filter((r) => {
      const key = String(r?.expense_category || r?.normalized_key || "").toLowerCase();
      return !BASE_RENT_KEYS.has(key);
    });
    devLog(`${tag} after base-rent strip: ${filtered.length} rules; categories=`, filtered.map((r) => r?.expense_category));

    // Reshape workflow rule → the shape saveRuleSet expects. Most fields
    // are passed through; we just bridge a few aliases the persister reads.
    const rules = filtered.map((r) => ({
      ...r,
      normalized_key: r.expense_category || r.normalized_key,
      category_name: r.category_name || r.expense_subcategory || null,
      confidence: r.confidence_score ?? r.confidence ?? null,
      source: r.exact_source_text || r.source_clause || r.notes || null,
      frequency: r.billing_frequency || null,
      mentioned_in_lease: r.extraction_status !== "not_found",
    }));

    // Idempotency: reuse the most-recent non-archived rule_set for this
    // lease as the target so we don't pile up phantom versions per click.
    //
    // Rule:
    //   - If latest rule_set is APPROVED and extraction_version matches,
    //     reuse it. The upsert by (rule_set_id, rule_key) guarantees
    //     approved rules with user-reviewed fields are NOT overwritten
    //     because they share the same rule_key and the persistence layer
    //     keeps the existing approved review_status/approval_status.
    //   - If latest is APPROVED and extraction_version is different, leave
    //     it frozen and create a NEW draft set for the new extraction.
    //   - If latest is DRAFT, reuse it regardless of version.
    let targetRuleSetId = existingRuleSetId;
    const EXTRACTION_VERSION_FOR_LOOKUP = "v1.2026.05.19";
    if (!targetRuleSetId) {
      try {
        const { data: existingSets } = await supabase
          .from("lease_expense_rule_sets")
          .select("id, status, version, extraction_version")
          .eq("lease_id", lease.id)
          .not("status", "eq", "archived")
          .order("version", { ascending: false })
          .limit(1);
        const latest = existingSets?.[0];
        if (latest?.id) {
          const sameExtractionVersion =
            !latest.extraction_version || latest.extraction_version === EXTRACTION_VERSION_FOR_LOOKUP;
          if (latest.status !== "approved" || sameExtractionVersion) {
            targetRuleSetId = latest.id;
            devLog(
              `${tag} reusing existing rule_set ${latest.id} (v${latest.version}, status=${latest.status}, ev=${latest.extraction_version || "—"})`,
            );
          } else {
            devLog(
              `${tag} latest rule_set is approved with different extraction_version (${latest.extraction_version}) — creating a new draft for ${EXTRACTION_VERSION_FOR_LOOKUP}`,
            );
          }
        }
      } catch (err) {
        devWarn(`${tag} existing rule_set lookup failed:`, err?.message || err);
      }
    }

    let result = { ruleSet: null, rules: [] };
    try {
      result = await this.saveRuleSet({
        lease,
        rules,
        status,
        existingRuleSetId: targetRuleSetId,
        categories,
        createdFrom,
        approver,
      });
      devLog(`${tag} saveRuleSet returned ${result?.rules?.length || 0} persisted rules; ruleSet=`, result?.ruleSet?.id);
    } catch (err) {
      console.error(`${tag} saveRuleSet THREW:`, err?.message || err, err?.details || "", err?.code || "");
      throw err;
    }
    return result;
  },

  // Keyword-based extractor that scans raw lease text for the canonical
  // expense category vocabulary and emits a draft rule per category found.
  // Per spec: rules are created even when no dollar amount exists. Used as
  // a last-resort fallback when workflow_output is empty AND extractDraftRuleSet
  // (LLM + deterministic) returned nothing.
  buildTextFallbackRules(sourceText) {
    const text = String(sourceText || "");
    if (!text) return [];

    const SECTIONS = [
      { name: "Recoverable Expenses", regex: /(?:recoverable\s+expenses?|common\s+area\s+maintenance|operating\s+expenses?)(?:[\s\S]{0,1000})/i },
      { name: "Excluded Expenses", regex: /(?:excluded\s+expenses?|exclusions\s+from\s+operating\s+expenses?|exclusions\s+from\s+cam)(?:[\s\S]{0,1000})/i },
      { name: "Capital Expenditures", regex: /(?:capital\s+expenditures?|capital\s+improvements?|amorti[zs]ation)(?:[\s\S]{0,1000})/i },
      { name: "Gross-Up", regex: /(?:gross[-\s]?up)(?:[\s\S]{0,1000})/i },
      { name: "Controllable Expense Cap", regex: /(?:controllable\s+expense\s+cap|expense\s+cap)(?:[\s\S]{0,1000})/i },
      { name: "Estimated Additional Rent", regex: /(?:estimated\s+(?:annual\s+)?additional\s+rent|estimated\s+cam)(?:[\s\S]{0,1000})/i },
      { name: "Utilities and After-Hours HVAC", regex: /(?:utilities|after[-\s]?hours\s+hvac)(?:[\s\S]{0,1000})/i },
      { name: "Insurance Requirements", regex: /(?:insurance\s+requirements?|tenant\s+insurance)(?:[\s\S]{0,1000})/i },
      { name: "Default, Late Charges, and Interest", regex: /(?:default|late\s+charges?|late\s+fees?|interest)(?:[\s\S]{0,1000})/i },
      { name: "Holdover", regex: /(?:holdover|holding\s+over)(?:[\s\S]{0,1000})/i },
      { name: "Parking", regex: /(?:parking)(?:[\s\S]{0,1000})/i },
      { name: "Tenant Improvements", regex: /(?:tenant\s+improvements?|ti\s+allowance)(?:[\s\S]{0,1000})/i }
    ];

    const rules = [];
    const lines = text.split(/\r?\n/);
    
    // We will do a line-by-line scan. If we are in a section, we look for bullet items.
    let currentSection = null;
    let sectionTextAccumulator = "";

    const flushBullet = (bulletText, sectionName) => {
       const snippet = bulletText.trim().slice(0, 1000);
       if (snippet.length < 15) return;
       
       let key = sectionName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
       
       rules.push({
         expense_category: key,
         normalized_key: key,
         category_name: sectionName,
         responsibility: /tenant/i.test(snippet) ? "tenant" : "unknown",
         recoverable_from_tenant: sectionName === "Excluded Expenses" ? "no" : "needs_review",
         cam_eligible: sectionName === "Excluded Expenses" ? "no" : "needs_review",
         included_in_base_rent: false,
         recovery_method: "manual_review",
         exact_source_text: snippet,
         source_clause: snippet,
         confidence_score: 0.65,
         extraction_status: "inferred",
         status: "needs_review",
         review_status: "needs_review",
         approval_status: "draft",
         published_to_cam: false,
         generation_source: "text_fallback_section",
         mentioned_in_lease: true,
         notes: `Extracted from ${sectionName} bullet item.`,
       });
    };

    for (let i = 0; i < lines.length; i++) {
       const line = lines[i].trim();
       if (!line) continue;
       
       // Check if line looks like a section header from our list
       let foundNewSection = false;
       for (const sec of SECTIONS) {
          if (sec.regex.test(line) && line.length < 100) {
             currentSection = sec.name;
             foundNewSection = true;
             break;
          }
       }
       
       if (currentSection) {
          // Check if line is a bullet
          if (/^(?:[\u2022\-\*]|\([a-z0-9]+\)|\d+\.)\s+(.+)/i.test(line)) {
             flushBullet(line, currentSection);
          } else {
             // Not a bullet, could just be a paragraph in the section
             if (!foundNewSection && line.length > 50) {
                flushBullet(line, currentSection);
             }
          }
       }
    }
    
    return rules;
  },

  // Robust persistence path for both the approval flow and the backfill
  // button. Three-phase fallback:
  //   Phase 1 — workflow_output.expense_rules (fast, no IO)
  //   Phase 2 — extractDraftRuleSet (LLM + deterministic builder)
  //   Phase 3 — buildTextFallbackRules (keyword scan over source text)
  // First phase that yields rules wins. Per spec: rules are created even
  // when there are no dollar amounts.
  async ensureLeaseExpenseRules({
    lease,
    categories = [],
    status = "draft",
    createdFrom = "approval",
    approver = null,
  } = {}) {
    throw new Error("LEGACY ensureLeaseExpenseRules called after new pipeline");
    const tag = `[ensureLeaseExpenseRules lease=${lease?.id}]`;
    if (!lease?.id) return { ruleSet: null, rules: [] };

    // Phase 1: cheap workflow-output read.
    let result = { ruleSet: null, rules: [] };
    try {
      result = await this.persistExpenseRulesFromWorkflow({
        lease,
        categories,
        status,
        createdFrom,
        approver,
      });
    } catch (err) {
      devWarn(`${tag} workflow path failed:`, err?.message || err);
    }
    if (result?.rules?.length > 0) {
      devLog(`${tag} ✓ Phase 1 (workflow) produced ${result.rules.length} rules`);
      return result;
    }

    // Phase 2: workflow gave us nothing. Run the full extractor pipeline
    // (LLM call + deterministic fallback).
    devLog(`${tag} Phase 1 produced 0 rules → trying Phase 2 (extractDraftRuleSet)`);
    try {
      const fallback = await this.extractDraftRuleSet({
        lease,
        categories,
        existingRuleSetId: result?.ruleSet?.id || null,
        existingRules: [],
      });
      if (fallback?.rules?.length > 0) {
        devLog(`${tag} ✓ Phase 2 (LLM/deterministic) produced ${fallback.rules.length} rules`);
        return fallback;
      }
      result = fallback || result;
    } catch (err) {
      devWarn(`${tag} Phase 2 failed:`, err?.message || err);
    }

    // Phase 3: keyword scan on raw text. Last-resort — guarantees rules
    // exist for any lease that mentions any of the canonical category
    // vocabulary, even when nothing else worked.
    devLog(`${tag} Phase 2 produced 0 rules → trying Phase 3 (text fallback)`);
    try {
      const sourceText = await this.getLeaseSourceText(
        lease.id,
        lease?.extraction_data?.source_file_id || null,
      );
      if (!sourceText) {
        devWarn(`${tag} Phase 3 skipped — no source text available`);
        return result;
      }
      const textRules = this.buildTextFallbackRules(sourceText);
      devLog(`${tag} Phase 3 keyword scan found ${textRules.length} category matches`);
      if (textRules.length === 0) return result;
      const saved = await this.saveRuleSet({
        lease,
        rules: textRules,
        status,
        existingRuleSetId: result?.ruleSet?.id || null,
        categories,
        createdFrom: "text_fallback",
        approver,
      });
      devLog(`${tag} ✓ Phase 3 persisted ${saved?.rules?.length || 0} rules`);
      return saved;
    } catch (err) {
      devWarn("[leaseExpenseRuleService] ensureLeaseExpenseRules: fallback extract failed:", err?.message || err);
      return result;
    }
  },

  async extractDraftRuleSet({ lease, categories = [], existingRuleSetId = null, existingRules = [] }) {
    if (!supabase || !lease?.id) throw new Error("Lease is required to extract expense rules");

    const sourceText = await this.getLeaseSourceText(
      lease.id,
      lease?.extraction_data?.source_file_id || null
    );

    // No longer a hard throw when sourceText is empty. The deterministic
    // builder reads workflow_output.expense_rules and extracted lease
    // columns, so it can still produce rules without raw source text.
    // The LLM path will be skipped (it requires text), but the fallback
    // path may still derive rules.
    let mappedRules = [];

    if (sourceText) {
      try {
        const { data, error } = await supabase.functions.invoke("extract-lease-expense-rules", {
          body: {
            lease_id: lease.id,
            source_text: sourceText,
            categories: (categories || []).map((category) => ({
              id: category.id,
              category_name: category.category_name,
              subcategory_name: category.subcategory_name,
              normalized_key: category.normalized_key,
            })),
          },
        });

        if (error) throw error;
        mappedRules = mapExtractedRulesToCategories(data?.rules || [], categories, existingRules);
      } catch (error) {
        devWarn("[leaseExpenseRuleService] AI rule extraction fallback:", error);
        mappedRules = [];
      }
    } else {
      devWarn(
        "[leaseExpenseRuleService] extractDraftRuleSet: no source text found; skipping LLM extract and falling back to deterministic builder",
      );
    }

    if (mappedRules.length === 0) {
      mappedRules = buildDeterministicDraftRules({
        lease,
        categories,
        sourceText: sourceText || "",
        existingRules,
      });
    }

    if (mappedRules.length === 0) {
      devWarn(
        "[leaseExpenseRuleService] extractDraftRuleSet: produced 0 rules (no source text AND no workflow output). Returning empty result for lease",
        lease.id,
      );
      return { ruleSet: null, rules: [] };
    }

    return this.saveRuleSet({
      lease,
      rules: mappedRules,
      status: "draft",
      existingRuleSetId,
      categories,
    });
  },

  async saveRuleSet({ lease, rules = [], status = "draft", existingRuleSetId = null, categories = [], createdFrom = "workflow", approver = null }) {
    if (!supabase || !lease?.id) throw new Error("Lease is required to save expense rules");

    const tag = `[saveRuleSet lease=${lease?.id}]`;
    const orgId = await resolveWorkflowOrgId(lease);
    if (!orgId) {
      throw new Error("Unable to resolve organization for lease expense rules");
    }

    const incomingExtractionVersion = firstPresent(
      ...((rules || []).map((rule) => rule?.extraction_version)),
      normalizeText(createdFrom).includes("v3") ? EVIDENCE_ALIGNED_EXTRACTION_VERSION : null,
      normalizeText(createdFrom).includes("lease_rule_pipeline") ? EVIDENCE_ALIGNED_EXTRACTION_VERSION : null,
      LEGACY_EXTRACTION_VERSION,
    );
    const isEvidenceAlignedSave = isEvidenceAlignedVersion(incomingExtractionVersion);
    const normalizedRules = finalizeLeaseExpenseRules(rules, status);
    const { categories: persistedCategories, rules: resolvedRules } = await ensurePersistentCategories({
      orgId,
      categories,
      rules: normalizedRules,
    });
    const categoriesById = new Map((persistedCategories || []).map((category) => [category.id, category]));
    const now = new Date().toISOString();
    let ruleSetId = existingRuleSetId;
    let currentVersion = 1;

    if (ruleSetId) {
      const { data: targetRuleSet } = await supabase
        .from("lease_expense_rule_sets")
        .select("version")
        .eq("id", ruleSetId)
        .eq("org_id", orgId)
        .maybeSingle();
      currentVersion = Number(targetRuleSet?.version) || currentVersion;
      const { error: updateRuleSetError } = await supabase
        .from("lease_expense_rule_sets")
        .update({
          status,
          property_id: lease.property_id || null,
          approved_at: status === "approved" ? now : null,
          extraction_version: incomingExtractionVersion,
        })
        .eq("id", ruleSetId)
        .eq("org_id", orgId);

      if (updateRuleSetError) throw updateRuleSetError;
    } else {
      const { data: existingSets } = await supabase
        .from("lease_expense_rule_sets")
        .select("*")
        .eq("lease_id", lease.id)
        .not("status", "eq", "archived")
        .order("version", { ascending: false })
        .limit(5);

      if (existingSets && existingSets.length > 0) {
        const latestSet = existingSets[0];
        const latestVersion = Number(latestSet.version) || 1;
        currentVersion = latestVersion;
        let latestRows = [];
        try {
          const { data: rows, error: rowsError } = await supabase
            .from("lease_expense_rules")
            .select("*")
            .eq("rule_set_id", latestSet.id)
            .eq("lease_id", lease.id);
          if (rowsError) throw rowsError;
          latestRows = rows || [];
        } catch (error) {
          devWarn(`${tag} latest rule_set child lookup skipped:`, error?.message || error);
        }

        const latestHasProtectedRows = latestRows.some(isProtectedHumanRule);
        const latestVersionMatches = normalizeText(latestSet.extraction_version) === normalizeText(incomingExtractionVersion);
        const latestIsFrozen = isApprovedWorkflowStatus(latestSet.status) || latestHasProtectedRows;
        const shouldCreateNewVersion = isEvidenceAlignedSave && !latestVersionMatches && latestIsFrozen;

        if (shouldCreateNewVersion) {
          currentVersion = latestVersion + 1;
          const { data: createdRuleSet, error: createRuleSetError } = await supabase
            .from("lease_expense_rule_sets")
            .insert({
              org_id: orgId,
              lease_id: lease.id,
              property_id: lease.property_id || null,
              version: currentVersion,
              status,
              approved_at: status === "approved" ? now : null,
              extraction_version: incomingExtractionVersion,
            })
            .select("*")
            .single();
          if (createRuleSetError) throw createRuleSetError;
          ruleSetId = createdRuleSet.id;
          devLog(`${tag} created v${currentVersion} rule_set for ${incomingExtractionVersion}; preserving protected rows from prior set`);
        } else {
          ruleSetId = latestSet.id;
          currentVersion = latestVersion;
          const { error: updateExistingSetError } = await supabase
            .from("lease_expense_rule_sets")
            .update({
              status,
              property_id: lease.property_id || null,
              approved_at: status === "approved" ? now : null,
              extraction_version: incomingExtractionVersion,
            })
            .eq("id", ruleSetId)
            .eq("org_id", orgId);
          if (updateExistingSetError) throw updateExistingSetError;
          devLog(`${tag} reusing rule_set ${ruleSetId} (v${currentVersion}) for ${incomingExtractionVersion}`);
        }
      } else {
        currentVersion = 1;
        const { data: createdRuleSet, error: createRuleSetError } = await supabase
          .from("lease_expense_rule_sets")
          .insert({
            org_id: orgId,
            lease_id: lease.id,
            property_id: lease.property_id || null,
            version: currentVersion,
            status,
            approved_at: status === "approved" ? now : null,
            extraction_version: incomingExtractionVersion,
          })
          .select("*")
          .single();

        if (createRuleSetError) {
          const code = String(createRuleSetError.code || "");
          const message = `${createRuleSetError.message || ""} ${createRuleSetError.details || ""}`;
          if (code === "42501" || /row-level security/i.test(message)) {
            const enhanced = new Error(
              "RLS denied INSERT into lease_expense_rule_sets. " +
              "Apply migration 20260518130000_fix_lease_expense_rls.sql in Supabase SQL editor — " +
              "the existing policy requires is_super_admin()/can_write_org_data() which aren't returning true for this user. " +
              `Underlying error: ${createRuleSetError.message}`,
            );
            enhanced.code = createRuleSetError.code;
            throw enhanced;
          }
          throw createRuleSetError;
        }
        ruleSetId = createdRuleSet.id;
      }
    }

    // Save every rule we have a canonical category text for, even if the
    // expense_categories lookup failed (table missing, RLS denial, or org
    // hasn't seeded). The `expense_category` text column is now the source
    // of truth — the FK to expense_categories is nice-to-have for joins,
    // but losing it must not lose the rule. Previously this filter dropped
    // every rule whenever expense_categories was unavailable, which is why
    // the page showed 0 after approval.
    const finalized = finalizeLeaseExpenseRules(resolvedRules, status);
    const savableRules = finalized.filter((rule) => {
      if (isUuid(rule?.expense_category_id)) return true;
      const canonicalKey = rule?.normalized_key || rule?.fallback_category_key || rule?.expense_category;
      return Boolean(canonicalKey);
    });
    const unmappedCount = finalized.length - savableRules.length;
    if (unmappedCount > 0) {
      devWarn(`[leaseExpenseRuleService] saveRuleSet: ${unmappedCount} rules dropped (no canonical category)`);
    }
    const approvedAtIso = status === "approved" ? now : null;
    const computeRuleKey = (ruleObj) => {
      if (ruleObj.rule_key) return ruleObj.rule_key;
      const norm = (v) => String(v ?? "").toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
      const category = norm(firstPresent(ruleObj.expense_category, ruleObj.category_name, deriveRuleCategoryName(ruleObj)));
      const subcategory = norm(firstPresent(ruleObj.expense_subcategory, ruleObj.subcategory_name, deriveRuleSubcategoryName(ruleObj)));
      const type = norm(ruleObj.rule_type);
      const sourceKey = norm(ruleObj.source_field_key);
      return `${lease.id}_${type}_${category}_${subcategory}_${sourceKey}`;
    };
    let rulePayloads = savableRules.map((rule) => {
      // Only include `id` when the rule actually has a UUID — sending
      // `id: undefined` in a PostgREST upsert payload triggers a 400 on
      // some clients because PostgREST expects either a complete `id` per
      // row or none. The strip-missing-column retry was masking this with
      // an unnecessary round-trip.
      const exactSourceText = deriveRuleExactSourceText(rule);
      const ruleKey = computeRuleKey(rule);
      const payload = {
        rule_set_id: ruleSetId,
        rule_key: ruleKey,
        rule_type: rule.rule_type || null,
        source_field_key: rule.source_field_key || null,
        tenant_share_percent: asNumber(rule.tenant_share_percent),
        estimated_annual_amount: asNumber(rule.estimated_annual_amount),
        estimated_monthly_amount: asNumber(rule.estimated_monthly_amount),
        extraction_version: rule.extraction_version || incomingExtractionVersion,
        source_hash: exactSourceText ? String(exactSourceText).toLowerCase().slice(0, 80) : null,
        generation_source: rule.generation_source || createdFrom || "workflow",
        expense_category_id: isUuid(rule?.expense_category_id) ? rule.expense_category_id : null,
        // Denormalized scope so the Lease Expense Rules page can filter
        // without joining lease_expense_rule_sets. The migration backfills
        // these for existing rows.
        org_id: orgId,
        lease_id: lease.id,
        tenant_id: rule.tenant_id || lease.tenant_id || null,
        property_id: lease.property_id || null,
        building_id: lease.building_id || null,
        unit_id: lease.unit_id || null,
        approved_lease_abstract_id: lease.approved_lease_abstract_id || lease.abstract_snapshot?.id || null,
        created_from: createdFrom,
        approved_by: deriveRuleReviewStatus(rule) === "approved" ? (isUuid(approver) ? approver : null) : null,
        approved_at: deriveRuleReviewStatus(rule) === "approved" ? approvedAtIso : null,
        expense_category: firstPresent(rule.expense_category, rule.category_name, deriveRuleCategoryName(rule)),
        expense_subcategory: firstPresent(rule.expense_subcategory, rule.subcategory_name, deriveRuleSubcategoryName(rule)),
        operational_responsibility: deriveRuleOperationalResponsibility(rule),
        payment_treatment: deriveRulePaymentTreatment(rule),
        included_in_base_rent: deriveRuleIncludedInBaseRent(rule),
        recoverable_from_tenant: deriveRuleRecoverableFromTenant(rule),
        cam_eligible: deriveRuleCamEligible(rule),
        billing_treatment: deriveRuleBillingTreatment(rule),
        recovery_method: deriveRuleRecoveryMethod(rule),
        allocation_basis: deriveRuleAllocationBasis(rule),
        row_status: normalizeRuleStatus(rule),
        mentioned_in_lease: Boolean(rule.mentioned_in_lease || normalizeRuleStatus(rule) !== "not_mentioned"),
        is_recoverable: ["yes", "conditional"].includes(deriveRuleRecoverableFromTenant(rule)),
        is_excluded: Boolean(rule.is_excluded),
        is_controllable: Boolean(rule.is_controllable),
        is_subject_to_cap: Boolean(rule.is_subject_to_cap),
        cap_type: rule.cap_type || null,
        cap_value: asNumber(rule.cap_value),
        cap_amount: asNumber(firstPresent(rule.cap_amount, rule.cap_value)),
        cap_percent: asNumber(rule.cap_percent),
        has_base_year: Boolean(rule.has_base_year),
        base_year_type: rule.base_year_type || null,
        base_year: firstPresent(rule.base_year, rule.base_year_type),
        base_year_amount: asNumber(rule.base_year_amount),
        expense_stop_amount: asNumber(rule.expense_stop_amount),
        gross_up_applicable: Boolean(rule.gross_up_applicable),
        gross_up_percent: asNumber(rule.gross_up_percent),
        admin_fee_applicable: Boolean(rule.admin_fee_applicable),
        admin_fee_percent: asNumber(rule.admin_fee_percent),
        billing_frequency: normalizeFrequency(rule.billing_frequency || rule.frequency),
        reconciliation_required: deriveRuleReconciliationRequired(rule),
        reconciliation_frequency: deriveRuleReconciliationFrequency(rule),
        
        exact_source_text: deriveRuleExactSourceText(rule),
        confidence_score: deriveRuleConfidence(rule),
        extraction_status: deriveRuleExtractionStatus(rule),
        review_status: deriveRuleReviewStatus(rule),
        approval_status: deriveRuleApprovalStatus(rule, status),
        published_to_cam: derivePublishedToCam({
          ...rule,
          review_status: deriveRuleReviewStatus(rule),
          approval_status: deriveRuleApprovalStatus(rule, status),
        }),
        notes: rule.notes || null,
        confidence: deriveRuleConfidence(rule),
        source: normalizeRuleSource(firstPresent(rule.source, deriveRuleExactSourceText(rule))),
      };
      if (isUuid(rule?.id)) payload.id = rule.id;
      return payload;
    });

    // ── Preserve user-approved fields on upsert ─────────────────────────
    // Per Part 1 spec idempotency rule:
    //   "If rule_key exists and review_status is approved, do not overwrite
    //    user-reviewed fields."
    //
    // We fetch existing rows for the target rule_set keyed by rule_key,
    // and for any row whose existing review_status is 'approved', we
    // override the new payload's review/approval/published fields with the
    // preserved values. Without this, an extract click that hits the same
    // rule_key UPSERTs the row back to 'needs_review' and silently undoes
    // the user's approval.
    let preservedByKey = new Map();
    let protectedByCanonicalKey = new Map();
    if (rulePayloads.length > 0 && ruleSetId) {
      try {
        const ruleKeys = rulePayloads.map((p) => p.rule_key).filter(Boolean);
        if (ruleKeys.length > 0) {
          const { data: existing } = await supabase
            .from("lease_expense_rules")
            .select("*")
            .eq("lease_id", lease.id)
            .in("rule_key", ruleKeys);
          for (const row of existing || []) {
            preservedByKey.set(row.rule_key, row);
          }
        }
        const { data: existingForLease, error: existingForLeaseError } = await supabase
          .from("lease_expense_rules")
          .select("*")
          .eq("lease_id", lease.id);
        if (existingForLeaseError) throw existingForLeaseError;
        for (const row of existingForLease || []) {
          if (isRuleSuperseded(row) || !isProtectedHumanRule(row)) continue;
          const canonicalKey = canonicalRulePersistenceKey(row);
          const current = protectedByCanonicalKey.get(canonicalKey);
          if (!current || scorePersistedRuleForMerge(row) > scorePersistedRuleForMerge(current)) {
            protectedByCanonicalKey.set(canonicalKey, row);
          }
        }
      } catch (err) {
        devWarn(`${tag} existing-rule pre-fetch skipped:`, err?.message || err);
      }
    }

    if (protectedByCanonicalKey.size > 0) {
      let canonicalMergedCount = 0;
      for (const payload of rulePayloads) {
        const protectedRow = protectedByCanonicalKey.get(canonicalRulePersistenceKey(payload));
        if (!protectedRow) continue;
        canonicalMergedCount += 1;
        payload.id = protectedRow.id || payload.id;
        payload.rule_key = protectedRow.rule_key || payload.rule_key;
        payload.review_status = normalizeText(protectedRow.review_status) === "reviewed" ? "approved" : (protectedRow.review_status || payload.review_status);
        payload.approval_status = protectedRow.approval_status || payload.approval_status;
        payload.approved_by = protectedRow.approved_by ?? payload.approved_by;
        payload.approved_at = protectedRow.approved_at ?? payload.approved_at;
        payload.published_to_cam = protectedRow.published_to_cam ?? payload.published_to_cam;
        if (protectedRow.notes && !payload.notes) payload.notes = protectedRow.notes;
      }
      if (canonicalMergedCount > 0) {
        devLog(`[leaseExpenseRuleService] saveRuleSet merged ${canonicalMergedCount} v3 candidate(s) into existing protected human rule(s)`);
      }
    }

    if (rulePayloads.length > 1) {
      const payloadsByCanonicalKey = new Map();
      for (const payload of rulePayloads) {
        const key = canonicalRulePersistenceKey(payload);
        const existing = payloadsByCanonicalKey.get(key);
        if (!existing || scorePersistedRuleForMerge(payload) >= scorePersistedRuleForMerge(existing)) {
          payloadsByCanonicalKey.set(key, payload);
        }
      }
      rulePayloads = [...payloadsByCanonicalKey.values()];
    }

    if (rulePayloads.length > 1) {
      const payloadsByRuleKey = new Map();
      for (const payload of rulePayloads) {
        const existing = payloadsByRuleKey.get(payload.rule_key);
        if (!existing || scorePersistedRuleForMerge(payload) >= scorePersistedRuleForMerge(existing)) {
          payloadsByRuleKey.set(payload.rule_key, payload);
        }
      }
      rulePayloads = [...payloadsByRuleKey.values()];
    }

    if (preservedByKey.size > 0) {
      let preservedApprovedCount = 0;
      for (const payload of rulePayloads) {
        const existing = preservedByKey.get(payload.rule_key);
        if (!existing) continue;
        const isFromAbstractSync = existing.created_from === "approved_lease_abstract" || existing.generation_source === "lease_review_acceptance";
        const existingReviewStatus = normalizeText(existing.review_status) === "reviewed" ? "approved" : normalizeText(existing.review_status);
        const shouldPreserveApproved = (existingReviewStatus === "approved" || normalizeText(existing.approval_status) === "approved");
        if (shouldPreserveApproved && !isFromAbstractSync) {
          preservedApprovedCount += 1;
          payload.review_status = existingReviewStatus || payload.review_status;
          payload.approval_status = "approved";
          payload.approved_by = existing.approved_by ?? payload.approved_by;
          payload.approved_at = existing.approved_at ?? payload.approved_at ?? approvedAtIso ?? now;
          payload.published_to_cam = derivePublishedToCam({
            ...payload,
            published_to_cam: existing.published_to_cam ?? payload.published_to_cam,
          });
          // Keep human-edited notes too if they exist
          if (existing.notes && !payload.notes) payload.notes = existing.notes;
        }
      }
      if (preservedApprovedCount > 0) {
        devLog(`[leaseExpenseRuleService] saveRuleSet preserved approval on ${preservedApprovedCount} existing rule(s)`);
      }
    }

    if (isEvidenceAlignedSave && ruleSetId) {
      try {
        const supersedeResult = await supersedeUnresolvedRules({
          leaseId: lease.id,
          ruleSetId,
          orgId,
          extractionVersion: incomingExtractionVersion,
        });
        if (supersedeResult.superseded || supersedeResult.deleted) {
          devLog(
            `[leaseExpenseRuleService] saveRuleSet ${supersedeResult.superseded ? "superseded" : "deleted"} ` +
            `${supersedeResult.superseded || supersedeResult.deleted} stale unresolved rule(s) before v3 upsert`,
          );
        }
      } catch (error) {
        devWarn("[leaseExpenseRuleService] stale rule supersede warning:", error?.message || error);
      }
    }

    // Strip-missing-columns retry: if the DB hasn't been migrated yet with
    // the latest spec columns (payment_treatment, cam_eligible, etc.),
    // Postgres will return PGRST204 "Could not find column X". Rather than
    // fail the whole approve flow, peel that column out of every payload
    // and try again. Up to 12 retries — enough to clear several missing
    // columns without spinning forever. Logs which columns were dropped so
    // we know which migrations are missing.
    let savedRules = [];
    if (rulePayloads.length > 0) {
      let payloadsForUpsert = rulePayloads;
      const droppedColumns = [];
      let attemptsRemaining = 12;
      while (attemptsRemaining > 0) {
        // Conflict target = (rule_set_id, rule_key). This is what makes
        // re-extraction deterministic: clicking Extract twice with the
        devLog(`[SAVE PAYLOAD BEFORE UPSERT] Lease ${payloadsForUpsert[0]?.lease_id}:`);
        devTable(payloadsForUpsert.map(p => ({
          lease_id: p.lease_id,
          tenant_id: p.tenant_id,
          rule_key: p.rule_key,
          rule_type: p.rule_type,
          expense_category: p.expense_category,
          tenant_share_percent: p.tenant_share_percent,
          estimated_annual_amount: p.estimated_annual_amount,
          estimated_monthly_amount: p.estimated_monthly_amount,
          admin_fee_percent: p.admin_fee_percent,
          gross_up_percent: p.gross_up_percent,
          cap_percent: p.cap_percent
        })));

        const { data, error: ruleError } = await supabase
          .from("lease_expense_rules")
          .upsert(payloadsForUpsert, {
            onConflict: "lease_id,rule_key",
            ignoreDuplicates: false,
          })
          .select("*");
        devLog("[UPSERT RESULT]", { data, error: ruleError });
        if (!ruleError) {
          savedRules = data || [];
          break;
        }
        // PGRST204 = no schema cache for that column; 42703 = column does not exist.
        const errorMessage = `${ruleError.message || ""} ${ruleError.details || ""} ${ruleError.hint || ""}`;
        const colMatch =
          errorMessage.match(/Could not find the '([^']+)' column/i) ||
          errorMessage.match(/column "?([a-zA-Z0-9_]+)"? of relation/i) ||
          errorMessage.match(/column "?([a-zA-Z0-9_]+)"? does not exist/i);
        const missingCol = colMatch?.[1];
        const isMissingCol = ruleError.code === "PGRST204" || ruleError.code === "42703" || !!missingCol;
        if (!isMissingCol || !missingCol) throw ruleError;
        droppedColumns.push(missingCol);
        payloadsForUpsert = payloadsForUpsert.map((row) => {
          const { [missingCol]: _stripped, ...rest } = row;
          return rest;
        });
        attemptsRemaining -= 1;
      }
      if (droppedColumns.length > 0) {
        devWarn(
          `[leaseExpenseRuleService] saveRuleSet: dropped ${droppedColumns.length} missing column(s) before insert succeeded — apply latest migration to capture these fields:`,
          droppedColumns,
        );
      }
    }

    const rulesByCategoryId = new Map(savedRules.map((rule) => [rule.expense_category_id, rule]));
    const valuePayloads = [];
    const clausePayloads = [];

    for (const rule of resolvedRules) {
      const savedRule = rulesByCategoryId.get(rule.expense_category_id);
      if (!savedRule?.id) continue;

      const finalValue = extractRuleValue(rule);
      const hasValuePayload =
        finalValue != null ||
        asNumber(rule?.base_year_amount) != null ||
        rule?.frequency;

      if (hasValuePayload) {
        valuePayloads.push({
          rule_id: savedRule.id,
          base_year_amount: asNumber(rule.base_year_amount),
          extracted_value: asNumber(rule.extracted_value),
          manual_value: asNumber(rule.manual_value),
          final_value: finalValue,
          frequency: normalizeFrequency(rule.frequency),
          value_source: rule.manual_value != null ? "manual" : rule.extracted_value != null ? "extracted" : rule.value_source || null,
        });
      }

      clausePayloads.push(...extractRuleClauses(rule, lease.id, savedRule.id));
    }

    if (savedRules.length > 0) {
      const savedRuleIds = savedRules.map((rule) => rule.id);

      try {
        await supabase.from("lease_expense_values").delete().in("rule_id", savedRuleIds);
        if (valuePayloads.length > 0) {
          const { error: valuesError } = await supabase.from("lease_expense_values").insert(valuePayloads);
          if (valuesError) throw valuesError;
        }
      } catch (error) {
        devWarn("[leaseExpenseRuleService] value persistence warning:", error);
      }

      try {
        await supabase.from("lease_expense_rule_clauses").delete().in("lease_expense_rule_id", savedRuleIds);
        if (clausePayloads.length > 0) {
          const { error: clausesError } = await supabase.from("lease_expense_rule_clauses").insert(clausePayloads);
          if (clausesError) throw clausesError;
        }
      } catch (error) {
        devWarn("[leaseExpenseRuleService] clause persistence warning:", error);
      }
    }

    try {
      await this.recalculateRuleSetStatus(ruleSetId);
    } catch (error) {
      devWarn("[leaseExpenseRuleService] rule set status recalculation warning:", error?.message || error);
    }

    const persisted = await this.loadRuleSet(lease.id);
    if (status === "approved") {
      try {
        await saveLeaseConfig(lease.id, buildLeaseConfigFromRules(lease, persisted.rules, categoriesById));
      } catch (error) {
        devWarn("[leaseExpenseRuleService] lease config sync warning:", error);
      }
    }

    return {
      ...persisted,
      ruleSet: persisted.ruleSet || { id: ruleSetId, status, version: currentVersion },
    };
  },

  groupRulesByRecoveryStatus(rules = []) {
    const groups = {
      recoverable: [],
      nonRecoverable: [],
      conditional: [],
      needsReview: [],
    };

    for (const rule of rules || []) {
      const normalizedRecoveryStatus = normalizeRecoveryStatus(rule);
      if (normalizedRecoveryStatus === "recoverable") {
        groups.recoverable.push(rule);
        continue;
      }
      if (["non_recoverable", "excluded"].includes(normalizedRecoveryStatus)) {
        groups.nonRecoverable.push(rule);
        continue;
      }
      if (normalizedRecoveryStatus === "conditional") {
        groups.conditional.push(rule);
        continue;
      }
      groups.needsReview.push(rule);
    }

    return groups;
  },

  buildFallbackCategories({ lease, rules = [] } = {}) {
    const categories = [];
    const seenIds = new Set();

    for (const [index, workflowRule] of finalizeLeaseExpenseRules(getLeaseWorkflowExpenseRules(lease)).entries()) {
      const id = workflowRuleCategoryId(workflowRule, index);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      categories.push({
        id,
        category_name: workflowRule?.expense_category || workflowRule?.category_name || humanizeLabel(workflowRule?.category || workflowRule?.key),
        subcategory_name: workflowRule?.expense_subcategory || workflowRule?.subcategory_name || null,
        normalized_key: normalizeCategoryKey(
          workflowRule?.normalized_key || workflowRule?.expense_category || workflowRule?.category || workflowRule?.key
        ) || null,
        display_order: categories.length,
        is_fallback: true,
      });
    }

    for (const rule of rules || []) {
      const id = rule?.expense_category_id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      categories.push({
        id,
        category_name: rule?.category_name || humanizeLabel(rule?.normalized_key || id),
        subcategory_name: rule?.subcategory_name || null,
        normalized_key: rule?.normalized_key || rule?.fallback_category_key || null,
        display_order: categories.length,
        is_fallback: true,
      });
    }

    return categories;
  },

  async ensureApprovedRuleSet({ lease, categories = null } = {}) {
    throw new Error("LEGACY ensureApprovedRuleSet called after new pipeline");
    if (!lease?.id) throw new Error("Lease is required to approve expense rules");

    const current = await this.loadRuleSet(lease.id);
    const rules = current?.rules?.length > 0 ? current.rules : buildFallbackRulesFromWorkflow(lease);
    if (rules.length === 0) return current;

    let resolvedCategories = Array.isArray(categories) ? categories : [];
    if (resolvedCategories.length === 0) {
      try {
        const { data, error } = await supabase
          .from("expense_categories")
          .select("id, category_name, subcategory_name, normalized_key, display_order")
          .eq("is_active", true)
          .order("display_order", { ascending: true });
        if (error) throw error;
        resolvedCategories = data || [];
      } catch (error) {
        devWarn("[leaseExpenseRuleService] category bootstrap fallback:", error?.message || error);
        resolvedCategories = this.buildFallbackCategories({ lease, rules });
      }
    }

    return this.saveRuleSet({
      lease,
      rules,
      status: "approved",
      existingRuleSetId: current?.ruleSet?.id || null,
      categories: resolvedCategories,
    });
  },

  getOperationalResponsibility(rule) {
    return deriveRuleOperationalResponsibility(rule);
  },

  getPaymentTreatment(rule) {
    return deriveRulePaymentTreatment(rule);
  },

  getRecoverableDecision(rule) {
    return deriveRuleRecoverableFromTenant(rule);
  },

  getCamEligibleDecision(rule) {
    return deriveRuleCamEligible(rule);
  },

  getRecoveryMethod(rule) {
    return deriveRuleRecoveryMethod(rule);
  },

  getAllocationBasis(rule) {
    return deriveRuleAllocationBasis(rule);
  },

  getExactSourceText(rule) {
    return deriveRuleExactSourceText(rule);
  },

  getSourcePage(rule) {
    return deriveRuleSourcePage(rule);
  },

  getRuleValidation(rule) {
    return getRuleValidation(rule);
  },

  isRuleApproved(rule) {
    return isRuleApproved(rule);
  },

  isRuleCamPublishable(rule) {
    return isRuleCamPublishable(rule);
  },

  derivePublishedToCam(rule) {
    return derivePublishedToCam(rule);
  },

  deriveRuleSetStatusFromRules(rules = []) {
    return deriveRuleSetStatusFromRules(rules);
  },

  pickPreferredRuleSetWithApprovedChildren(ruleSets = [], rulesBySet = new Map()) {
    return pickPreferredRuleSetWithApprovedChildren(ruleSets, rulesBySet);
  },

  getBillingTreatment(rule) {
    return deriveRuleBillingTreatment(rule);
  },

  normalizeRecoveryStatus,
};

export default leaseExpenseRuleService;
