import { supabase } from "@/services/supabaseClient";
import leaseExpenseRuleService from "./leaseExpenseRuleService";
import { resolveLeaseField } from "@/lib/leaseFieldResolver";

const devLog = (...args) => { if (import.meta.env.DEV) devLog(...args); };
const devWarn = (...args) => { if (import.meta.env.DEV) devWarn(...args); };
const devTable = (...args) => { if (import.meta.env.DEV) devTable(...args); };


// Per-field whitelists. A given structured-terms field is meaningful only
// on these canonical categories; for all others it must be null to avoid
// global leakage. Update if you add new categories that legitimately carry
// admin/management fees, caps, base years, gross-up, or pro-rata shares.
const ADMIN_FEE_CATEGORIES = new Set(["administrative_fees"]);
const MANAGEMENT_FEE_CATEGORIES = new Set(["management_fees"]);
const GROSS_UP_CATEGORIES = new Set([
  "common_area_maintenance", "operating_expenses", "utilities",
]);
const CAP_CATEGORIES = new Set([
  "common_area_maintenance", "operating_expenses", "real_estate_taxes",
  "property_insurance", "repairs_maintenance", "utilities",
]);
const BASE_YEAR_CATEGORIES = new Set([
  "operating_expenses", "real_estate_taxes", "property_insurance",
]);
const PRO_RATA_CATEGORIES = new Set([
  "common_area_maintenance", "operating_expenses", "real_estate_taxes",
  "property_insurance", "utilities", "repairs_maintenance",
  "capital_expenditures", "administrative_fees", "management_fees",
]);

function scrubInapplicableStructuredFields(rule) {
  if (!rule || typeof rule !== "object") return;
  const key = String(rule.normalized_key || rule.expense_category || "").toLowerCase().replace(/[\s-]+/g, "_");

  if (!ADMIN_FEE_CATEGORIES.has(key)) {
    rule.admin_fee_percent = null;
    rule.admin_fee_applicable = false;
  }
  if (!MANAGEMENT_FEE_CATEGORIES.has(key)) {
    rule.management_fee_percent = null;
    rule.management_fee_applicable = false;
  }
  if (!GROSS_UP_CATEGORIES.has(key)) {
    rule.gross_up_percent = null;
    rule.gross_up_applicable = false;
    rule.gross_up_allowed = false;
  }
  if (!CAP_CATEGORIES.has(key)) {
    rule.cap_percent = null;
    rule.cap_type = null;
    rule.cap_value = null;
    rule.cap_amount = null;
    rule.is_subject_to_cap = false;
  }
  if (!BASE_YEAR_CATEGORIES.has(key)) {
    rule.base_year = null;
    rule.base_year_type = null;
    rule.base_year_amount = null;
    rule.tax_base_amount = null;
    rule.insurance_base_amount = null;
    rule.operating_expense_base_amount = null;
    rule.has_base_year = false;
    rule.expense_stop_amount = null;
  }
  if (!PRO_RATA_CATEGORIES.has(key)) {
    rule.tenant_share_percent = null;
    // Tenant-direct / late-fee / interest / percentage-rent style rules
    // should not carry a pro-rata estimate either.
    if (rule.payment_treatment === "tenant_direct_contract" || rule.is_excluded) {
      rule.estimated_annual_amount = null;
      rule.estimated_monthly_amount = null;
    }
  }
}

