import { supabase } from "@/services/supabaseClient";
import { getCurrentOrgId } from "@/services/api";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import { fetchLeaseConfig, saveLeaseConfig } from "@/services/camConfig";

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeFrequency(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["monthly", "quarterly", "yearly"].includes(raw)) return raw;
  return "yearly";
}

function normalizeRuleSource(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function normalizeCategoryToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCategoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function humanizeLabel(value) {
  const text = String(value || "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!text) return "Uncategorized";
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function firstPresent(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

function isApprovedWorkflowStatus(value) {
  return normalizeText(value) === "approved";
}

function selectPreferredRuleSet(ruleSets = []) {
  if (!Array.isArray(ruleSets) || ruleSets.length === 0) return null;
  const approvedRuleSet = ruleSets.find((ruleSet) =>
    isApprovedWorkflowStatus(ruleSet?.status) ||
    isApprovedWorkflowStatus(ruleSet?.approval_status) ||
    isApprovedWorkflowStatus(ruleSet?.review_status)
  );
  return approvedRuleSet || ruleSets[0] || null;
}

function deriveRuleCategoryName(rule) {
  return (
    firstPresent(
      rule?.category_name,
      rule?.expense_category,
      rule?.category,
      rule?.key,
      rule?.normalized_key && humanizeLabel(rule.normalized_key),
    ) || "Uncategorized"
  );
}

function deriveRuleSubcategoryName(rule) {
  return firstPresent(rule?.subcategory_name, rule?.expense_subcategory);
}

function deriveRuleNormalizedKey(rule, index = 0) {
  return (
    normalizeCategoryKey(
      rule?.normalized_key ||
      rule?.fallback_category_key ||
      rule?.expense_subcategory ||
      rule?.expense_category ||
      rule?.category ||
      rule?.key ||
      `lease_rule_${index + 1}`
    ) || `lease_rule_${index + 1}`
  );
}

function deriveRuleIncludedInBaseRent(rule) {
  return Boolean(
    rule?.included_in_base_rent ??
    rule?.included_in_rent ??
    /included/.test(normalizeText(rule?.lease_treatment))
  );
}

function normalizeTriStateDecision(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "yes" : "no";
  const normalized = normalizeText(value);
  if (["yes", "true", "recoverable", "approved"].includes(normalized)) return "yes";
  if (["no", "false", "non_recoverable", "excluded"].includes(normalized)) return "no";
  if (["conditional", "shared", "maybe", "review"].includes(normalized)) return "conditional";
  return fallback;
}

function isRecoverableYes(rule) {
  return normalizeTriStateDecision(rule?.recoverable_from_tenant) === "yes";
}

function isRecoverableLike(rule) {
  return ["yes", "conditional"].includes(normalizeTriStateDecision(rule?.recoverable_from_tenant));
}

function isCamEligibleLike(rule) {
  return ["yes", "conditional"].includes(normalizeTriStateDecision(rule?.cam_eligible));
}

function deriveRuleOperationalResponsibility(rule) {
  const explicit = normalizeText(firstPresent(rule?.operational_responsibility, rule?.responsibility));
  if (["landlord", "owner"].includes(explicit)) return "landlord";
  if (["tenant", "tenant_direct", "tenant_direct_contract"].includes(explicit)) return "tenant";
  if (["shared", "joint"].includes(explicit)) return "shared";
  if (deriveRuleIncludedInBaseRent(rule)) return "landlord";
  if (rule?.is_excluded) return "tenant";
  if (isRecoverableLike(rule) || deriveRuleRecoverableFromTenant(rule) === "conditional") return "landlord";
  return "unknown";
}

function deriveRulePaymentTreatment(rule) {
  if (deriveRuleIncludedInBaseRent(rule)) return "included_in_base_rent";
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

function deriveRuleRecoverableFromTenant(rule) {
  const explicit = normalizeTriStateDecision(rule?.recoverable_from_tenant);
  if (explicit) return explicit;
  if (typeof rule?.recoverable_flag === "boolean") return rule.recoverable_flag ? "yes" : "no";
  if (typeof rule?.is_recoverable === "boolean") return rule.is_recoverable ? "yes" : "no";
  const classification = normalizeText(rule?.rule_classification);
  if (classification === "conditional") return "conditional";
  if (classification === "recoverable") return "yes";
  if (["non_recoverable", "excluded"].includes(classification)) return "no";
  if (deriveRuleIncludedInBaseRent(rule)) return "no";
  if (normalizeText(rule?.recovery_method) === "manual_review") return "conditional";
  return "no";
}

function deriveRuleResponsibility(rule) {
  return deriveRuleOperationalResponsibility(rule);
}

function deriveRuleCamEligible(rule) {
  const explicit = normalizeTriStateDecision(rule?.cam_eligible);
  if (explicit) {
    if (deriveRuleIncludedInBaseRent(rule)) return "no";
    if (deriveRuleRecoverableFromTenant(rule) === "no" && explicit === "yes") return "no";
    return explicit;
  }

  const categoryKey = normalizeCategoryKey(firstPresent(rule?.normalized_key, rule?.expense_subcategory, rule?.expense_category, rule?.category_name));
  const paymentTreatment = deriveRulePaymentTreatment(rule);
  const recoverable = deriveRuleRecoverableFromTenant(rule);

  if (paymentTreatment === "included_in_base_rent" || paymentTreatment === "tenant_direct_contract") return "no";
  if (recoverable === "no") return "no";

  const coreCamCategories = new Set([
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

  if (coreCamCategories.has(categoryKey)) {
    return recoverable === "conditional" ? "conditional" : "yes";
  }

  return recoverable === "yes" ? "conditional" : "no";
}

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
  if (rule?.approval_status) return rule.approval_status;
  if (deriveRuleReviewStatus(rule) !== "approved") return "draft";
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

function deriveRuleExactSourceText(rule) {
  const firstClause = asArray(rule?.clauses)[0];
  return firstPresent(
    firstClause?.clause_text,
    firstClause?.source_text,
    firstClause?.evidence_text,
    firstClause?.text,
    rule?.exact_source_text,
    rule?.source_clause,
    rule?.clause_text,
    rule?.evidence_text,
    rule?.source_text,
  );
}

function deriveRuleSourcePage(rule) {
  const directPage = Number(rule?.source_page ?? rule?.page_number ?? rule?.evidence_page_number);
  if (Number.isFinite(directPage) && directPage > 0) return directPage;
  const firstClause = asArray(rule?.clauses)[0];
  const clausePage = Number(firstClause?.page_number);
  if (Number.isFinite(clausePage) && clausePage > 0) return clausePage;
  return null;
}

function deriveRuleConfidence(rule) {
  return asNumber(firstPresent(rule?.confidence, rule?.confidence_score)) ?? 0.7;
}

const RULE_AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.80;

const CANONICAL_EXPENSE_CATEGORY_CONFIG = [
  {
    canonicalKey: "common_area_maintenance",
    categoryName: "Common Area Maintenance",
    aliases: ["cam", "common_area_maintenance", "common area maintenance"],
  },
  {
    canonicalKey: "real_estate_taxes",
    categoryName: "Real Estate Taxes",
    aliases: ["property_tax", "real_estate_taxes", "taxes", "taxes_real_estate", "property taxes"],
  },
  {
    canonicalKey: "property_insurance",
    categoryName: "Property Insurance",
    aliases: ["insurance", "property_insurance", "property insurance"],
  },
  {
    canonicalKey: "repairs_maintenance",
    categoryName: "Repairs & Maintenance",
    aliases: [
      "maintenance",
      "repairs",
      "repairs_maintenance",
      "interior_repairs",
      "exterior_repairs",
      "roof_structure",
      "foundation_structure",
      "hvac",
    ],
  },
  {
    canonicalKey: "legal_enforcement_fees",
    categoryName: "Legal / Enforcement Fees",
    aliases: [
      "legal_fees",
      "enforcement_fees",
      "attorneys_fees",
      "legal_default_costs",
      "legal_enforcement_fees",
    ],
  },
  {
    canonicalKey: "utilities",
    categoryName: "Utilities",
    aliases: ["utilities", "utility"],
  },
  {
    canonicalKey: "electricity",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Electricity",
    aliases: ["electricity", "electric"],
  },
  {
    canonicalKey: "water",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Water",
    aliases: ["water"],
  },
  {
    canonicalKey: "sewer",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Sewer",
    aliases: ["sewer"],
  },
  {
    canonicalKey: "gas",
    parentKey: "utilities",
    categoryName: "Utilities",
    subcategoryName: "Gas",
    aliases: ["gas"],
  },
];

const EXCLUDED_LEASE_EXPENSE_RULE_KEYS = new Set(["base_rent", "monthly_rent", "annual_rent", "additional_rent"]);

const GENERIC_SOURCE_PATTERNS = [
  /included in base rent under/i,
  /recoverable under/i,
  /explicit recurring charge extracted/i,
  /lease mentions this category/i,
  /direct reimbursement obligation/i,
  /mixed included and recoverable treatment/i,
  /tenant pays directly under the lease/i,
  /fixed cam amount extracted/i,
  /percentage rent rules were extracted/i,
  /billable exception charge under/i,
];

function normalizeConfidenceScore(value) {
  const numeric = asNumber(value);
  if (numeric == null) return null;
  if (numeric <= 1) return Math.max(0, Math.min(1, numeric));
  return Math.max(0, Math.min(1, numeric / 100));
}

function resolveCanonicalExpenseCategory(rule, index = 0) {
  const candidates = [
    rule?.expense_subcategory,
    rule?.expense_category,
    rule?.category_name,
    rule?.subcategory_name,
    rule?.category,
    rule?.key,
    rule?.normalized_key,
    rule?.fallback_category_key,
  ]
    .map(normalizeCategoryKey)
    .filter(Boolean);

  for (const candidate of candidates) {
    for (const config of CANONICAL_EXPENSE_CATEGORY_CONFIG) {
      if (config.aliases.some((alias) => normalizeCategoryKey(alias) === candidate)) {
        return {
          canonicalKey: config.parentKey || config.canonicalKey,
          normalizedKey: config.parentKey || config.canonicalKey,
          categoryName: config.categoryName,
          subcategoryName: config.subcategoryName || null,
        };
      }
    }
  }

  const fallbackKey = deriveRuleNormalizedKey(rule, index);
  return {
    canonicalKey: fallbackKey,
    normalizedKey: fallbackKey,
    categoryName: humanizeLabel(deriveRuleCategoryName(rule)),
    subcategoryName: deriveRuleSubcategoryName(rule),
  };
}

function isRuleExcludedFromLeaseExpenses(rule, canonicalKey) {
  return EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(canonicalKey) ||
    EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(normalizeCategoryKey(rule?.expense_category)) ||
    EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(normalizeCategoryKey(rule?.category_name)) ||
    EXCLUDED_LEASE_EXPENSE_RULE_KEYS.has(normalizeCategoryKey(rule?.normalized_key));
}

function isWeakSourceText(text) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length < 18) return true;
  return GENERIC_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasStrongRuleEvidence(rule) {
  return Number.isFinite(Number(deriveRuleSourcePage(rule))) && !isWeakSourceText(deriveRuleExactSourceText(rule));
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
    !notFoundRow &&
    Boolean(exactSourceText) &&
    confidence != null &&
    confidence >= RULE_AUTO_APPROVE_CONFIDENCE_THRESHOLD;

  const extractionStatus = explicitExtractionStatus || (strongEvidence ? "extracted" : "inferred");
  const explicitReviewStatus = normalizeText(rule?.review_status) === "reviewed" ? "approved" : normalizeText(rule?.review_status);
  const reviewStatus = explicitReviewStatus || (autoApproved ? "approved" : "needs_review");
  const approvalStatus = normalizeText(rule?.approval_status) || (autoApproved && ruleSetStatus === "approved" ? "approved" : "draft");
  const rowStatus =
    extractionStatus === "not_found"
      ? "not_mentioned"
      : (autoApproved || normalizeText(rule?.row_status) === "manually_added")
        ? normalizeText(rule?.row_status) || "mapped"
        : "needs_review";
  const canPublishToCam = canPublishRuleToCamByState({
    ...rule,
    review_status: reviewStatus,
    approval_status: approvalStatus,
  });

  return {
    exactSourceText,
    confidence,
    strongEvidence,
    extractionStatus,
    reviewStatus,
    approvalStatus,
    rowStatus,
    publishedToCam: canPublishToCam ? Boolean(rule?.published_to_cam) : false,
  };
}

function canPublishRuleToCamByState(rule) {
  return getRuleValidation(rule).canPublishToCam;
}

function getRuleValidation(rule) {
  const includedInBaseRent = deriveRuleIncludedInBaseRent(rule);
  const paymentTreatment = deriveRulePaymentTreatment(rule);
  const recoverableFromTenant = deriveRuleRecoverableFromTenant(rule);
  const camEligible = deriveRuleCamEligible(rule);
  const recoveryMethod = deriveRuleRecoveryMethod(rule);
  const allocationBasis = deriveRuleAllocationBasis(rule);
  const reviewStatus = normalizeText(rule?.review_status) === "reviewed" ? "approved" : normalizeText(rule?.review_status || deriveRuleReviewStatus(rule));
  const approvalStatus = normalizeText(rule?.approval_status || deriveRuleApprovalStatus(rule));
  const sourcePage = deriveRuleSourcePage(rule);
  const exactSourceText = deriveRuleExactSourceText(rule);
  const alreadyPublished = Boolean(rule?.published_to_cam);
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

  const publishBlockers = [];
  publishBlockers.push(...approvalBlockers);
  if (reviewStatus !== "approved") publishBlockers.push("Not reviewed");
  if (approvalStatus !== "approved") publishBlockers.push("Not approved");
  if (!["yes", "conditional"].includes(recoverableFromTenant)) publishBlockers.push("Not recoverable");
  if (!["yes", "conditional"].includes(camEligible)) publishBlockers.push("Not CAM eligible");
  if (includedInBaseRent) publishBlockers.push("Included in rent");
  if (paymentTreatment === "included_in_base_rent") publishBlockers.push("Included in rent");
  if (alreadyPublished) publishBlockers.push("Already published");
  publishBlockers.push(...issues);

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
    canPublishToCam: publishBlockers.length === 0,
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
    source_page: validation.sourcePage,
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
      source_page: Number.isFinite(Number(rule?.source_page)) ? Number(rule.source_page) : null,
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

function normalizeRecoveryStatus(rule) {
  if (rule?.is_excluded) return "excluded";
  if (normalizeTriStateDecision(rule?.recoverable_from_tenant) === "conditional") return "conditional";
  if (normalizeRuleStatus(rule) === "uncertain") return "conditional";
  if (normalizeRuleStatus(rule) === "missing_value") return "needs_review";
  if (isRecoverableLike(rule) || ["yes", "conditional"].includes(deriveRuleRecoverableFromTenant(rule))) return "recoverable";
  if (rule?.mentioned_in_lease || deriveRuleExtractionStatus(rule) === "extracted") return "non_recoverable";
  return "needs_review";
}

function extractRuleValue(rule) {
  return asNumber(rule?.final_value ?? rule?.manual_value ?? rule?.extracted_value);
}

function extractRuleClauses(rule, leaseId, ruleId) {
  const explicitClauses = asArray(rule?.clauses);
  if (explicitClauses.length > 0) {
    return explicitClauses
      .map((clause) => {
        const clauseText = String(
          clause?.clause_text ??
            clause?.source_text ??
            clause?.evidence_text ??
            clause?.text ??
            ""
        ).trim();
        if (!clauseText) return null;
        return {
          lease_expense_rule_id: ruleId,
          lease_id: leaseId,
          page_number: Number.isFinite(Number(clause?.page_number)) ? Number(clause.page_number) : null,
          clause_type: clause?.clause_type || "supporting_text",
          clause_text: clauseText,
          confidence: asNumber(clause?.confidence ?? rule?.confidence),
        };
      })
      .filter(Boolean);
  }

  const source = normalizeRuleSource(rule?.exact_source_text || rule?.source);
  if (!source) return [];

  return [{
    lease_expense_rule_id: ruleId,
    lease_id: leaseId,
    page_number: Number.isFinite(Number(rule?.source_page ?? rule?.page_number ?? rule?.evidence_page_number))
      ? Number(rule.source_page ?? rule.page_number ?? rule.evidence_page_number)
      : null,
    clause_type: "supporting_text",
    clause_text: source,
    confidence: asNumber(rule?.confidence),
  }];
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
          console.warn(
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
  const approvedRules = rules.filter((rule) => normalizeText(rule?.approval_status) === "approved" && normalizeText(rule?.review_status) === "approved");
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
      source_page: Number.isFinite(Number(rule?.source_page)) ? Number(rule.source_page) : null,
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
    if (extractedValue == null || extractedValue <= 0) continue;

    const snippet = extractSnippet(
      sourceText,
      new RegExp(`${candidate.keywords.join("|")}[\\s\\S]{0,120}?\\$[\\d,]+(?:\\.\\d{2})?`, "i"),
    );
    const existing = existingByCategoryId.get(category.id) || {};

    draftRules.push({
      ...existing,
      expense_category_id: category.id,
      category_name: category.category_name,
      subcategory_name: category.subcategory_name || null,
      row_status: "mapped",
      mentioned_in_lease: true,
      is_recoverable: true,
      is_excluded: false,
      is_controllable: true,
      is_subject_to_cap: false,
      has_base_year: false,
      gross_up_applicable: false,
      admin_fee_applicable: false,
      extracted_value: extractedValue,
      final_value: extractedValue,
      frequency: /monthly|per month/i.test(snippet || sourceText) ? "monthly" : "yearly",
      confidence: 0.78,
      notes: candidate.notes,
      source: snippet || candidate.notes,
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

      const ruleSet = selectPreferredRuleSet(ruleSets || []);
      if (!ruleSet) {
        const fallbackLease = (await fetchLeasesForFallback([leaseId]))[0] || null;
        const fallbackEntry = fallbackLease ? buildFallbackRuleSetEntry(fallbackLease) : null;
        return fallbackEntry
          ? { ruleSet: fallbackEntry.ruleSet, rules: fallbackEntry.rules }
          : { ruleSet: null, rules: [] };
      }

      const { rules, valuesByRuleId, clausesByRuleId } = await loadRuleDependencies(ruleSet.id);
      const mergedRules = mergeRulesWithRelations(rules, valuesByRuleId, clausesByRuleId);
      const finalizedRules = finalizeLeaseExpenseRules(mergedRules, ruleSet?.status || "draft");

      if (finalizedRules.length === 0) {
        const fallbackLease = (await fetchLeasesForFallback([leaseId]))[0] || null;
        const fallbackEntry = fallbackLease ? buildFallbackRuleSetEntry(fallbackLease) : null;
        if (fallbackEntry) {
          return { ruleSet: ruleSet || fallbackEntry.ruleSet, rules: fallbackEntry.rules };
        }
      }

      return { ruleSet, rules: finalizedRules };
    } catch (error) {
      if (!isMissingExpenseRuleTable(error)) throw error;
      const fallbackLease = (await fetchLeasesForFallback([leaseId]))[0] || null;
      const fallbackEntry = fallbackLease ? buildFallbackRuleSetEntry(fallbackLease) : null;
      return fallbackEntry
        ? { ruleSet: fallbackEntry.ruleSet, rules: fallbackEntry.rules }
        : { ruleSet: null, rules: [] };
    }
  },

  async loadRuleSets(leaseIds = []) {
    const tag = `[loadRuleSets leaseIds=${leaseIds?.length || 0}]`;
    if (!supabase || !Array.isArray(leaseIds) || leaseIds.length === 0) {
      console.log(`${tag} early return — no leaseIds`);
      return [];
    }

    const leasesForFallback = await fetchLeasesForFallback(leaseIds);
    const fallbackByLeaseId = new Map(
      leasesForFallback
        .map((lease) => [lease.id, buildFallbackRuleSetEntry(lease)])
        .filter(([, entry]) => Boolean(entry))
    );

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
      console.log(`${tag} rule_sets read: ${ruleSets?.length || 0}`, ruleSets?.map((s) => ({ id: s.id?.slice(0, 8), lease: s.lease_id?.slice(0, 8), v: s.version, status: s.status })));

      const ruleSetsByLeaseId = new Map();
      for (const ruleSet of ruleSets || []) {
        const existing = ruleSetsByLeaseId.get(ruleSet.lease_id) || [];
        existing.push(ruleSet);
        ruleSetsByLeaseId.set(ruleSet.lease_id, existing);
      }

      const latestRuleSets = [...ruleSetsByLeaseId.values()]
        .map((leaseRuleSets) => selectPreferredRuleSet(leaseRuleSets))
        .filter(Boolean);
      const ruleSetIds = latestRuleSets.map((ruleSet) => ruleSet.id);
      if (ruleSetIds.length === 0) {
        return [...fallbackByLeaseId.values()].filter(Boolean);
      }

      const { data: rules, error: rulesError } = await supabase
        .from("lease_expense_rules")
        .select("*")
        .in("rule_set_id", ruleSetIds);

      if (rulesError) {
        console.error(`${tag} rules query failed:`, rulesError);
        throw rulesError;
      }
      console.log(`${tag} rules read: ${rules?.length || 0} for ${ruleSetIds.length} rule_set(s)`);

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
        const fallbackEntry = fallbackByLeaseId.get(ruleSet.lease_id);
        console.log(`${tag} lease ${ruleSet.lease_id?.slice(0, 8)} → ${rulesForSet.length} raw → ${finalizedRules.length} finalized (after dedup/exclude)`);
        return {
          leaseId: ruleSet.lease_id,
          ruleSet,
          rules: finalizedRules.length > 0 ? finalizedRules : (fallbackEntry?.rules || []),
        };
      });
      console.log(`${tag} returning ${persistedEntries.length} entries`);

      const persistedLeaseIds = new Set(persistedEntries.map((entry) => entry.leaseId));
      const fallbackEntries = [...fallbackByLeaseId.values()].filter(
        (entry) => entry && !persistedLeaseIds.has(entry.leaseId)
      );

      return [...persistedEntries, ...fallbackEntries];
    } catch (error) {
      if (!isMissingExpenseRuleTable(error)) throw error;
      return [...fallbackByLeaseId.values()].filter(Boolean);
    }
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
        console.warn("[diagnose] uploaded_files lookup failed:", err?.message || err);
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
      console.warn("[diagnose] rule lookup failed:", err?.message || err);
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
      console.warn(`${tag} skipped: no supabase or no lease.id`);
      return { ruleSet: null, rules: [] };
    }
    const workflowRules = getLeaseWorkflowExpenseRules(lease);
    console.log(`${tag} workflow_rules received: ${workflowRules.length}`);
    if (workflowRules.length === 0) {
      const wfOut = lease?.extraction_data?.workflow_output;
      console.warn(`${tag} no workflow expense_rules. extraction_data keys=`, Object.keys(lease?.extraction_data || {}), "workflow_output keys=", wfOut ? Object.keys(wfOut) : null);
      return { ruleSet: null, rules: [] };
    }

    // Strip base_rent / base rent / rent rules. saveRuleSet's resolver will
    // also drop unmappable rules but skipping here keeps the audit log clean.
    const BASE_RENT_KEYS = new Set(["base_rent", "rent", "minimum_rent", "fixed_rent"]);
    const filtered = workflowRules.filter((r) => {
      const key = String(r?.expense_category || r?.normalized_key || "").toLowerCase();
      return !BASE_RENT_KEYS.has(key);
    });
    console.log(`${tag} after base-rent strip: ${filtered.length} rules; categories=`, filtered.map((r) => r?.expense_category));

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
            console.log(
              `${tag} reusing existing rule_set ${latest.id} (v${latest.version}, status=${latest.status}, ev=${latest.extraction_version || "—"})`,
            );
          } else {
            console.log(
              `${tag} latest rule_set is approved with different extraction_version (${latest.extraction_version}) — creating a new draft for ${EXTRACTION_VERSION_FOR_LOOKUP}`,
            );
          }
        }
      } catch (err) {
        console.warn(`${tag} existing rule_set lookup failed:`, err?.message || err);
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
      console.log(`${tag} saveRuleSet returned ${result?.rules?.length || 0} persisted rules; ruleSet=`, result?.ruleSet?.id);
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
    const text = String(sourceText || "").toLowerCase();
    if (!text) return [];
    // Each entry: [canonical_key, [phrase aliases]]. Cover the spec category list.
    const SCANS = [
      ["common_area_maintenance", ["common area maintenance", "cam charge", "cam expense", " cam "]],
      ["operating_expenses",      ["operating expenses", "operating costs", "opex"]],
      ["real_estate_taxes",       ["real estate tax", "property tax", "taxes and assessments", "ad valorem"]],
      ["property_insurance",      ["property insurance", "casualty insurance", "fire insurance", "all-risk insurance"]],
      ["utilities",               ["utilities", "utility service", "utility charge"]],
      ["electricity",             ["electricity", " electric ", "electrical service"]],
      ["water",                   [" water ", "water service", "potable water"]],
      ["sewer",                   ["sewer", "sewage"]],
      ["gas",                     ["natural gas", " gas service", " gas "]],
      ["hvac",                    [" hvac", "heating, ventilation", "air conditioning", "air-conditioning"]],
      ["janitorial",              ["janitorial", "cleaning service"]],
      ["trash_removal",           ["trash removal", "garbage", "refuse"]],
      ["security",                ["security service", "security guard"]],
      ["landscaping",             ["landscaping", "landscape maintenance"]],
      ["snow_removal",            ["snow removal", "snow plow"]],
      ["parking",                 ["parking lot", "parking area", "parking maintenance"]],
      ["repairs_maintenance",     ["repairs and maintenance", "repair and maintenance"]],
      ["roof_structure",          [" roof ", "roof and structure"]],
      ["foundation_structure",    ["foundation", "structural component"]],
      ["capital_expenditures",    ["capital expenditure", "capital improvement", "capex"]],
      ["management_fees",         ["management fee", "property management"]],
      ["administrative_fees",     ["administrative fee", "admin fee", "administration fee"]],
      ["tenant_insurance",        ["tenant insurance", "tenant's insurance", "liability insurance"]],
      ["tenant_improvements",     ["tenant improvement", "ti allowance", "buildout"]],
      ["alterations",             ["alterations", "tenant alteration"]],
      ["tenant_caused_damage",    ["caused by tenant", "tenant-caused", "tenant caused damage"]],
      ["separately_metered_charges", ["separately metered", "separate meter", "submetered"]],
      ["excess_usage",            ["excess use", "excess utility", "over and above"]],
      ["legal_enforcement_fees",  ["attorneys' fees", "attorney's fees", "legal fee", "enforcement"]],
      ["late_fees",               ["late fee", "late charge"]],
      ["interest",                ["interest at", "interest rate", "prime rate"]],
    ];
    const rules = [];
    for (const [key, phrases] of SCANS) {
      let matchedPhrase = null;
      for (const phrase of phrases) {
        if (text.includes(phrase)) {
          matchedPhrase = phrase.trim();
          break;
        }
      }
      if (!matchedPhrase) continue;

      // Extract a window of surrounding text (~200 chars) as evidence
      const idx = text.indexOf(matchedPhrase);
      const start = Math.max(0, idx - 80);
      const end = Math.min(text.length, idx + matchedPhrase.length + 200);
      const snippet = sourceText.substring(start, end).trim();

      // Light heuristic: is responsibility hinted near the match?
      const window = text.substring(Math.max(0, idx - 200), Math.min(text.length, idx + matchedPhrase.length + 400));
      let responsibility = "unknown";
      if (/\btenant\b.{0,80}\b(?:pay|reimburse|responsible)/.test(window)) responsibility = "tenant";
      else if (/\blandlord\b.{0,80}\b(?:pay|provide|responsible)/.test(window)) responsibility = "landlord";
      else if (/\bshared\b|\bpro rata\b|\bapportioned\b/.test(window)) responsibility = "shared";

      const includedInRent = /\bincluded in (?:base )?rent\b|\bfull[-\s]?service\b|\bgross lease\b/.test(window);
      const recoverable =
        includedInRent ? false
        : responsibility === "tenant" ? true
        : null;

      rules.push({
        expense_category: key,
        normalized_key: key,
        category_name: humanizeLabel(key),
        responsibility,
        recoverable_from_tenant: recoverable === true ? "yes" : recoverable === false ? "no" : "unknown",
        included_in_base_rent: includedInRent,
        recovery_method: includedInRent ? "included_in_rent" : (recoverable ? "manual_review" : "manual_review"),
        exact_source_text: snippet,
        source_clause: snippet,
        source_page: null,
        confidence_score: 0.55,
        extraction_status: "inferred",
        status: "needs_review",
        mentioned_in_lease: true,
        notes: `Inferred from lease language matching keyword "${matchedPhrase}"`,
      });
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
      console.warn(`${tag} workflow path failed:`, err?.message || err);
    }
    if (result?.rules?.length > 0) {
      console.log(`${tag} ✓ Phase 1 (workflow) produced ${result.rules.length} rules`);
      return result;
    }

    // Phase 2: workflow gave us nothing. Run the full extractor pipeline
    // (LLM call + deterministic fallback).
    console.log(`${tag} Phase 1 produced 0 rules → trying Phase 2 (extractDraftRuleSet)`);
    try {
      const fallback = await this.extractDraftRuleSet({
        lease,
        categories,
        existingRuleSetId: result?.ruleSet?.id || null,
        existingRules: [],
      });
      if (fallback?.rules?.length > 0) {
        console.log(`${tag} ✓ Phase 2 (LLM/deterministic) produced ${fallback.rules.length} rules`);
        return fallback;
      }
      result = fallback || result;
    } catch (err) {
      console.warn(`${tag} Phase 2 failed:`, err?.message || err);
    }

    // Phase 3: keyword scan on raw text. Last-resort — guarantees rules
    // exist for any lease that mentions any of the canonical category
    // vocabulary, even when nothing else worked.
    console.log(`${tag} Phase 2 produced 0 rules → trying Phase 3 (text fallback)`);
    try {
      const sourceText = await this.getLeaseSourceText(
        lease.id,
        lease?.extraction_data?.source_file_id || null,
      );
      if (!sourceText) {
        console.warn(`${tag} Phase 3 skipped — no source text available`);
        return result;
      }
      const textRules = this.buildTextFallbackRules(sourceText);
      console.log(`${tag} Phase 3 keyword scan found ${textRules.length} category matches`);
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
      console.log(`${tag} ✓ Phase 3 persisted ${saved?.rules?.length || 0} rules`);
      return saved;
    } catch (err) {
      console.warn("[leaseExpenseRuleService] ensureLeaseExpenseRules: fallback extract failed:", err?.message || err);
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
        console.warn("[leaseExpenseRuleService] AI rule extraction fallback:", error);
        mappedRules = [];
      }
    } else {
      console.warn(
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
      console.warn(
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

    const orgId = await resolveWorkflowOrgId(lease);
    if (!orgId) {
      throw new Error("Unable to resolve organization for lease expense rules");
    }

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
      const { error: updateRuleSetError } = await supabase
        .from("lease_expense_rule_sets")
        .update({
          status,
          property_id: lease.property_id || null,
          approved_at: status === "approved" ? now : null,
        })
        .eq("id", ruleSetId)
        .eq("org_id", orgId);

      if (updateRuleSetError) throw updateRuleSetError;
    } else {
      const { data: existingSets } = await supabase
        .from("lease_expense_rule_sets")
        .select("version")
        .eq("lease_id", lease.id)
        .order("version", { ascending: false })
        .limit(1);

      currentVersion = Number(existingSets?.[0]?.version || 0) + 1;
      const { data: createdRuleSet, error: createRuleSetError } = await supabase
        .from("lease_expense_rule_sets")
        .insert({
          org_id: orgId,
          lease_id: lease.id,
          property_id: lease.property_id || null,
          version: currentVersion,
          status,
          approved_at: status === "approved" ? now : null,
          // Stamp the extraction version on every new rule_set so we can
          // skip re-extraction when nothing has changed (auto-extract gate).
          extraction_version: "v1.2026.05.19",
        })
        .select("*")
        .single();

      if (createRuleSetError) {
        // The most common cause is RLS: the user's role doesn't satisfy the
        // INSERT policy on lease_expense_rule_sets. Surface a clear, actionable
        // error so we don't have to chase generic "42501 row-level security"
        // messages.
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
      console.warn(`[leaseExpenseRuleService] saveRuleSet: ${unmappedCount} rules dropped (no canonical category)`);
    }
    const approvedAtIso = status === "approved" ? now : null;
    // Deterministic content-derived rule_key — must match the SQL formula
    // in 20260519101000_lease_expense_rules_rule_key_string.sql exactly so
    // upsert(onConflict: 'rule_set_id,rule_key') hits existing rows.
    const computeRuleKey = (ruleObj) => {
      const norm = (v) => String(v ?? "").toLowerCase().trim();
      const sourceText = String(deriveRuleExactSourceText(ruleObj) || "").trim();
      const sourceTextHead = sourceText.toLowerCase().slice(0, 80).trim();
      const sourcePage = Number.isFinite(Number(ruleObj?.source_page)) ? String(Number(ruleObj.source_page)) : "";
      return [
        norm(firstPresent(ruleObj.expense_category, ruleObj.category_name, deriveRuleCategoryName(ruleObj))),
        norm(firstPresent(ruleObj.expense_subcategory, ruleObj.subcategory_name, deriveRuleSubcategoryName(ruleObj))),
        norm(deriveRulePaymentTreatment(ruleObj)),
        norm(deriveRuleRecoverableFromTenant(ruleObj)),
        norm(deriveRuleRecoveryMethod(ruleObj)),
        sourcePage,
        sourceTextHead,
      ].join("|");
    };
    const EXTRACTION_VERSION = "v1.2026.05.19";
    const rulePayloads = savableRules.map((rule) => {
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
        extraction_version: rule.extraction_version || EXTRACTION_VERSION,
        source_hash: exactSourceText ? String(exactSourceText).toLowerCase().slice(0, 80) : null,
        generation_source: rule.generation_source || createdFrom || "workflow",
        expense_category_id: isUuid(rule?.expense_category_id) ? rule.expense_category_id : null,
        // Denormalized scope so the Lease Expense Rules page can filter
        // without joining lease_expense_rule_sets. The migration backfills
        // these for existing rows.
        org_id: orgId,
        lease_id: lease.id,
        tenant_id: lease.tenant_id || null,
        property_id: lease.property_id || null,
        building_id: lease.building_id || null,
        unit_id: lease.unit_id || null,
        approved_lease_abstract_id: lease.approved_lease_abstract_id || lease.abstract_snapshot?.id || null,
        created_from: createdFrom,
        approved_by: deriveRuleReviewStatus(rule) === "approved" ? (approver || lease.signed_by || null) : null,
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
        source_page: Number.isFinite(Number(rule?.source_page)) ? Number(rule.source_page) : null,
        exact_source_text: deriveRuleExactSourceText(rule),
        confidence_score: deriveRuleConfidence(rule),
        extraction_status: deriveRuleExtractionStatus(rule),
        review_status: deriveRuleReviewStatus(rule),
        approval_status: deriveRuleApprovalStatus(rule, status),
        published_to_cam: Boolean(resolveRuleWorkflowState(rule, status).publishedToCam && rule.published_to_cam),
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
    if (rulePayloads.length > 0 && ruleSetId) {
      try {
        const ruleKeys = rulePayloads.map((p) => p.rule_key).filter(Boolean);
        if (ruleKeys.length > 0) {
          const { data: existing } = await supabase
            .from("lease_expense_rules")
            .select("rule_key, review_status, approval_status, approved_by, approved_at, published_to_cam, notes")
            .eq("rule_set_id", ruleSetId)
            .in("rule_key", ruleKeys);
          for (const row of existing || []) {
            preservedByKey.set(row.rule_key, row);
          }
        }
      } catch (err) {
        console.warn(`${tag} existing-rule pre-fetch skipped:`, err?.message || err);
      }
    }
    if (preservedByKey.size > 0) {
      let preservedApprovedCount = 0;
      for (const payload of rulePayloads) {
        const existing = preservedByKey.get(payload.rule_key);
        if (!existing) continue;
        if (existing.review_status === "approved" || existing.approval_status === "approved") {
          preservedApprovedCount += 1;
          payload.review_status = existing.review_status || payload.review_status;
          payload.approval_status = existing.approval_status || payload.approval_status;
          payload.approved_by = existing.approved_by ?? payload.approved_by;
          payload.approved_at = existing.approved_at ?? payload.approved_at;
          payload.published_to_cam = existing.published_to_cam ?? payload.published_to_cam;
          // Keep human-edited notes too if they exist
          if (existing.notes && !payload.notes) payload.notes = existing.notes;
        }
      }
      if (preservedApprovedCount > 0) {
        console.log(`[leaseExpenseRuleService] saveRuleSet preserved approval on ${preservedApprovedCount} existing rule(s)`);
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
        // same lease/extraction-version updates the SAME row instead of
        // creating a new one. The migration 20260519101000_lease_expense_
        // rules_rule_key_string.sql adds the matching UNIQUE index.
        const { data, error: ruleError } = await supabase
          .from("lease_expense_rules")
          .upsert(payloadsForUpsert, {
            onConflict: "rule_set_id,rule_key",
            ignoreDuplicates: false,
          })
          .select("*");
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
        console.warn(
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
        console.warn("[leaseExpenseRuleService] value persistence warning:", error);
      }

      try {
        await supabase.from("lease_expense_rule_clauses").delete().in("lease_expense_rule_id", savedRuleIds);
        if (clausePayloads.length > 0) {
          const { error: clausesError } = await supabase.from("lease_expense_rule_clauses").insert(clausePayloads);
          if (clausesError) throw clausesError;
        }
      } catch (error) {
        console.warn("[leaseExpenseRuleService] clause persistence warning:", error);
      }
    }

    const persisted = await this.loadRuleSet(lease.id);
    if (status === "approved") {
      try {
        await saveLeaseConfig(lease.id, buildLeaseConfigFromRules(lease, persisted.rules, categoriesById));
      } catch (error) {
        console.warn("[leaseExpenseRuleService] lease config sync warning:", error);
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
        console.warn("[leaseExpenseRuleService] category bootstrap fallback:", error?.message || error);
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

  getBillingTreatment(rule) {
    return deriveRuleBillingTreatment(rule);
  },

  canPublishRuleToCam(rule) {
    return getRuleValidation(rule).canPublishToCam;
  },

  async upsertRuleIntoCamSetup({ lease, rule, categoriesById = new Map() } = {}) {
    if (!lease?.id) throw new Error("Lease is required before publishing a rule to CAM.");
    if (!rule?.id) throw new Error("Rule is required before publishing to CAM.");

    const validation = getRuleValidation(rule);
    if (!validation.canPublishToCam) {
      throw new Error(validation.publishBlockers[0] || "Rule is not eligible for CAM publish.");
    }

    const { values } = await fetchLeaseConfig(lease.id);
    const nextLine = buildCamRuleLineItem(rule, lease, categoriesById);
    const existingLines = Array.isArray(values?.cam_rule_lines) ? values.cam_rule_lines : [];
    const remainingLines = existingLines.filter((line) => line?.lease_expense_rule_id !== rule.id && line?.rule_key !== rule.rule_key);
    const nextValues = {
      ...values,
      cam_applicable: true,
      allocation_method: values?.allocation_method || nextLine.allocation_basis || "",
      cam_rule_lines: [...remainingLines, nextLine],
    };

    const savedConfig = await saveLeaseConfig(lease.id, nextValues);
    return {
      config: savedConfig,
      camRuleLine: nextLine,
    };
  },

  normalizeRecoveryStatus,
};

export default leaseExpenseRuleService;
