import {
  firstPresent,
  normalizeCategoryKey,
  normalizeText,
} from "./leaseExpenseRuleParsers";

export function deriveRuleIncludedInBaseRent(rule) {
  return Boolean(
    rule?.included_in_base_rent ??
    rule?.included_in_rent ??
    /included/.test(normalizeText(rule?.lease_treatment))
  );
}

export function normalizeTriStateDecision(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "yes" : "no";
  const normalized = normalizeText(value);
  if (["yes", "true", "recoverable", "approved"].includes(normalized)) return "yes";
  if (["no", "false", "non_recoverable", "excluded"].includes(normalized)) return "no";
  if (["needs_review", "manual_review", "unknown", "unclear"].includes(normalized)) return "needs_review";
  if (["conditional", "shared", "maybe", "review"].includes(normalized)) return "conditional";
  return fallback;
}

export function isRecoverableLike(rule) {
  return ["yes", "conditional"].includes(normalizeTriStateDecision(rule?.recoverable_from_tenant));
}

export function isCamEligibleLike(rule) {
  return ["yes", "conditional"].includes(normalizeTriStateDecision(rule?.cam_eligible));
}

export function deriveRuleOperationalResponsibility(rule) {
  const explicit = normalizeText(firstPresent(rule?.operational_responsibility, rule?.responsibility));
  if (["landlord", "owner"].includes(explicit)) return "landlord";
  if (["tenant", "tenant_direct", "tenant_direct_contract"].includes(explicit)) return "tenant";
  if (["shared", "joint"].includes(explicit)) return "shared";
  if (deriveRuleIncludedInBaseRent(rule)) return "landlord";
  if (rule?.is_excluded) return "tenant";
  if (isRecoverableLike(rule) || deriveRuleRecoverableFromTenant(rule) === "conditional") return "landlord";
  return "unknown";
}

export function deriveRulePaymentTreatment(rule) {
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

export function deriveRuleRecoverableFromTenant(rule) {
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

export function deriveRuleCamEligible(rule) {
  const paymentTreatment = deriveRulePaymentTreatment(rule);
  const recoverable = deriveRuleRecoverableFromTenant(rule);

  if (deriveRuleIncludedInBaseRent(rule) || paymentTreatment === "included_in_base_rent") return "no";
  if (paymentTreatment === "tenant_direct_contract") return "no";
  if (recoverable === "no") return "no";
  if (recoverable === "conditional") return "conditional";

  const explicit = normalizeTriStateDecision(rule?.cam_eligible);
  if (explicit) {
    return explicit;
  }

  const categoryKey = normalizeCategoryKey(firstPresent(rule?.normalized_key, rule?.expense_subcategory, rule?.expense_category, rule?.category_name));

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
    return "yes";
  }

  return "conditional";
}
