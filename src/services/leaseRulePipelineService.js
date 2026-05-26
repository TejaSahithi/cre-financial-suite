import { supabase } from "@/services/supabaseClient";
import leaseExpenseRuleService from "./leaseExpenseRuleService";
import { resolveLeaseField } from "@/lib/leaseFieldResolver";

const VALID_EVIDENCE = (text) => {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  const invalid = ["manual_review", "tenant_recovery", "tenant_direct", "inferred", "default"];
  if (invalid.some(word => lower.includes(word))) return false;
  
  const unrelated = ["assignment", "notice address", "permitted use", "tenant improvement"];
  if (unrelated.some(word => lower.includes(word))) return false;

  return true;
};

const firstPresent = (...args) => args.find(a => a !== null && a !== undefined && a !== "");
const asNumber = (val) => {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === 'number') return val;
  const str = String(val).replace(/[^0-9.-]/g, '');
  if (!str) return null;
  const num = Number(str);
  return isNaN(num) ? null : num;
};

const normalizeKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const CATEGORY_ALIASES = new Map([
  ["cam", "common_area_maintenance"],
  ["common_area_maintenance", "common_area_maintenance"],
  ["operating_expenses", "operating_expenses"],
  ["property_tax", "real_estate_taxes"],
  ["property_taxes", "real_estate_taxes"],
  ["real_estate_tax", "real_estate_taxes"],
  ["real_estate_taxes", "real_estate_taxes"],
  ["taxes", "real_estate_taxes"],
  ["property_insurance", "property_insurance"],
  ["insurance", "property_insurance"],
  ["utilities", "utilities"],
  ["electricity", "electricity"],
  ["gas", "gas"],
  ["water", "water"],
  ["sewer", "sewer"],
  ["repairs_and_maintenance", "repairs_maintenance"],
  ["repair_and_maintenance", "repairs_maintenance"],
  ["repairs_maintenance", "repairs_maintenance"],
  ["maintenance", "repairs_maintenance"],
  ["janitorial", "janitorial"],
  ["trash", "trash_removal"],
  ["trash_removal", "trash_removal"],
  ["security", "security"],
  ["landscaping", "landscaping"],
  ["snow", "snow_removal"],
  ["snow_removal", "snow_removal"],
  ["parking", "parking"],
  ["admin_fee", "administrative_fees"],
  ["administrative_fee", "administrative_fees"],
  ["administrative_fees", "administrative_fees"],
  ["management_fee", "management_fees"],
  ["management_fees", "management_fees"],
  ["capital_expenditure", "capital_expenditures"],
  ["capital_expenditures", "capital_expenditures"],
  ["percentage_rent", "percentage_rent"],
  ["late_fee", "late_fees"],
  ["late_fees", "late_fees"],
  ["interest", "interest"],
  ["tenant_insurance", "tenant_insurance"],
  ["alterations", "alterations"],
  ["merchant_association_dues", "merchant_association_dues"],
  ["tenant_caused_damage", "tenant_caused_damage"],
  ["separately_metered_charges", "separately_metered_charges"],
  ["excess_usage", "excess_usage"],
  ["legal_enforcement_fees", "legal_enforcement_fees"],
]);

const CANONICAL_TO_LABEL = {
  common_area_maintenance: "Common Area Maintenance",
  operating_expenses: "Operating Expenses",
  real_estate_taxes: "Real Estate Taxes",
  property_insurance: "Property Insurance",
  utilities: "Utilities",
  electricity: "Electricity",
  gas: "Gas",
  water: "Water",
  sewer: "Sewer",
  repairs_maintenance: "Repairs & Maintenance",
  janitorial: "Janitorial",
  trash_removal: "Trash Removal",
  security: "Security",
  landscaping: "Landscaping",
  snow_removal: "Snow Removal",
  parking: "Parking",
  administrative_fees: "Administrative Fees",
  management_fees: "Management Fees",
  capital_expenditures: "Capital Expenditures",
  percentage_rent: "Percentage Rent",
  late_fees: "Late Fees",
  interest: "Interest",
  tenant_insurance: "Tenant Insurance",
  alterations: "Alterations",
  merchant_association_dues: "Merchant Association Dues",
  tenant_caused_damage: "Tenant Caused Damage",
  separately_metered_charges: "Separately Metered Charges",
  excess_usage: "Excess Usage",
  legal_enforcement_fees: "Legal / Enforcement Fees",
};

const COMMON_CAM_KEYS = new Set([
  "common_area_maintenance",
  "operating_expenses",
  "janitorial",
  "trash_removal",
  "security",
  "landscaping",
  "snow_removal",
  "parking",
]);

const DIRECT_UTILITY_KEYS = new Set(["utilities", "electricity", "gas", "water", "sewer", "separately_metered_charges", "excess_usage"]);
const NOT_CAM_KEYS = new Set(["percentage_rent", "late_fees", "interest", "tenant_insurance", "alterations", "merchant_association_dues"]);

function canonicalRuleKey(rule) {
  const raw = normalizeKey(firstPresent(
    rule?.normalized_key,
    rule?.expense_subcategory,
    rule?.subcategory_name,
    rule?.expense_category,
    rule?.category_name,
    rule?.category,
    rule?.key,
  ));
  return CATEGORY_ALIASES.get(raw) || raw;
}

function sectionRegex(number) {
  return new RegExp(`(?:^|[\\n\\r\\s])(?:section\\s*)?${number}(?:\\.\\d+)?\\s*[\\).:-]?\\s`, "i");
}

function getSectionText(sourceText, number) {
  const text = String(sourceText || "");
  if (!text) return "";
  const startMatch = sectionRegex(number).exec(text);
  if (!startMatch) return "";
  const start = Math.max(0, startMatch.index);
  const nextMatch = new RegExp(`(?:^|[\\n\\r\\s])(?:section\\s*)?${number + 1}(?:\\.\\d+)?\\s*[\\).:-]?\\s`, "i").exec(text.slice(start + 20));
  const end = nextMatch ? start + 20 + nextMatch.index : Math.min(text.length, start + 3500);
  return text.slice(start, end).trim();
}

function compactSnippet(text, maxLength = 1200) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

function sectionIncludes(section, patterns = []) {
  const text = String(section || "");
  return patterns.some((pattern) => pattern.test(text));
}