const VALID_EVIDENCE = (text) => {
  if (!text) return false;
  const raw = String(text).trim();
  if (raw.length < 18) return false;
  const lower = String(text).toLowerCase();
  const invalid = ["manual_review", "tenant_recovery", "tenant_direct", "inferred", "default"];
  if (invalid.some(word => lower.includes(word))) return false;
  
  const unrelated = ["notice address", "permitted use"];
  if (unrelated.some(word => lower.includes(word))) return false;

  // Reject if the source text is clearly just the premises/address
  if (/^(premises|address|suite|floor|square\s+feet|sq\.?\s*ft\.?|rentable\s+area)[\s:,-]*[0-9]+.*$/i.test(raw)) {
     if (!/(?:cam|tax|insurance|expense|maintain|repair|utility|fee|rent|reimburse)/i.test(raw)) {
        return false;
     }
  }

  // Reject if it only mentions tenant/landlord name
  if (/^(?:landlord|tenant)[\s:,-]*[a-z\s.,]+(?:llc|inc|corp|ltd)$/i.test(raw)) {
     if (!/(?:cam|tax|insurance|expense|maintain|repair|utility|fee|rent|reimburse)/i.test(raw)) {
        return false;
     }
  }

  // Reject if it is only a lease term/date
  if (/^(?:term|commencement|expiration|date)[\s:,-]*[0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}/i.test(raw)) {
     if (!/(?:cam|tax|insurance|expense|maintain|repair|utility|fee|rent|reimburse)/i.test(raw)) {
        return false;
     }
  }

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
const LLM_EXPENSE_CATEGORIES = Object.entries(CANONICAL_TO_LABEL).map(([normalized_key, category_name]) => ({
  normalized_key,
  category_name,
}));

const CATEGORY_EVIDENCE_PATTERNS = {
  common_area_maintenance: [/common\s+area\s+maintenance/i, /\bcam\b/i, /operating\s+expenses?/i],
  operating_expenses: [/operating\s+expenses?/i, /common\s+area\s+maintenance/i, /\bcam\b/i],
  real_estate_taxes: [/real\s+estate\s+tax/i, /property\s+tax/i, /\btaxes\b/i, /assessment/i],
  property_insurance: [/property\s+insurance/i, /\binsurance\b/i],
  utilities: [/utilit/i, /electric/i, /water/i, /gas/i, /sewer/i],
  electricity: [/electric/i],
  gas: [/\bgas\b/i],
  water: [/\bwater\b/i],
  sewer: [/\bsewer\b/i],
  repairs_maintenance: [/repair/i, /maintenance/i],
  janitorial: [/janitorial/i, /cleaning/i],
  trash_removal: [/trash/i, /refuse/i, /garbage/i],
  security: [/security/i],
  landscaping: [/landscap/i],
  snow_removal: [/snow/i],
  parking: [/parking/i],
  administrative_fees: [/admin/i, /administrative\s+fee/i],
  management_fees: [/management\s+fee/i],
  capital_expenditures: [/capital/i, /improvement/i, /replacement/i],
  tenant_caused_damage: [/tenant[-\s]?specific/i, /damage/i, /repair/i],
  separately_metered_charges: [/separately\s+metered/i, /separate\s+meter/i, /direct(?:ly)?\s+to\s+(?:the\s+)?utility/i],
  excess_usage: [/excess\s+usage/i, /excess\s+utilit/i],
  legal_enforcement_fees: [/legal/i, /attorney/i, /enforcement/i],
  tenant_insurance: [/tenant\b[\s\S]{0,120}\b(?:insurance|liability|certificate)/i, /commercial\s+general\s+liability/i],
  alterations: [/alteration/i, /tenant\s+improvement/i],
  percentage_rent: [/percentage\s+rent/i, /gross\s+sales/i],
  late_fees: [/late\s+(?:fee|charge)/i, /delinquent/i],
  interest: [/default\s+interest/i, /interest\s+on\s+(?:late|delinquent|overdue)/i],
  merchant_association_dues: [/merchant\s+association/i, /marketing\s+fund/i],
};

const CATEGORY_REJECTION_PATTERNS = {
  security: [/security\s+deposit/i, /deposit/i],
  parking: [/premises\s+known\s+as/i, /parking\s+rights/i, /parking\s+spaces?\b(?![\s\S]{0,80}(?:maint|repair|light|sweep|snow|common|operating|cam))/i],
  snow_removal: [/\bcap\b(?![\s\S]{0,120}(?:snow|ice)\s+removal)/i],
  property_insurance: [/tenant\s+(?:shall|must|will|agrees).{0,80}(?:maintain|carry|obtain).{0,80}insurance/i],
  tenant_insurance: [/landlord.{0,80}property\s+insurance/i, /property\s+insurance.{0,80}(?:reimburs|recover)/i],
  interest: [/capital\s+expenditure/i, /assignment/i],
  capital_expenditures: [/interest\s+on\s+late/i, /default\s+interest/i],
  legal_enforcement_fees: [/cam\s+exclusion/i, /excluded\s+from\s+operating\s+expenses/i],
};

const CATEGORY_CONTEXT_REQUIREMENTS = {
  utilities: [/utilit/i, /electric/i, /water/i, /sewer/i, /gas/i, /hvac/i, /after[-\s]?hours/i, /separately\s+metered/i],
  real_estate_taxes: [/tax(?:es)?/i, /assessment/i],
  property_insurance: [/insurance/i, /premium/i, /coverage/i],
  tenant_insurance: [/insurance/i, /premium/i, /coverage/i],
  common_area_maintenance: [/operating\s+expense/i, /\bcam\b/i, /common\s+area/i, /maintenance/i, /management/i, /janitorial/i, /landscap/i, /snow/i, /trash/i, /security/i],
  operating_expenses: [/operating\s+expense/i, /\bcam\b/i, /common\s+area/i, /maintenance/i, /management/i, /janitorial/i, /landscap/i, /snow/i, /trash/i, /security/i],
  administrative_fees: [/admin(?:istrative)?/i],
  management_fees: [/management\s+fee/i, /property\s+management/i],
  capital_expenditures: [/capital/i, /amorti/i, /useful\s+life/i, /improvement/i, /replacement/i],
  parking: [/parking/i, /\bev\b/i, /spaces?/i],
  late_fees: [/late/i, /default/i, /interest/i, /returned\s+payment/i],
  interest: [/late/i, /default/i, /interest/i, /returned\s+payment/i],
  holdover: [/holdover/i, /holding\s+over/i],
  tenant_improvements: [/\bti\b/i, /allowance/i, /alteration/i, /excess\s+cost/i, /tenant\s+improvement/i],
  alterations: [/\bti\b/i, /allowance/i, /alteration/i, /excess\s+cost/i, /tenant\s+improvement/i],
  security: [/security\s+(?:service|services|patrol|guard|monitoring)/i],
  snow_removal: [/(?:snow|ice)[\s\S]{0,80}removal/i, /snow\s+plowing/i],
};

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

function evidenceSupportsCategory(canonicalKey, evidence) {
  const text = String(evidence || "");
  if (!VALID_EVIDENCE(text)) return false;
  const rejectionPatterns = CATEGORY_REJECTION_PATTERNS[canonicalKey] || [];
  if (sectionIncludes(text, rejectionPatterns)) return false;
  const contextRequirements = CATEGORY_CONTEXT_REQUIREMENTS[canonicalKey] || [];
  if (contextRequirements.length > 0 && !sectionIncludes(text, contextRequirements)) return false;
  const patterns = CATEGORY_EVIDENCE_PATTERNS[canonicalKey] || [];
  return patterns.length === 0 ? text.trim().length > 0 : sectionIncludes(text, patterns);
}

function preserveEvidenceBackedRule(rule, evidence, note) {
  const snippet = compactSnippet(evidence);
  const confidence = Number(rule?.confidence_score || rule?.confidence || 0.72);
  return {
    ...rule,
    exact_source_text: snippet,
    source_clause: snippet,
    row_status: normalizeKey(rule?.row_status) === "not_mentioned" ? "needs_review" : (rule?.row_status || "mapped"),
    extraction_status: "extracted",
    review_status: "needs_review",
    approval_status: "draft",
    published_to_cam: false,
    mentioned_in_lease: true,
    confidence_score: Math.max(confidence, 0.72),
    notes: firstPresent(rule?.notes, note),
  };
}

function nonCamObligationRule(rule, evidence, reason, treatment = "not_applicable") {
  const snippet = compactSnippet(evidence);
  return {
    ...rule,
    exact_source_text: snippet,
    source_clause: snippet,
    recoverable_from_tenant: "no",
    cam_eligible: "no",
    payment_treatment: treatment,
    recovery_method: treatment === "tenant_direct_contract" ? "tenant_direct_contract" : "not_applicable",
    allocation_basis: treatment === "tenant_direct_contract" ? "direct" : null,
    is_recoverable: false,
    is_excluded: treatment !== "tenant_direct_contract",
    row_status: "mapped",
    extraction_status: "extracted",
    review_status: "needs_review",
    approval_status: "draft",
    published_to_cam: false,
    mentioned_in_lease: true,
    confidence_score: Math.max(Number(rule?.confidence_score || rule?.confidence || 0.72), 0.72),
    notes: reason,
  };
}

function includedInBaseRentRule(rule, evidence, reason) {
  const snippet = compactSnippet(evidence);
  return {
    ...rule,
    exact_source_text: snippet,
    source_clause: snippet,
    included_in_base_rent: true,
    recoverable_from_tenant: "no",
    cam_eligible: "no",
    payment_treatment: "included_in_base_rent",
    recovery_method: "included_in_base_rent",
    allocation_basis: null,
    is_recoverable: false,
    is_excluded: false,
    row_status: "mapped",
    extraction_status: "extracted",
    review_status: "needs_review",
    approval_status: "draft",
    published_to_cam: false,
    mentioned_in_lease: true,
    confidence_score: Math.max(Number(rule?.confidence_score || rule?.confidence || 0.72), 0.72),
    notes: reason,
  };
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

function originalLeaseRequiredRule(leaseId, documentType) {
  return {
    lease_id: leaseId,
    expense_category: "Operating Expenses",
    category_name: "Operating Expenses",
    normalized_key: "operating_expenses",
    source_field_key: "original_lease_required",
    rule_type: "coverage_gap",
    generation_source: "original_lease_required",
    source_type: "document_profile",
    extraction_version: "lease_rule_pipeline_v3_evidence_aligned",
    recoverable_from_tenant: "needs_review",
    cam_eligible: "needs_review",
    payment_treatment: "not_applicable",
    recovery_method: "not_applicable",
    allocation_basis: null,
    included_in_base_rent: false,
    is_recoverable: false,
    is_excluded: false,
    published_to_cam: false,
    exact_source_text: null,
    source_clause: null,
    review_status: "needs_review",
    approval_status: "draft",
    row_status: "not_mentioned",
    extraction_status: "not_found",
    confidence_score: 0.25,
    mentioned_in_lease: false,
    notes: `${documentType === "assignment" ? "Assignment" : "Amendment"} document does not contain expense recovery clauses. Original lease required for expense rules.`,
  };
}

function detectDocumentProfile({ lease, sourceText }) {
  const text = String(sourceText || "");
  const lower = text.toLowerCase();
  const profileHint = normalizeKey(firstPresent(
    lease?.document_profile,
    lease?.document_subtype,
    lease?.extraction_data?.document_profile,
    lease?.extraction_data?.document_type,
    lease?.extraction_data?.document_subtype,
    lease?.extraction_data?.workflow_output?.document_profile,
    lease?.extraction_data?.workflow_output?.document_type,
    lease?.extraction_data?.fields?.document_profile?.value,
  ));
  const nameLower = String(firstPresent(
    lease?.name,
    lease?.lease_name,
    lease?.document_name,
    lease?.extraction_data?.source_file_name,
  ) || "").toLowerCase();
  const combined = `${nameLower}\n${lower}`;
  const assignmentSignals = [
    /assignment\s+(?:and\s+assumption\s+)?of\s+lease/i,
    /\bassignor\b/i,
    /\bassignee\b/i,
    /landlord\s+consent\s+to\s+assignment/i,
    /assumption\s+by\s+assignee/i,
  ].filter((pattern) => pattern.test(combined)).length;
  const amendmentSignals = [
    /amendment\s+to\s+lease/i,
    /lease\s+amendment/i,
    /term\s+extension/i,
    /amended\s+and\s+restated/i,
    /base\s+rent\s+for\s+(?:the\s+)?(?:additional|extended)\s+(?:term|year)/i,
  ].filter((pattern) => pattern.test(combined)).length;
  const expenseSignals = [
    /common\s+area\s+maintenance/i,
    /\bcam\b/i,
    /operating\s+expenses?/i,
    /real\s+estate\s+tax(?:es)?/i,
    /property\s+tax(?:es)?/i,
    /property\s+insurance/i,
    /pro\s*rata\s+share/i,
    /expense\s+stop/i,
    /base\s+year/i,
    /tenant\s+shall\s+(?:reimburse|pay).{0,80}(?:tax|insurance|operating|cam|common\s+area|expense)/i,
    /triple\s+net|\bnnn\b/i,
    /full[-\s]?service|modified\s+gross|gross\s+lease/i,
    /after[-\s]?hours\s+hvac|separately\s+metered/i,
  ].filter((pattern) => pattern.test(combined)).length;
  const hasExplicitExpenseRecoveryClause = [
    /tenant\s+shall\s+(?:pay|reimburse|contribute).{0,100}(?:cam|common\s+area\s+maintenance|operating\s+expenses?|real\s+estate\s+tax(?:es)?|property\s+tax(?:es)?|insurance\s+premium)/i,
    /(?:cam|common\s+area\s+maintenance|operating\s+expenses?).{0,140}(?:tenant'?s\s+pro\s*rata\s+share|reimburs|recover|additional\s+rent)/i,
    /base\s+year.{0,120}(?:operating\s+expenses?|tax(?:es)?|insurance)|expense\s+stop/i,
    /full[-\s]?service.{0,160}(?:utilities|janitorial|tax(?:es)?|insurance|operating\s+expenses?)/i,
    /separately\s+metered.{0,120}(?:tenant\s+shall\s+pay|direct(?:ly)?\s+to\s+(?:the\s+)?utility)/i,
  ].some((pattern) => pattern.test(text));
  const hintedAssignment = profileHint.includes("assignment") || nameLower.includes("assignment");
  const hintedAmendment = profileHint.includes("amendment") || nameLower.includes("amend");
  const leaseStructure = /modified\s+gross|base\s+year|expense\s+stop/i.test(combined)
    ? "modified_gross_base_year"
    : /full[-\s]?service|gross\s+lease/i.test(combined)
      ? "full_service"
      : /triple\s+net|\bnnn\b|net\s+lease/i.test(combined)
        ? "nnn"
        : "unknown";
  const strongFullLeaseSignals =
    hasExplicitExpenseRecoveryClause ||
    expenseSignals >= 2 ||
    leaseStructure !== "unknown" ||
    /(?:lease\s+agreement|standard\s+form\s+lease|premises|commencement\s+date|expiration\s+date|base\s+rent|rent\s+schedule)/i.test(combined);
  const profileHintIsStale =
    (hintedAssignment || hintedAmendment) &&
    strongFullLeaseSignals &&
    assignmentSignals < 2;
  const documentType = profileHintIsStale
    ? "full_lease"
    : hintedAssignment && !strongFullLeaseSignals
      ? "assignment"
      : hintedAmendment && !strongFullLeaseSignals
        ? "amendment"
        : assignmentSignals >= 2 && !strongFullLeaseSignals
          ? "assignment"
          : amendmentSignals >= 2 && !strongFullLeaseSignals
            ? "amendment"
            : "full_lease";
  const assignmentOrAmendmentOnly =
    ["assignment", "amendment"].includes(documentType) &&
    !hasExplicitExpenseRecoveryClause &&
    !strongFullLeaseSignals;

  return {
    documentType,
    leaseStructure,
    assignmentOrAmendmentOnly,
    expenseSignals,
    hasExplicitExpenseRecoveryClause,
    assignmentSignals,
    amendmentSignals,
    strongFullLeaseSignals,
    profileHintIsStale,
  };
}

function extractDocumentTextCandidate(candidate) {
  if (!candidate) return "";
  if (typeof candidate === "string") return candidate.trim();
  if (Array.isArray(candidate)) {
    return candidate
      .map((item) => extractDocumentTextCandidate(item))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (typeof candidate !== "object") return "";

  const direct = firstPresent(
    candidate.full_text,
    candidate.raw_text,
    candidate.markdown,
    candidate.text,
    candidate.body,
    candidate.content,
    candidate.source_text,
    candidate.extracted_text,
  );
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const nestedText = firstPresent(
    extractDocumentTextCandidate(candidate.docling_raw),
    extractDocumentTextCandidate(candidate.normalized_output),
    extractDocumentTextCandidate(candidate.parsed_data),
    extractDocumentTextCandidate(candidate.pages),
    extractDocumentTextCandidate(candidate.text_blocks),
    extractDocumentTextCandidate(candidate.blocks),
  );
  return typeof nestedText === "string" ? nestedText.trim() : "";
}

function applyLeaseEvidenceRules(rule, sourceText) {
  const canonicalKey = canonicalRuleKey(rule);
  const explicitPaymentTreatment = normalizeKey(rule?.payment_treatment);
  const explicitRecoveryMethod = normalizeKey(rule?.recovery_method);
  const normalizedRule = {
    ...rule,
    normalized_key: canonicalKey,
    expense_category: CANONICAL_TO_LABEL[canonicalKey] || rule?.expense_category || rule?.category_name || canonicalKey,
    category_name: CANONICAL_TO_LABEL[canonicalKey] || rule?.category_name || rule?.expense_category || canonicalKey,
  };

  const existingEvidence = String(firstPresent(rule?.exact_source_text, rule?.source_clause, rule?.source_text, rule?.source) || "");
  const existingLower = existingEvidence.toLowerCase();
  
  if (!existingEvidence) {
    return notFoundRule(normalizedRule, "Missing source evidence.");
  }

  const existingEvidenceSupportsCategory = evidenceSupportsCategory(canonicalKey, existingEvidence);

  if (!existingEvidenceSupportsCategory) {
    return downgradeUnsupportedRule(normalizedRule, `Source text does not support category ${CANONICAL_TO_LABEL[canonicalKey] || canonicalKey}.`);
  }

  const isIncludedInRentTerm =
    rule?.included_in_base_rent === true ||
    rule?.included_in_base_rent === "yes" ||
    explicitPaymentTreatment === "included_in_base_rent" ||
    explicitRecoveryMethod === "included_in_base_rent" ||
    (/included\s+in\s+(?:base\s+)?rent|full[-\s]?service|gross\s+lease/i.test(existingEvidence) && evidenceSupportsCategory(canonicalKey, existingEvidence));

  const isTenantDirectTerm =
    explicitPaymentTreatment === "tenant_direct_contract" ||
    explicitRecoveryMethod === "tenant_direct_contract" ||
    /tenant\s+(?:shall|must|will|agrees\s+to)\s+(?:maintain|repair|provide|carry|obtain|contract)/i.test(existingEvidence) ||
    /separately\s+metered|direct(?:ly)?\s+to\s+(?:the\s+)?utility|at\s+tenant'?s\s+(?:sole\s+)?(?:cost|expense)/i.test(existingEvidence);

  const isExplicitExclusionTerm =
    rule?.is_excluded === true ||
    /excluded\s+from\s+(?:cam|common\s+area\s+maintenance|operating\s+expenses?)|not\s+included\s+in\s+(?:cam|common\s+area\s+maintenance|operating\s+expenses?)/i.test(existingEvidence);

  if (isIncludedInRentTerm) {
    return includedInBaseRentRule(normalizedRule, existingEvidence, "Expense-related lease term is included in base rent/full-service treatment.");
  }

  if (isTenantDirectTerm) {
    return nonCamObligationRule(normalizedRule, existingEvidence, "Tenant direct obligation found in lease; not CAM recoverable.", "tenant_direct_contract");
  }

  if (isExplicitExclusionTerm) {
    return nonCamObligationRule(normalizedRule, existingEvidence, "Expense-related term is explicitly excluded from CAM/operating expense recovery.");
  }

  if (canonicalKey === "percentage_rent") {
    if (!/percentage\s+rent/i.test(existingEvidence)) {
      return notFoundRule(normalizedRule, "Percentage Rent is not supported by a specific lease expense clause.");
    }
  }

  if (NOT_CAM_KEYS.has(canonicalKey)) {
    const directTreatment = ["tenant_insurance", "alterations"].includes(canonicalKey)
      ? "tenant_direct_contract"
      : "not_applicable";
    const reason = canonicalKey === "tenant_insurance"
      ? "Tenant insurance is a tenant direct obligation, not CAM or common operating expense recovery."
      : canonicalKey === "alterations"
        ? "Alterations are tenant direct obligations unless a specific CAM recovery clause says otherwise."
        : canonicalKey === "late_fees"
          ? "Late fees are default charges, not CAM or operating expense recovery."
          : canonicalKey === "interest"
            ? "Interest is a default/revenue charge unless tied to an allowed amortized capital exception."
            : "Lease obligation is not a CAM expense recovery rule.";
    return nonCamObligationRule(normalizedRule, existingEvidence, reason, directTreatment);
  }

  if (canonicalKey === "capital_expenditures" && /amorti|useful\s+life/i.test(existingEvidence)) {
     return {
        ...preserveEvidenceBackedRule(normalizedRule, existingEvidence, "Capital expenditure recovery amortized over useful life."),
        recoverable_from_tenant: "conditional",
        cam_eligible: "conditional",
        recovery_method: "amortized_capital"
     };
  }

  return preserveEvidenceBackedRule(normalizedRule, existingEvidence, `Mapped from lease clause evidence for ${CANONICAL_TO_LABEL[canonicalKey] || canonicalKey}.`);
}

// ... Wait, I should fetch the lease first
export const leaseRulePipelineService = {
  async generateLeaseExpenseRulesForLease({ leaseId, force = false, source = "manual_extract" }) {
    devLog("[NEW PIPELINE CALLED]", { leaseId, force, source });
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
      if (unitErr) devWarn("[PIPELINE SIDELOAD WARNING] unit fetch failed:", unitErr);
      lease.unit = unit || null;
    }
    if (lease.property_id) {
      const { data: property, error: propErr } = await supabase.from("properties").select("*").eq("id", lease.property_id).maybeSingle();
      if (propErr) devWarn("[PIPELINE SIDELOAD WARNING] property fetch failed:", propErr);
      lease.property = property || null;
    }
    if (lease.building_id) {
      const { data: building, error: buildErr } = await supabase.from("buildings").select("*").eq("id", lease.building_id).maybeSingle();
      if (buildErr) devWarn("[PIPELINE SIDELOAD WARNING] building fetch failed:", buildErr);
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
      // The uploaded_files table has `mime_type` and `file_name`; `is_scanned`
      // and `file_type` do not exist (PostgREST returned 400 Bad Request when
      // we asked for them, which silently dropped the whole row including the
      // docling/normalized/parsed payloads and made re-extract a no-op).
      const { data: file } = await supabase
        .from("uploaded_files")
        .select("normalized_output, parsed_data, docling_raw, reviewed_output, ui_review_payload, mime_type, file_name")
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
          file?.docling_raw,
          file?.normalized_output,
          file?.parsed_data,
          lease?.extraction_data?.abstract,
          lease?.extracted_text
        ];

        for (const c of candidates) {
          const extracted = extractDocumentTextCandidate(c);
          if (extracted && extracted.length > 50) {
            sourceText = extracted;
            break;
          }
        }

        // OCR Fallback for Scanned PDF.
        // Detect scanned-ish documents from mime_type and file_name extension
        // (the columns that actually exist). Reaching this branch already
        // means the parser produced no usable text — that IS the "scanned"
        // signal, so the mime/extension check is just a guard to skip OCR
        // for things like .docx/.csv where Vision won't help.
        const mime = String(file.mime_type || "").toLowerCase();
        const fname = String(file.file_name || "").toLowerCase();
        const looksLikeScannable =
          mime.includes("pdf") || mime.startsWith("image/")
          || /\.(pdf|png|jpe?g|tiff?|webp|heic)$/i.test(fname);
        if (!sourceText && looksLikeScannable) {
          try {
            devLog("Triggering OCR Vision Fallback...");
            const { data: ocrData } = await supabase.functions.invoke("ocr-vision-extract", { body: { fileId } });
            if (ocrData?.text) {
              sourceText = ocrData.text;
              await supabase.from("uploaded_files").update({ 
                parsed_data: { ...(file.parsed_data || {}), full_text: sourceText } 
              }).eq("id", fileId);
            }
          } catch (ocrErr) {
             devWarn("OCR fallback failed:", ocrErr);
          }
        }
      }
    }
    
    if (!sourceText && lease?.extracted_text) {
      sourceText = lease.extracted_text;
    }
    
    diagnostics.sourceTextLength = sourceText?.length || 0;

    // 4. Document Type Detection
    const documentProfile = detectDocumentProfile({ lease, sourceText });
    diagnostics.documentType = documentProfile.documentType;
    diagnostics.leaseStructure = documentProfile.leaseStructure;
    diagnostics.assignmentOrAmendmentOnly = documentProfile.assignmentOrAmendmentOnly;
    diagnostics.expenseSignals = documentProfile.expenseSignals;
    diagnostics.hasExplicitExpenseRecoveryClause = documentProfile.hasExplicitExpenseRecoveryClause;



    devLog("[PIPELINE INPUT]", {
      leaseId,
      sourceFileId: diagnostics.sourceFileId,
      sourceTextLength: diagnostics.sourceTextLength,
      documentType: diagnostics.documentType,
      leaseStructure: diagnostics.leaseStructure,
      assignmentOrAmendmentOnly: diagnostics.assignmentOrAmendmentOnly,
      expenseSignals: diagnostics.expenseSignals,
      hasExplicitExpenseRecoveryClause: diagnostics.hasExplicitExpenseRecoveryClause,
      leaseType: lease.lease_type,
      hasExtractionData: !!lease?.extraction_data,
      extractionKeys: Object.keys(lease?.extraction_data || {})
    });

    if (documentProfile.assignmentOrAmendmentOnly) {
      devLog("[PIPELINE DOCUMENT PROFILE] original lease required for expense rules", documentProfile);
      const saved = await leaseExpenseRuleService.saveRuleSet({
        lease,
        rules: [originalLeaseRequiredRule(lease.id, documentProfile.documentType)],
        status: "draft",
        createdFrom: "original_lease_required",
        categories: []
      });
      diagnostics.persistedRulesCount = saved?.rules?.length || 0;
      diagnostics.skippedReasons = "original_lease_required";
      return diagnostics;
    }

    // Force reruns should only replace unresolved extraction output. Human-approved
    // rows are the durable approval record and must survive regeneration.
    if (force) {
      devLog("[FORCE REEXTRACT] destructive delete skipped; saveRuleSet will supersede stale unresolved rows", { leaseId, force });
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
    const shouldRunLlmExtraction = Boolean(sourceText) && (
      force ||
      ["manual_extract", "extract_draft", "approve_abstract"].includes(String(source || "").toLowerCase()) ||
      workflowRules.length === 0
    );
    if (shouldRunLlmExtraction) {
       try {
         const { data: llmData, error: llmErr } = await supabase.functions.invoke("extract-lease-expense-rules", {
           body: {
             source_text: sourceText,
             categories: LLM_EXPENSE_CATEGORIES,
           },
         });
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

    devLog("[PIPELINE CANDIDATES]", {
      workflowRulesCount: diagnostics.workflowRulesCount,
      structuredTermRulesCount: diagnostics.structuredTermRulesCount,
      deterministicRulesCount: diagnostics.deterministicRulesCount,
      textFallbackRulesCount: diagnostics.textFallbackRulesCount,
      llmRulesCount: diagnostics.llmRulesCount,
      shouldRunLlmExtraction,
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
      } else if (r.confidence_score < 0.55) {
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

      // Per-category leakage scrub. The LLM and structured-terms merger
      // sometimes propagate global percentages (admin fee, gross-up, cap,
      // base year, tenant share) onto every category. Force-null them when
      // the rule's category doesn't actually support that field. This
      // prevents e.g. admin_fee_percent=10 appearing on taxes / utilities /
      // repairs / security / landscaping rules.
      scrubInapplicableStructuredFields(r);

      return r;
    }).filter(r => r.normalized_key !== "structured_terms"); // Filter out the dummy row if it wasn't merged away

    // Diagnostics Payload Output
    if (finalRules.length > 0) {
      devLog(`[FINAL PAYLOAD BEFORE SAVE] Lease ${leaseId}:`);
      devTable(finalRules.map(p => ({
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

    // Generated-rule summary by source + leakage-field count by category.
    // Helps verify that the per-category scrub did its job and that
    // template/checklist rows haven't drowned out evidence-backed rows.
    const summaryBySource = finalRules.reduce((acc, r) => {
      const k = r.generation_source || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const adminFeeRows = finalRules
      .filter((r) => r.admin_fee_percent != null)
      .map((r) => ({ key: r.normalized_key, admin_fee_percent: r.admin_fee_percent }));
    const grossUpRows = finalRules
      .filter((r) => r.gross_up_percent != null)
      .map((r) => ({ key: r.normalized_key, gross_up_percent: r.gross_up_percent }));
    const capRows = finalRules
      .filter((r) => r.cap_percent != null || r.is_subject_to_cap)
      .map((r) => ({ key: r.normalized_key, cap_percent: r.cap_percent, is_subject_to_cap: r.is_subject_to_cap }));
    devLog("[PIPELINE SUMMARY]", {
      leaseId,
      generated_total: finalRules.length,
      by_generation_source: summaryBySource,
      admin_fee_rows: adminFeeRows,
      gross_up_rows: grossUpRows,
      cap_rows: capRows,
    });

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

    devLog("[POST UPSERT RULE COUNT]", {
      leaseId,
      count,
      countError,
      expected_close_to: (saved?.rules?.length || 0),
      delta_vs_expected: count != null && saved?.rules?.length != null ? count - saved.rules.length : null,
    });

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
    
    const baseYear = resolve("base_year") || resolve("expense_base_year")
      || textMatcher(/base\s+year(?:\s+(?:shall\s+be|is|means|of))?[^\d]{0,40}(20\d{2})/i, (val) => val)
      || textMatcher(/(20\d{2})[^\n.]{0,80}(?:base\s+year|expense\s+stop)/i, (val) => val);
    const opExBase = asNumber(resolve("operating_expense_base_amount"))
      || textMatcher(/operating\s+expenses?(?:\s+base|\s+stop|)[^$]{0,120}\$?\s*([\d,]+(?:\.\d{2})?)/i, (val) => asNumber(val.replace(/,/g, '')))
      || textMatcher(/\$?\s*([\d,]+(?:\.\d{2})?)[^.\n]{0,80}operating\s+expenses?\s+(?:base|stop)/i, (val) => asNumber(val.replace(/,/g, '')));
    const taxBase = asNumber(resolve("tax_base_amount"))
      || textMatcher(/(?:real\s+estate\s+)?tax(?:es)?(?:\s+base|\s+stop|)[^$]{0,120}\$?\s*([\d,]+(?:\.\d{2})?)/i, (val) => asNumber(val.replace(/,/g, '')))
      || textMatcher(/\$?\s*([\d,]+(?:\.\d{2})?)[^.\n]{0,80}(?:real\s+estate\s+)?tax(?:es)?\s+(?:base|stop)/i, (val) => asNumber(val.replace(/,/g, '')));
    const insBase = asNumber(resolve("insurance_base_amount"))
      || textMatcher(/insurance(?:\s+base|\s+stop|)[^$]{0,120}\$?\s*([\d,]+(?:\.\d{2})?)/i, (val) => asNumber(val.replace(/,/g, '')))
      || textMatcher(/\$?\s*([\d,]+(?:\.\d{2})?)[^.\n]{0,80}insurance\s+(?:base|stop)/i, (val) => asNumber(val.replace(/,/g, '')));

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
    const normalizedKey = canonicalRuleKey(rule);
    return {
      ...rule,
      lease_id: leaseId,
      normalized_key: normalizedKey,
      source_type: "llm_extraction",
      generation_source: "llm_extraction",
      confidence_score: rule.confidence_score || rule.confidence || 0.7,
      base_year_amount: normalizedKey === "operating_expenses"
        ? firstPresent(rule.base_year_amount, rule.operating_expense_base_amount)
        : rule.base_year_amount,
      tax_base_amount: firstPresent(rule.tax_base_amount, normalizedKey === "real_estate_taxes" ? rule.base_year_amount : null),
      insurance_base_amount: firstPresent(rule.insurance_base_amount, normalizedKey === "property_insurance" ? rule.base_year_amount : null),
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
