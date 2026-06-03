import {
  RULE_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  deriveRuleExactSourceText,
  deriveRuleSourcePage,
  deriveRuleConfidence,
  normalizeConfidenceScore,
  isWeakSourceText,
  hasStrongRuleEvidence,
} from "./leaseExpenseRuleFormatting";
import {
  isRuleSuperseded,
  isRuleRejected,
  isRuleNotApplicable,
} from "./leaseExpenseRuleStatus";
import {
  deriveRuleCamEligible,
  deriveRuleIncludedInBaseRent,
  deriveRuleOperationalResponsibility,
  deriveRulePaymentTreatment,
  deriveRuleRecoverableFromTenant,
  normalizeTriStateDecision,
} from "./leaseExpenseRuleDecisions";
import {
  normalizeText,
  firstPresent,
  isLlmGeneratedRule,
} from "./leaseExpenseRuleParsers";
import { getEffectiveReviewStatus } from "@/lib/ruleStatus";
import { derivePublishToCamEligibility } from "./ruleDecisionEngine";

function normalizeRuleStatus(rule) {
  const raw = String(rule?.row_status || "").trim().toLowerCase();
  return raw || "needs_review";
}

export function isRuleCamPublishable(rule) {
  return derivePublishToCamEligibility(rule).status === "eligible";
}

export function derivePublishedToCam(rule) {
  if (isRuleNotApplicable(rule) || isRuleRejected(rule)) return false;
  const eligibility = derivePublishToCamEligibility(rule);
  return eligibility.status === "eligible" || eligibility.status === "already_published";
}

export function deriveRuleBillingTreatment(rule) {
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

export function deriveRuleRecoveryMethod(rule) {
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

export function deriveRuleAllocationBasis(rule) {
  const recoverable = deriveRuleRecoverableFromTenant(rule);
  const camEligible = deriveRuleCamEligible(rule);
  if (!["yes", "conditional"].includes(recoverable) || !["yes", "conditional"].includes(camEligible)) {
    return null;
  }
  return firstPresent(rule?.allocation_basis, rule?.allocation_method, rule?.pro_rata_basis, "pro_rata_share");
}

export function deriveRuleExtractionStatus(rule) {
  if (rule?.extraction_status) return rule.extraction_status;
  if (normalizeRuleStatus(rule) === "not_mentioned") return "not_found";
  return "extracted";
}

export function deriveRuleReviewStatus(rule) {
  if (rule?.review_status) {
    return normalizeText(rule.review_status) === "reviewed" ? "approved" : rule.review_status;
  }
  if (isLlmGeneratedRule(rule)) return "needs_review";
  const status = normalizeRuleStatus(rule);
  if (status === "not_mentioned") return "not_found";
  if (status === "manually_added") return "approved";

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

export function deriveRuleApprovalStatus(rule, ruleSetStatus = "draft") {
  const explicitApprovalStatus = normalizeText(rule?.approval_status);
  if (deriveRuleReviewStatus(rule) === "approved") return "approved";
  if (explicitApprovalStatus) return rule.approval_status;
  return ruleSetStatus === "approved" ? "approved" : "draft";
}

export function deriveRuleReconciliationRequired(rule) {
  if (typeof rule?.reconciliation_required === "boolean") return rule.reconciliation_required;
  const recoveryMethod = normalizeText(deriveRuleRecoveryMethod(rule));
  return ["base_year", "expense_stop", "pass_through"].includes(recoveryMethod);
}

export function deriveRuleReconciliationFrequency(rule) {
  return firstPresent(
    rule?.reconciliation_frequency,
    deriveRuleReconciliationRequired(rule) ? "annual" : null,
  );
}

export function isRuleResponsibilityKnown(rule) {
  const responsibility = normalizeText(firstPresent(rule?.operational_responsibility, rule?.responsibility, deriveRuleOperationalResponsibility(rule)));
  return Boolean(responsibility) && !["unknown", "manual_review"].includes(responsibility);
}

export function isRuleRecoverableKnown(rule) {
  if (normalizeTriStateDecision(rule?.recoverable_from_tenant)) return true;
  if (typeof rule?.is_recoverable === "boolean") return true;
  if (deriveRuleIncludedInBaseRent(rule) || rule?.is_excluded) return true;
  return ["recoverable", "conditional", "non_recoverable", "excluded"].includes(normalizeText(rule?.rule_classification));
}

export function isRuleRecoveryMethodSpecific(rule) {
  const recoveryMethod = normalizeText(firstPresent(rule?.recovery_method, deriveRuleRecoveryMethod(rule)));
  return Boolean(recoveryMethod) && !["manual_review", "none", "unknown"].includes(recoveryMethod);
}

export function resolveRuleWorkflowState(rule, ruleSetStatus = "draft") {
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

export function getRuleValidation(rule) {
  const includedInBaseRent = deriveRuleIncludedInBaseRent(rule);
  const paymentTreatment = deriveRulePaymentTreatment(rule);
  const recoverableFromTenant = deriveRuleRecoverableFromTenant(rule);
  const camEligible = deriveRuleCamEligible(rule);
  const recoveryMethod = deriveRuleRecoveryMethod(rule);
  const allocationBasis = deriveRuleAllocationBasis(rule);
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

  const approvalBlockers = [];
  const isManual = rule?.created_from === "manual" || rule?.generation_source === "manual";

  if (isManual) {
    if (!hasValidSourcePage && !(rule?.notes && String(rule.notes).trim().length > 0)) {
      warnings.push("Missing notes for manual override");
    }
  } else {
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