function downgradeUnsupportedRule(rule, reason) {
  return {
    ...rule,
    recoverable_from_tenant: "needs_review",
    cam_eligible: "needs_review",
    payment_treatment: "not_applicable",
    recovery_method: "manual_review",
    allocation_basis: null,
    is_recoverable: false,
    is_excluded: false,
    published_to_cam: false,
    review_status: "needs_review",
    approval_status: "draft",
    row_status: "needs_review",
    extraction_status: "weak_evidence",
    confidence_score: Math.min(Number(rule?.confidence_score || rule?.confidence || 0.5), 0.55),
    notes: reason,
  };
}

function notFoundRule(rule, reason) {
  return {
    ...rule,
    recoverable_from_tenant: "needs_review",
    cam_eligible: "needs_review",
    payment_treatment: "not_applicable",
    recovery_method: "not_applicable",
    allocation_basis: null,
    is_recoverable: false,
    is_excluded: false,
    published_to_cam: false,
    exact_source_text: null,
    source_clause: null,
    review_status: "needs_review",
    approval_status: "draft",
    row_status: "not_mentioned",
    extraction_status: "not_found",
    confidence_score: Math.min(Number(rule?.confidence_score || rule?.confidence || 0.5), 0.45),
    mentioned_in_lease: false,
    notes: reason,
  };
}

