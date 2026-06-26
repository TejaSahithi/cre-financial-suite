export const ADMIN_FEE_CATEGORIES = new Set(["administrative_fees"]);
export const MANAGEMENT_FEE_CATEGORIES = new Set(["management_fees"]);
export const GROSS_UP_CATEGORIES = new Set([
  "common_area_maintenance", "operating_expenses", "utilities",
]);
export const CAP_CATEGORIES = new Set([
  "common_area_maintenance", "operating_expenses", "real_estate_taxes",
  "property_insurance", "repairs_maintenance", "utilities",
]);
export const BASE_YEAR_CATEGORIES = new Set([
  "operating_expenses", "real_estate_taxes", "property_insurance",
]);
export const PRO_RATA_CATEGORIES = new Set([
  "common_area_maintenance", "operating_expenses", "real_estate_taxes",
  "property_insurance", "utilities", "repairs_maintenance",
  "capital_expenditures", "administrative_fees", "management_fees",
]);

export function scrubInapplicableStructuredFields(rule) {
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
export const VALID_EVIDENCE = (text) => {
  if (!text) return false;
  const raw = String(text).trim();
  if (raw.length < 18) return false;
  const lower = String(text).toLowerCase();
  // Reject placeholder/synthetic strings (not real lease clauses)
  const invalid = ["manual_review", "tenant_recovery", "tenant_direct", "inferred"];
  if (invalid.some(word => lower === word || lower.startsWith(word + "_") || lower.startsWith(word + " "))) return false;

  const unrelated = ["notice address"];
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
export const firstPresent = (...args) => args.find(a => a !== null && a !== undefined && a !== "");
export const asNumber = (val) => {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === 'number') return val;
  const str = String(val).replace(/[^0-9.-]/g, '');
  if (!str) return null;
  const num = Number(str);
  return isNaN(num) ? null : num;
};

export const normalizeKey = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");
export const CATEGORY_ALIASES = new Map([
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

export const CANONICAL_TO_LABEL = {
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

export const COMMON_CAM_KEYS = new Set([
  "common_area_maintenance",
  "operating_expenses",
  "janitorial",
  "trash_removal",
  "security",
  "landscaping",
  "snow_removal",
  "parking",
]);

export const DIRECT_UTILITY_KEYS = new Set(["utilities", "electricity", "gas", "water", "sewer", "separately_metered_charges", "excess_usage"]);
export const NOT_CAM_KEYS = new Set(["percentage_rent", "late_fees", "interest", "tenant_insurance", "alterations", "merchant_association_dues"]);
export const LLM_EXPENSE_CATEGORIES = Object.entries(CANONICAL_TO_LABEL).map(([normalized_key, category_name]) => ({
  normalized_key,
  category_name,
}));

export const CATEGORY_EVIDENCE_PATTERNS = {
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

export const CATEGORY_REJECTION_PATTERNS = {
  security: [/security\s+deposit/i, /deposit/i],
  parking: [/premises\s+known\s+as/i, /parking\s+rights/i, /parking\s+spaces?\b(?![\s\S]{0,80}(?:maint|repair|light|sweep|snow|common|operating|cam))/i],
  snow_removal: [/\bcap\b(?![\s\S]{0,120}(?:snow|ice)\s+removal)/i],
  property_insurance: [/tenant\s+(?:shall|must|will|agrees).{0,80}(?:maintain|carry|obtain).{0,80}insurance/i],
  tenant_insurance: [/landlord.{0,80}property\s+insurance/i, /property\s+insurance.{0,80}(?:reimburs|recover)/i],
  interest: [/capital\s+expenditure/i, /assignment/i],
  capital_expenditures: [/interest\s+on\s+late/i, /default\s+interest/i],
  legal_enforcement_fees: [/cam\s+exclusion/i, /excluded\s+from\s+operating\s+expenses/i],
};

export const CATEGORY_CONTEXT_REQUIREMENTS = {
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
export function canonicalRuleKey(rule) {
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

export function sectionRegex(number) {
  return new RegExp(`(?:^|[\\n\\r\\s])(?:section\\s*)?${number}(?:\\.\\d+)?\\s*[\\).:-]?\\s`, "i");
}

export function getSectionText(sourceText, number) {
  const text = String(sourceText || "");
  if (!text) return "";
  const startMatch = sectionRegex(number).exec(text);
  if (!startMatch) return "";
  const start = Math.max(0, startMatch.index);
  const nextMatch = new RegExp(`(?:^|[\\n\\r\\s])(?:section\\s*)?${number + 1}(?:\\.\\d+)?\\s*[\\).:-]?\\s`, "i").exec(text.slice(start + 20));
  const end = nextMatch ? start + 20 + nextMatch.index : Math.min(text.length, start + 3500);
  return text.slice(start, end).trim();
}

export function compactSnippet(text, maxLength = 1200) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

export function sectionIncludes(section, patterns = []) {
  const text = String(section || "");
  return patterns.some((pattern) => pattern.test(text));
}
export function detectDocumentProfile({ lease, sourceText }) {
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

export function extractDocumentTextCandidate(candidate) {
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