function applyLeaseEvidenceRules(rule, sourceText) {
  const canonicalKey = canonicalRuleKey(rule);
  const normalizedRule = {
    ...rule,
    normalized_key: canonicalKey,
    expense_category: CANONICAL_TO_LABEL[canonicalKey] || rule?.expense_category || rule?.category_name || canonicalKey,
    category_name: CANONICAL_TO_LABEL[canonicalKey] || rule?.category_name || rule?.expense_category || canonicalKey,
  };

  const section3 = getSectionText(sourceText, 3);
  const section4 = getSectionText(sourceText, 4);
  const section5 = getSectionText(sourceText, 5);
  const section8 = getSectionText(sourceText, 8);
  const section9 = getSectionText(sourceText, 9);
  const section10 = getSectionText(sourceText, 10);
  const section11 = getSectionText(sourceText, 11);
  const section12 = getSectionText(sourceText, 12);
  const section13 = getSectionText(sourceText, 13);
  const section14 = getSectionText(sourceText, 14);
  const section17 = getSectionText(sourceText, 17);
  const existingEvidence = String(firstPresent(rule?.exact_source_text, rule?.source_clause, rule?.source_text, rule?.source) || "");
  const existingLower = existingEvidence.toLowerCase();

  const camEvidence = section3 || existingEvidence;
  const camSectionSupports =
    section3 &&
    sectionIncludes(section3, [/common\s+area\s+maintenance/i, /\bcam\b/i, /operating\s+expenses?/i]);

  if (canonicalKey === "common_area_maintenance") {
    if (!camSectionSupports) return downgradeUnsupportedRule(normalizedRule, "CAM Costs require the Section 3 CAM clause as evidence.");
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(section3),
      source_clause: compactSnippet(section3),
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      payment_treatment: "reimbursable",
      recovery_method: "pro_rata_share",
      allocation_basis: "pro_rata_share",
      included_in_base_rent: false,
      is_recoverable: true,
      is_excluded: false,
      row_status: "mapped",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.9),
      notes: "Mapped to Section 3 CAM clause.",
    };
  }

  if (canonicalKey === "real_estate_taxes") {
    const evidence = [section4, section10].filter(Boolean).join(" ");
    if (!sectionIncludes(evidence, [/tax(?:es)?/i, /assessment/i])) return downgradeUnsupportedRule(normalizedRule, "Real Estate Taxes require Sections 4/10 tax evidence.");
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(evidence),
      source_clause: compactSnippet(evidence),
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      payment_treatment: "reimbursable",
      recovery_method: "base_year",
      allocation_basis: "pro_rata_share",
      base_year: firstPresent(rule?.base_year, "2026"),
      has_base_year: true,
      included_in_base_rent: false,
      is_recoverable: true,
      is_excluded: false,
      row_status: "mapped",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.9),
      notes: "Mapped to Sections 4 and 10 tax recovery/base-year language.",
    };
  }

  if (canonicalKey === "property_insurance") {
    if (!sectionIncludes(section5, [/insurance/i])) return downgradeUnsupportedRule(normalizedRule, "Property Insurance requires Section 5 insurance evidence.");
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(section5),
      source_clause: compactSnippet(section5),
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      payment_treatment: "reimbursable",
      recovery_method: "pro_rata_share",
      allocation_basis: "pro_rata_share",
      reconciliation_required: true,
      reconciliation_frequency: "annual",
      included_in_base_rent: false,
      is_recoverable: true,
      is_excluded: false,
      row_status: "mapped",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.9),
      notes: "Mapped to Section 5 property insurance recovery language.",
    };
  }

  if (DIRECT_UTILITY_KEYS.has(canonicalKey)) {
    const utilityEvidence = existingEvidence || section3;
    const isTenantDirect =
      sectionIncludes(utilityEvidence, [/separately\s+metered/i, /separate\s+meter/i, /premises\s+utilities/i, /tenant\s+shall\s+(?:pay|contract|maintain)/i, /direct(?:ly)?\s+to\s+(?:the\s+)?utility/i]) ||
      canonicalKey !== "utilities";
    const commonAreaUtility = camSectionSupports && sectionIncludes(section3, [/common\s+area\s+utilit/i, /parking\s+lot\s+lighting/i, /exterior\s+lighting/i]);
    if (isTenantDirect && !commonAreaUtility) {
      return {
        ...normalizedRule,
        exact_source_text: compactSnippet(utilityEvidence),
        source_clause: compactSnippet(utilityEvidence),
        recoverable_from_tenant: "no",
        cam_eligible: "no",
        payment_treatment: "tenant_direct_contract",
        recovery_method: "tenant_direct_contract",
        allocation_basis: "direct",
        is_recoverable: false,
        is_excluded: true,
        row_status: "mapped",
        extraction_status: "extracted",
        confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.85),
        notes: "Separately metered or premises utilities are tenant-direct and not common CAM.",
      };
    }
    if (commonAreaUtility) {
      return {
        ...normalizedRule,
        exact_source_text: compactSnippet(section3),
        source_clause: compactSnippet(section3),
        recoverable_from_tenant: "yes",
        cam_eligible: "yes",
        payment_treatment: "reimbursable",
        recovery_method: "pro_rata_share",
        allocation_basis: "pro_rata_share",
        is_recoverable: true,
        is_excluded: false,
        row_status: "mapped",
        extraction_status: "extracted",
        confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.85),
        notes: "Common-area utilities are recoverable through Section 3 CAM.",
      };
    }
    return downgradeUnsupportedRule(normalizedRule, "Utility evidence does not clearly distinguish tenant-direct utilities from common-area CAM utilities.");
  }

  if (COMMON_CAM_KEYS.has(canonicalKey)) {
    const aliases = {
      operating_expenses: [/operating\s+expenses?/i],
      janitorial: [/janitorial/i, /cleaning/i],
      trash_removal: [/trash/i, /refuse/i, /garbage/i],
      security: [/security/i],
      landscaping: [/landscap/i],
      snow_removal: [/snow/i],
      parking: [/parking/i],
    }[canonicalKey] || [];
    if (!camSectionSupports || (aliases.length > 0 && !sectionIncludes(section3, aliases))) {
      return downgradeUnsupportedRule(normalizedRule, `${CANONICAL_TO_LABEL[canonicalKey] || canonicalKey} requires support in the Section 3 CAM clause.`);
    }
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(section3),
      source_clause: compactSnippet(section3),
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      payment_treatment: "reimbursable",
      recovery_method: "pro_rata_share",
      allocation_basis: "pro_rata_share",
      is_recoverable: true,
      is_excluded: false,
      is_controllable: canonicalKey === "snow_removal" ? false : rule?.is_controllable,
      is_subject_to_cap: canonicalKey === "snow_removal" && sectionIncludes(section9, [/snow/i, /non[-\s]?controllable/i]) ? false : rule?.is_subject_to_cap,
      row_status: "mapped",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.88),
      notes: canonicalKey === "snow_removal"
        ? "Snow removal is recoverable under Section 3 and excluded/non-controllable for the Section 9 cap."
        : `Mapped to Section 3 CAM clause for ${CANONICAL_TO_LABEL[canonicalKey] || canonicalKey}.`,
    };
  }

  if (canonicalKey === "repairs_maintenance") {
    if (sectionIncludes(section11 || existingEvidence, [/capital/i, /structural/i, /major\s+replacement/i, /useful\s+life/i])) {
      return {
        ...normalizedRule,
        exact_source_text: compactSnippet(section11 || existingEvidence),
        source_clause: compactSnippet(section11 || existingEvidence),
        recoverable_from_tenant: "conditional",
        cam_eligible: "conditional",
        payment_treatment: "reimbursable",
        recovery_method: "amortized_capital",
        allocation_basis: "pro_rata_share",
        is_recoverable: false,
        is_excluded: false,
        row_status: "needs_review",
        extraction_status: "extracted",
        confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.8),
        notes: "Capital/structural repairs require legal-required or cost-saving amortization review under Section 11.",
      };
    }
    if (camSectionSupports && sectionIncludes(section3, [/repair/i, /maintenance/i])) {
      return {
        ...normalizedRule,
        exact_source_text: compactSnippet(section3),
        source_clause: compactSnippet(section3),
        recoverable_from_tenant: "yes",
        cam_eligible: "yes",
        payment_treatment: "reimbursable",
        recovery_method: "pro_rata_share",
        allocation_basis: "pro_rata_share",
        is_recoverable: true,
        is_excluded: false,
        row_status: "mapped",
        extraction_status: "extracted",
        confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.88),
        notes: "Routine/common-area maintenance is recoverable through Section 3 CAM.",
      };
    }
    return downgradeUnsupportedRule(normalizedRule, "Repairs & Maintenance evidence does not clearly identify common-area routine maintenance.");
  }

  if (canonicalKey === "administrative_fees") {
    if (!sectionIncludes(section8, [/admin/i, /10\s*%/i])) return downgradeUnsupportedRule(normalizedRule, "Administrative Fee requires Section 8 evidence.");
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(section8),
      source_clause: compactSnippet(section8),
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      payment_treatment: "reimbursable",
      recovery_method: "pro_rata_share",
      allocation_basis: "pro_rata_share",
      admin_fee_applicable: true,
      admin_fee_percent: 10,
      is_recoverable: true,
      is_excluded: false,
      row_status: "mapped",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.9),
      notes: "Section 8 supports a 10% administrative fee; base excludes taxes and insurance.",
    };
  }

  if (canonicalKey === "management_fees") {
    if (!sectionIncludes(section8 || existingEvidence, [/management\s+fee/i, /written\s+tenant\s+approval/i, /required\s+by\s+law/i])) {
      return downgradeUnsupportedRule(normalizedRule, "Management Fee requires Section 8 support.");
    }
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(section8 || existingEvidence),
      source_clause: compactSnippet(section8 || existingEvidence),
      recoverable_from_tenant: "conditional",
      cam_eligible: "conditional",
      payment_treatment: "not_applicable",
      recovery_method: "not_applicable",
      allocation_basis: null,
      is_recoverable: false,
      is_excluded: false,
      row_status: "needs_review",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.8),
      notes: "Management fee is not included in CAM unless required by law or approved in writing by tenant.",
    };
  }

  if (canonicalKey === "capital_expenditures") {
    if (!sectionIncludes(section11 || existingEvidence, [/capital/i, /useful\s+life/i, /8\s*%/i, /cost[-\s]?saving/i, /legally\s+required/i])) {
      return downgradeUnsupportedRule(normalizedRule, "Capital Expenditures require Section 11 evidence.");
    }
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(section11 || existingEvidence),
      source_clause: compactSnippet(section11 || existingEvidence),
      recoverable_from_tenant: "conditional",
      cam_eligible: "conditional",
      payment_treatment: "reimbursable",
      recovery_method: "amortized_capital",
      allocation_basis: "pro_rata_share",
      is_recoverable: false,
      is_excluded: false,
      row_status: "needs_review",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.85),
      notes: "Section 11 allows only legally required or cost-saving capital improvements amortized over useful life with 8% interest.",
    };
  }

  if (section12 && sectionIncludes(section12, [/mortgage\s+interest/i, /depreciation/i, /leasing\s+commission/i, /marketing/i, /tenant\s+improvement/i, /\bti\s+allowance/i, /fines/i, /income\s+tax/i, /franchise\s+tax/i, /political/i, /tenant[-\s]?dispute/i, /another\s+tenant/i])) {
    const exclusionKeys = new Set(["tenant_improvements", "legal_enforcement_fees"]);
    if (exclusionKeys.has(canonicalKey) || existingLower.includes("excluded")) {
      return {
        ...normalizedRule,
        exact_source_text: compactSnippet(section12),
        source_clause: compactSnippet(section12),
        recoverable_from_tenant: "no",
        cam_eligible: "no",
        payment_treatment: "not_applicable",
        recovery_method: "not_applicable",
        allocation_basis: null,
        is_recoverable: false,
        is_excluded: true,
        row_status: "mapped",
        extraction_status: "extracted",
        confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.88),
        notes: "Explicitly excluded by Section 12.",
      };
    }
  }

  if (canonicalKey === "tenant_caused_damage") {
    const evidence = section13 || existingEvidence;
    if (!sectionIncludes(evidence, [/tenant[-\s]?specific/i, /storefront\s+sign/i, /grease\s+trap/i, /interior\s+janitorial/i, /private\s+security/i, /direct\s+billed/i])) {
      return downgradeUnsupportedRule(normalizedRule, "Tenant-specific charges require Section 13 evidence.");
    }
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(evidence),
      source_clause: compactSnippet(evidence),
      recoverable_from_tenant: "no",
      cam_eligible: "no",
      payment_treatment: "tenant_direct_contract",
      recovery_method: "tenant_direct_contract",
      allocation_basis: "direct",
      is_recoverable: false,
      is_excluded: true,
      row_status: "mapped",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.85),
      notes: "Tenant-specific charges are direct billed and excluded from common CAM.",
    };
  }

  if (canonicalKey === "percentage_rent") {
    if (!sectionIncludes(section17 || existingEvidence, [/percentage\s+rent/i])) return notFoundRule(normalizedRule, "Percentage Rent is not supported by a specific lease expense clause.");
    return {
      ...normalizedRule,
      exact_source_text: compactSnippet(section17 || existingEvidence),
      source_clause: compactSnippet(section17 || existingEvidence),
      recoverable_from_tenant: "no",
      cam_eligible: "no",
      payment_treatment: "not_applicable",
      recovery_method: "not_applicable",
      allocation_basis: null,
      is_recoverable: false,
      is_excluded: true,
      row_status: "mapped",
      extraction_status: "extracted",
      confidence_score: Math.max(Number(rule?.confidence_score || 0), 0.85),
      notes: "Section 17 percentage rent is rent, not CAM or operating expense recovery.",
    };
  }

  if (NOT_CAM_KEYS.has(canonicalKey)) {
    return notFoundRule(normalizedRule, `${CANONICAL_TO_LABEL[canonicalKey] || canonicalKey} is not a CAM expense rule without a specific supporting lease expense clause.`);
  }

  if (section14 && sectionIncludes(section14, [/vacant/i, /denominator/i, /landlord\s+absorbs/i, /gross[-\s]?up/i])) {
    return {
      ...normalizedRule,
      gross_up_applicable: false,
      gross_up_allowed: false,
      notes: firstPresent(rule?.notes, "Section 14: vacant units remain in denominator; landlord absorbs vacant share; gross-up not permitted."),
    };
  }

  return normalizedRule;
}

// ... Wait, I should fetch the lease first
export const leaseRulePipelineService = {
  async generateLeaseExpenseRulesForLease({ leaseId, force = false, source = "manual_extract" }) {
    console.log("[NEW PIPELINE CALLED]", { leaseId, force, source });
    if (!leaseId) throw new Error("leaseId is required");

    let diagnostics = {
      leaseId,
      documentType: "original_lease",
      sourceFileId: null,
      sourceTextLength: 0,
      workflowRulesCount: 0,
      structuredTermRulesCount: 0,
      deterministicRulesCount: 0,
      textFallbackRulesCount: 0,
      llmRulesCount: 0,
      mergedRulesCount: 0,
      persistedRulesCount: 0,
      weakEvidenceCount: 0,
      skippedReasons: null
    };

    // 1. Fetch lease
    const { data: lease, error: leaseErr } = await supabase
      .from("leases")
      .select("*")
      .eq("id", leaseId)
      .maybeSingle();

    if (leaseErr) {
      console.error("[PIPELINE ERROR] Lease fetch failed:", leaseErr);
      throw leaseErr;
    }
    if (!lease) {
      diagnostics.skippedReasons = "Lease not found";
      return diagnostics;
    }

    // 2. Side-load related rows separately only if IDs exist
    if (lease.unit_id) {
      const { data: unit, error: unitErr } = await supabase.from("units").select("*").eq("id", lease.unit_id).maybeSingle();
      if (unitErr) console.warn("[PIPELINE SIDELOAD WARNING] unit fetch failed:", unitErr);
      lease.unit = unit || null;
    }
    if (lease.property_id) {
      const { data: property, error: propErr } = await supabase.from("properties").select("*").eq("id", lease.property_id).maybeSingle();
      if (propErr) console.warn("[PIPELINE SIDELOAD WARNING] property fetch failed:", propErr);
      lease.property = property || null;
    }
    if (lease.building_id) {
      const { data: building, error: buildErr } = await supabase.from("buildings").select("*").eq("id", lease.building_id).maybeSingle();
      if (buildErr) console.warn("[PIPELINE SIDELOAD WARNING] building fetch failed:", buildErr);
      lease.building = building || null;
    }

    // Populate tenant_id and org_id
    let tenantId = lease.tenant_id || lease.primary_tenant_id || lease.unit?.tenant_id || null;
    if (!tenantId && lease.tenant_name) {
      const { data: t } = await supabase.from("tenants").select("id").ilike("name", lease.tenant_name).maybeSingle();
      if (t) tenantId = t.id;
    }
    lease.tenant_id = tenantId;
    lease.org_id = lease.org_id || lease.property?.org_id || lease.building?.org_id || null;

    if (leaseErr || !lease) {
      diagnostics.skippedReasons = "Lease not found";
      return diagnostics;
    }

    // 2. Resolve Source File ID
    let fileId = lease.source_file_id || lease.uploaded_file_id || lease.file_id || lease?.extraction_data?.source_file_id;
    if (!fileId) {
      const { data: docLink } = await supabase
        .from("document_links")
        .select("file_id, uploaded_file_id")
        .eq("entity_id", leaseId)
        .eq("entity_type", "lease")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (docLink) fileId = docLink.uploaded_file_id || docLink.file_id;
    }
    diagnostics.sourceFileId = fileId;

    // 3. Resolve Text
    let sourceText = "";
    let uploadedFile = null;
    if (fileId) {
      const { data: file } = await supabase
        .from("uploaded_files")
        .select("normalized_output, parsed_data, docling_raw, reviewed_output, ui_review_payload, is_scanned, file_type")
        .eq("id", fileId)
        .maybeSingle();
      uploadedFile = file;

      if (file) {
        const candidates = [
          file?.docling_raw?.full_text,
          file?.docling_raw?.markdown,
          file?.docling_raw?.text,
          file?.docling_raw?.body,
          file?.normalized_output?.raw_text,
          file?.normalized_output?.text,
          file?.parsed_data?.full_text,
          file?.parsed_data?.raw_text,
          file?.parsed_data?.text,
          file?.reviewed_output,
          file?.ui_review_payload,
          lease?.extraction_data?.workflow_output,
          lease?.extraction_data?.abstract,
          lease?.extracted_text
        ];

        for (const c of candidates) {
          if (c && typeof c === 'string' && c.trim()) {
            sourceText = c.trim();
            break;
          } else if (c && typeof c === 'object') {
             // If it's an object, stringify to check if it has useful content?
             // Actually, reviewed_output might be an object. We'll stringify it just in case if it has text inside.
             const s = JSON.stringify(c);
             if (s.length > 50) {
                 sourceText = s;
                 break;
             }
          }
        }

        // OCR Fallback for Scanned PDF
        if (!sourceText && (file.is_scanned || String(file.file_type).toLowerCase().includes('pdf') || String(file.file_type).toLowerCase().includes('image'))) {
          try {
            console.log("Triggering OCR Vision Fallback...");
            const { data: ocrData } = await supabase.functions.invoke("ocr-vision-extract", { body: { fileId } });
            if (ocrData?.text) {
              sourceText = ocrData.text;
              await supabase.from("uploaded_files").update({ 
                parsed_data: { ...(file.parsed_data || {}), full_text: sourceText } 
              }).eq("id", fileId);
            }
          } catch (ocrErr) {
             console.warn("OCR fallback failed:", ocrErr);
          }
        }
      }
    }
    
    if (!sourceText && lease?.extracted_text) {
      sourceText = lease.extracted_text;
    }
    
    diagnostics.sourceTextLength = sourceText?.length || 0;

    // 4. Document Type Detection
    const leaseNameLower = String(lease.name || lease.lease_name || "").toLowerCase();
    const isAssignment = leaseNameLower.includes("assignment");
    const isAmendment = leaseNameLower.includes("amend");
    if (isAssignment) diagnostics.documentType = "assignment";
    else if (isAmendment) diagnostics.documentType = "amendment";
    else if (leaseNameLower.includes("renewal")) diagnostics.documentType = "renewal";
    else if (leaseNameLower.includes("estoppel")) diagnostics.documentType = "estoppel";
    else if (leaseNameLower.includes("exhibit")) diagnostics.documentType = "exhibit";



    console.log("[PIPELINE INPUT]", {
      leaseId,
      sourceFileId: diagnostics.sourceFileId,
      sourceTextLength: diagnostics.sourceTextLength,
      documentType: diagnostics.documentType,
      leaseType: lease.lease_type,
      hasExtractionData: !!lease?.extraction_data,
      extractionKeys: Object.keys(lease?.extraction_data || {})
    });

    // Force reruns should only replace unresolved extraction output. Human-approved
    // rows are the durable approval record and must survive regeneration.
    if (force) {
      console.log("[FORCE DELETE UNRESOLVED RULES]", { leaseId, force });
      const { data: existingRules, error: existingRulesError } = await supabase
        .from("lease_expense_rules")
        .select("id, review_status, approval_status")
        .eq("lease_id", leaseId);
      if (existingRulesError) {
        console.log("[FORCE SELECT OLD RULES FAILED]", { existingRulesError });
      }
      const deletableIds = (existingRules || [])
        .filter((rule) => {
          const reviewStatus = String(rule.review_status || "").toLowerCase();
          const approvalStatus = String(rule.approval_status || "").toLowerCase();
          return !(reviewStatus === "approved" && approvalStatus === "approved");
        })
        .map((rule) => rule.id)
        .filter(Boolean);
      const { data: deletedData, error: deleteError } = deletableIds.length > 0
        ? await supabase.from("lease_expense_rules").delete().in("id", deletableIds).select("*")
        : { data: [], error: null };
      console.log("[DELETE UNRESOLVED RESULT]", { deleted: deletedData?.length || 0, deleteError });
      
      const { count: postDeleteCount, error: countError } = await supabase.from("lease_expense_rules").select("*", { count: "exact", head: true }).eq("lease_id", leaseId);
      console.log("[POST DELETE RULE COUNT]", { postDeleteCount, countError });
    }

    // 5. Collect Candidates
    const candidates = [];

    // 5.a Workflow Output
    let workflowRules = [];
    if (Array.isArray(lease?.extraction_data?.workflow_output?.expense_rules)) {
      workflowRules = lease.extraction_data.workflow_output.expense_rules;
    } else if (Array.isArray(lease?.extraction_data?.expenses)) {
      workflowRules = lease.extraction_data.expenses;
    } else if (Array.isArray(lease?.extraction_data?.rules)) {
      workflowRules = lease.extraction_data.rules;
    }
    diagnostics.workflowRulesCount = workflowRules.length;
    workflowRules.forEach((r, i) => candidates.push(this.mapWorkflowRule(r, i, lease.id)));

    // 5.b Structured Term Rules (Resolver)
    const structuredRules = this.buildStructuredRules(lease, sourceText);
    diagnostics.structuredTermRulesCount = structuredRules.length;
    candidates.push(...structuredRules);

    // 5.c Deterministic Templates
    const templateRules = this.buildTemplateRules(lease, sourceText);
    diagnostics.deterministicRulesCount = templateRules.length;
    candidates.push(...templateRules);

    // 5.d Text Fallback
    const textRules = sourceText ? leaseExpenseRuleService.buildTextFallbackRules(sourceText) : [];
    diagnostics.textFallbackRulesCount = textRules.length;
    textRules.forEach(r => candidates.push({ ...r, source_type: "text_fallback" }));

    // 5.e LLM Extraction
    let llmRules = [];
    if (sourceText && force) {
       try {
         const { data: llmData, error: llmErr } = await supabase.functions.invoke("extract-lease-expense-rules", { body: { text: sourceText } });
         if (llmErr) {
            console.error("[LLM EXTRACTION FAILED]", llmErr);
         } else if (llmData?.rules) {
            llmRules = llmData.rules;
         }
       } catch (err) {
         console.error("[LLM EXTRACTION CATCH ERROR]", err);
       }
    }
    diagnostics.llmRulesCount = llmRules.length;
    llmRules.forEach(r => candidates.push(this.mapLlmRule(r, lease.id)));

    // 6. Merge, Score, Dedupe
    const merged = this.mergeAndScoreCandidates(candidates);
    diagnostics.mergedRulesCount = merged.length;

    console.log("[PIPELINE CANDIDATES]", {
      workflowRulesCount: diagnostics.workflowRulesCount,
      structuredTermRulesCount: diagnostics.structuredTermRulesCount,
      deterministicRulesCount: diagnostics.deterministicRulesCount,
      textFallbackRulesCount: diagnostics.textFallbackRulesCount,
      llmRulesCount: diagnostics.llmRulesCount,
      mergedRulesCount: diagnostics.mergedRulesCount
    });

    if (diagnostics.mergedRulesCount === 0) {
      throw new Error("NEW PIPELINE GENERATED ZERO RULES");
    }

    // 7. Evidence Validation & Save
    const finalRules = merged.map(rule => {
      let r = applyLeaseEvidenceRules({ ...rule }, sourceText);
      let conf = r.confidence_score || r.confidence || 0.8;
      let valid = VALID_EVIDENCE(r.exact_source_text);
      if (!valid) {
        // If evidence is invalid, force weak evidence and need review
        if (r.extraction_status !== "not_found") r.exact_source_text = null;
        r.confidence_score = Math.min(conf, 0.50);
        r.review_status = "needs_review";
        r.approval_status = "draft";
        r.extraction_status = r.extraction_status === "not_found" ? "not_found" : "weak_evidence";
        r.published_to_cam = false;
        diagnostics.weakEvidenceCount++;
      } else if (r.confidence_score <= 0.55) {
        r.review_status = "needs_review";
        r.approval_status = "draft";
        r.extraction_status = r.exact_source_text ? "weak_evidence" : "inferred";
        r.published_to_cam = false;
        diagnostics.weakEvidenceCount++;
      }

      // Generate rule_type if missing
      if (!r.rule_type) {
         if (r.is_excluded || r.payment_treatment === "not_applicable") r.rule_type = "excluded";
         else if (r.payment_treatment === "tenant_direct_contract") r.rule_type = "tenant_direct";
         else if (r.included_in_base_rent === true || r.included_in_base_rent === "yes") r.rule_type = "full_service_included";
         else if (r.has_base_year || r.recovery_method === "base_year") r.rule_type = "modified_gross_base_year";
         else if (r.recoverable_from_tenant === "conditional") r.rule_type = "conditional_recovery";
         else if (r.recoverable_from_tenant === "yes") r.rule_type = "nnn_recoverable";
         else r.rule_type = "additional_rent";
      }
      // Set rule_key explicitly so saveRuleSet uses it instead of regenerating
      r.rule_key = `${lease.id}_${r.rule_type}_${r.normalized_key}_${r.source_field_key || 'workflow'}`;
      
      r.extraction_version = "lease_rule_pipeline_v3_evidence_aligned";
      r.generation_source = r.generation_source === "template_checklist" ? "template_checklist" : "lease_rule_pipeline_v3_evidence_aligned";

      return r;
    }).filter(r => r.normalized_key !== "structured_terms"); // Filter out the dummy row if it wasn't merged away

    // Diagnostics Payload Output
    if (finalRules.length > 0) {
      console.log(`[FINAL PAYLOAD BEFORE SAVE] Lease ${leaseId}:`);
      console.table(finalRules.map(p => ({
        lease_id: lease.id,
        rule_key: p.rule_key,
        rule_type: p.rule_type,
        expense_category: p.expense_category,
        tenant_share_percent: p.tenant_share_percent,
        estimated_annual_amount: p.estimated_annual_amount,
        estimated_monthly_amount: p.estimated_monthly_amount,
        admin_fee_percent: p.admin_fee_percent,
        gross_up_percent: p.gross_up_percent,
        cap_percent: p.cap_percent,
        extraction_version: p.extraction_version,
        generation_source: p.generation_source
      })));
    }

    const saved = await leaseExpenseRuleService.saveRuleSet({
      lease,
      rules: finalRules,
      status: "draft",
      createdFrom: source,
      categories: []
    });

    const { count, error: countError } = await supabase
      .from("lease_expense_rules")
      .select("id", { count: "exact", head: true })
      .eq("lease_id", leaseId);

    console.log("[POST UPSERT RULE COUNT]", { leaseId, count, countError });

    diagnostics.persistedRulesCount = saved?.rules?.length || 0;

    return diagnostics;
  },

  mapWorkflowRule(rule, index, leaseId) {
    // Basic mapping, similar to buildFallbackRulesFromWorkflow
    return {
      ...rule,
      lease_id: leaseId,
      source_type: "workflow_output",
      confidence_score: rule.confidence || 0.9,
      expense_category: rule.expense_category || rule.category || `rule_${index}`,
      normalized_key: String(rule.expense_category || `rule_${index}`).toLowerCase().replace(/\s+/g, '_')
    };
  },

  buildStructuredRules(lease, sourceText = "") {
    const rules = [];
    
    // Extract base structured terms using field resolver
    const resolve = (key) => {
      const res = resolveLeaseField(lease, key, { mode: "canonical" });
      return res?.value ?? null;
    };

    const textMatcher = (regex, processor = asNumber) => {
      const match = typeof sourceText === 'string' ? sourceText.match(regex) : null;
      return match ? processor(match[1]) : null;
    };

    const tenantShare = asNumber(resolve("tenant_share_percent") || resolve("pro_rata_share")) 
      || textMatcher(/tenant'?s\s+pro\s*rata\s+share\s+(?:shall\s+be\s+)?([0-9.]+)\s*%/i)
      || textMatcher(/([0-9.]+)\s*%\s*(?:of|as)\s*(?:tenant'?s)?\s*pro\s*rata\s+share/i);
      
    const estimatedAnnual = asNumber(resolve("estimated_annual_amount") || resolve("cam_estimate_annual"))
      || textMatcher(/estimated?\s+annual\s+(?:amount|cam|expenses?)[\s:]+\$?([0-9,.]+)/i, (val) => asNumber(val.replace(/,/g, '')));
      
    const estimatedMonthly = asNumber(resolve("estimated_monthly_amount") || resolve("cam_estimate_monthly"))
      || textMatcher(/estimated?\s+monthly\s+(?:amount|cam|expenses?)[\s:]+\$?([0-9,.]+)/i, (val) => asNumber(val.replace(/,/g, '')))
      || (estimatedAnnual ? parseFloat((estimatedAnnual / 12).toFixed(2)) : null);
      
    const adminFee = asNumber(resolve("admin_fee_percent") || resolve("administrative_fee"))
      || textMatcher(/administrative\s+fee\s+(?:equal\s+to\s+|of\s+)?([0-9.]+)\s*%/i);
      
    const mgmtFee = asNumber(resolve("management_fee_percent") || resolve("management_fee"))
      || textMatcher(/management\s+fee\s+(?:equal\s+to\s+|of\s+)?([0-9.]+)\s*%/i);
      
    const grossUp = asNumber(resolve("gross_up_percent") || resolve("gross_up"))
      || textMatcher(/gross[- ]up\s+(?:to\s+)?([0-9.]+)\s*%/i);
      
    const capPercent = asNumber(resolve("cap_percent") || resolve("expense_cap"))
      || textMatcher(/shall\s+not\s+increase\s+by\s+more\s+than\s+([0-9.]+)\s*%/i)
      || textMatcher(/cap(?:ped)?\s+at\s+([0-9.]+)\s*%/i);
      
    const capType = resolve("cap_type");
    const reconciliation = resolve("reconciliation_required") || resolve("cam_reconciliation");
    
    const baseYear = resolve("base_year") || resolve("expense_base_year");
    const opExBase = asNumber(resolve("operating_expense_base_amount"));
    const taxBase = asNumber(resolve("tax_base_amount"));
    const insBase = asNumber(resolve("insurance_base_amount"));

    // If we have these values, we should append them to all structured rules or create a dummy rule 
    // that the merger will merge into other rules.
    // Instead of creating a dummy rule, let's create a generic "structured_terms" rule that has these fields.
    // When merging, these fields will enrich the other rules.
    const structuredRule = {
      expense_category: "structured_terms",
      normalized_key: "structured_terms",
      source_type: "structured",
      confidence_score: 0.95,
      tenant_share_percent: tenantShare,
      estimated_annual_amount: estimatedAnnual,
      estimated_monthly_amount: estimatedMonthly,
      admin_fee_percent: adminFee,
      admin_fee_applicable: adminFee != null ? true : undefined,
      management_fee_percent: mgmtFee,
      gross_up_percent: grossUp,
      gross_up_applicable: grossUp != null ? true : undefined,
      cap_percent: capPercent,
      cap_type: capType,
      is_subject_to_cap: (capPercent != null || capType != null) ? true : undefined,
      reconciliation_required: reconciliation === "yes" || reconciliation === true,
      base_year: baseYear,
      base_year_amount: opExBase,
      tax_base_amount: taxBase,
      insurance_base_amount: insBase
    };

    rules.push(structuredRule);
    return rules;
  },

  buildTemplateRules(lease, sourceText = "") {
    const rules = [];
    const leaseType = String(lease.lease_type || lease.abstract_snapshot?.lease_type || "").toLowerCase().trim();
    
    const leaseText = JSON.stringify(lease.extraction_data || {}) + " " + sourceText;
    const textLower = leaseText.toLowerCase();
    
    const isNnn = leaseType.includes("nnn") || leaseType.includes("triple") || leaseType.includes("net")
      || textLower.includes("triple net") || textLower.includes("nnn") 
      || textLower.includes("tenant's pro rata share") || textLower.includes("recoverable common area maintenance")
      || textLower.includes("cam reimbursements") || textLower.includes("tax reimbursements") || textLower.includes("insurance reimbursements");

    if (leaseType.includes("full") || leaseType.includes("gross")) {
       // A. Full Service
       rules.push(this.makeTemplateRule("utilities", true, "no", "no"));
       rules.push(this.makeTemplateRule("janitorial", true, "no", "no"));
       rules.push(this.makeTemplateRule("property tax", true, "no", "no"));
       rules.push(this.makeTemplateRule("property insurance", true, "no", "no"));
       rules.push(this.makeTemplateRule("maintenance", true, "no", "no"));
       rules.push(this.makeTemplateRule("excess utilities", false, "conditional", "conditional"));
       rules.push(this.makeTemplateRule("tenant insurance", false, "tenant_direct", "no", "tenant_direct_contract"));
       rules.push(this.makeTemplateRule("alterations", false, "tenant_direct", "no", "tenant_direct_contract"));
    } else if (isNnn) {
       // B. NNN
       const nnnItems = [
         "Common Area Maintenance", "Operating Expenses", "Real Estate Taxes", "Property Insurance",
         "Utilities", "Repairs & Maintenance", "Management Fees", "Administrative Fees", "Trash Removal",
         "Janitorial", "Security", "Landscaping", "Snow Removal", "Parking", "Capital Expenditures",
         "Tenant Caused Damage", "Legal / Enforcement Fees", "Separately Metered Charges"
       ];
       nnnItems.forEach(item => {
          rules.push(this.makeTemplateRule(item, false, "yes", "yes"));
       });
    } else if (leaseType.includes("modified") || leaseType.includes("base year")) {
       // C. Modified Gross
       const mgItems = ["operating expenses", "taxes", "insurance"];
       mgItems.forEach(item => {
          rules.push(this.makeTemplateRule(item, true, "conditional", "conditional")); // Up to base year
       });
    }
    return rules;
  },

  makeTemplateRule(category, _included, _recoverable, _camEligible, responsibility = "landlord") {
    // Lease-derivation rule: templates emit checklist coverage rows only.
    // recoverable / cam_eligible / included_in_base_rent arguments are
    // intentionally ignored — those assertions require per-rule lease clause
    // evidence which a template by definition does not have. The reviewer
    // sees the category in the gap list and must promote it manually after
    // confirming a clause exists.
    return {
      expense_category: category,
      normalized_key: category.replace(/\s+/g, "_"),
      included_in_base_rent: false,
      recoverable_from_tenant: "needs_review",
      cam_eligible: "needs_review",
      responsibility: responsibility,
      source_type: "deterministic_template",
      generation_source: "template_checklist",
      row_status: "needs_review",
      review_status: "needs_review",
      approval_status: "draft",
      published_to_cam: false,
      exact_source_text: null,
      mentioned_in_lease: false,
      confidence_score: 0.50,
      rule_type: "additional_rent"
    };
  },

  mapLlmRule(rule, leaseId) {
    return {
      ...rule,
      lease_id: leaseId,
      source_type: "llm_extraction",
      confidence_score: rule.confidence || 0.7
    };
  },

  mergeAndScoreCandidates(candidates) {
     const mergedMap = new Map();
     
     // 1. Find global structured terms
     const structuredTermsRule = candidates.find(c => c.normalized_key === "structured_terms") || {};
     
     // Dedupe by canonical expense category. Template/checklist rows are kept
     // only when no evidence-backed extraction exists for the same category.
     for (let c of candidates) {
        if (!c.normalized_key || c.normalized_key === "structured_terms") continue;

        const key = canonicalRuleKey(c);
        const shareStructuredTerms = [
          "common_area_maintenance",
          "operating_expenses",
          "real_estate_taxes",
          "property_insurance",
          "utilities",
          "janitorial",
          "trash_removal",
          "security",
          "landscaping",
          "snow_removal",
          "parking",
          "repairs_maintenance",
          "capital_expenditures",
          "administrative_fees",
        ].includes(key);
        
        // Spread only scoped structured terms. Do not put admin fees, caps, or
        // base-year terms on unrelated categories such as late fees/interest.
        c = { 
           ...c,
           normalized_key: key,
           expense_category: CANONICAL_TO_LABEL[key] || c.expense_category,
           category_name: CANONICAL_TO_LABEL[key] || c.category_name,
           tenant_share_percent: shareStructuredTerms ? firstPresent(c.tenant_share_percent, structuredTermsRule.tenant_share_percent) : c.tenant_share_percent,
           estimated_annual_amount: firstPresent(c.estimated_annual_amount, structuredTermsRule.estimated_annual_amount),
           estimated_monthly_amount: firstPresent(c.estimated_monthly_amount, structuredTermsRule.estimated_monthly_amount),
           admin_fee_percent: key === "administrative_fees" ? firstPresent(c.admin_fee_percent, structuredTermsRule.admin_fee_percent) : c.admin_fee_percent,
           admin_fee_applicable: key === "administrative_fees" ? firstPresent(c.admin_fee_applicable, structuredTermsRule.admin_fee_applicable) : c.admin_fee_applicable,
           management_fee_percent: key === "management_fees" ? firstPresent(c.management_fee_percent, structuredTermsRule.management_fee_percent) : c.management_fee_percent,
           gross_up_percent: shareStructuredTerms ? firstPresent(c.gross_up_percent, structuredTermsRule.gross_up_percent) : c.gross_up_percent,
           gross_up_applicable: shareStructuredTerms ? firstPresent(c.gross_up_applicable, structuredTermsRule.gross_up_applicable) : c.gross_up_applicable,
           cap_percent: shareStructuredTerms ? firstPresent(c.cap_percent, structuredTermsRule.cap_percent) : c.cap_percent,
           cap_type: shareStructuredTerms ? firstPresent(c.cap_type, structuredTermsRule.cap_type) : c.cap_type,
           is_subject_to_cap: shareStructuredTerms ? firstPresent(c.is_subject_to_cap, structuredTermsRule.is_subject_to_cap) : c.is_subject_to_cap,
           reconciliation_required: shareStructuredTerms ? firstPresent(c.reconciliation_required, structuredTermsRule.reconciliation_required) : c.reconciliation_required,
           base_year: ["real_estate_taxes", "operating_expenses"].includes(key) ? firstPresent(c.base_year, structuredTermsRule.base_year) : c.base_year,
           base_year_amount: key === "operating_expenses" ? firstPresent(c.base_year_amount, structuredTermsRule.base_year_amount) : c.base_year_amount,
           tax_base_amount: key === "real_estate_taxes" ? firstPresent(c.tax_base_amount, structuredTermsRule.tax_base_amount) : c.tax_base_amount,
           insurance_base_amount: key === "property_insurance" ? firstPresent(c.insurance_base_amount, structuredTermsRule.insurance_base_amount) : c.insurance_base_amount
        };

        if (!mergedMap.has(key)) {
           mergedMap.set(key, c);
        } else {
           const existing = mergedMap.get(key);
           const scoreMap = { workflow_output: 5, llm_extraction: 4, text_fallback: 3, structured: 2, deterministic_template: 1 };
           const evidenceBonus = (row) => VALID_EVIDENCE(row?.exact_source_text) ? 2 : 0;
           const existingScore = (scoreMap[existing.source_type] || 0) + evidenceBonus(existing);
           const newScore = (scoreMap[c.source_type] || 0) + evidenceBonus(c);
           
           if (newScore > existingScore) {
              mergedMap.set(key, { ...existing, ...c, confidence_score: Math.max(existing.confidence_score||0, c.confidence_score||0) });
           } else {
              mergedMap.set(key, { ...c, ...existing, confidence_score: Math.max(existing.confidence_score||0, c.confidence_score||0) });
           }
        }
     }
     
     return Array.from(mergedMap.values());
  }
};

export default leaseRulePipelineService;
