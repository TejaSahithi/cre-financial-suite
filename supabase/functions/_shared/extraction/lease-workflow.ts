// @ts-nocheck

type LeaseWorkflowField = {
  key: string;
  value: unknown;
  source_page: number | null;
  source_clause: string | null;
  confidence_score: number | null;
  extraction_status: "extracted" | "calculated" | "not_found" | "manual_required" | "conflict_detected";
  editable: boolean;
  field_group: string;
};

type LeaseWorkflowClause = {
  clause_type: string;
  clause_title: string;
  clause_text: string | null;
  source_page: number | null;
  confidence_score: number | null;
  structured_fields_json: Record<string, unknown>;
};

const EXPENSE_CATEGORIES = [
  "base_rent",
  "additional_rent",
  "cam",
  "common_area_maintenance",
  "operating_expenses",
  "real_estate_taxes",
  "property_insurance",
  "utilities",
  "electricity",
  "water",
  "sewer",
  "gas",
  "hvac",
  "janitorial",
  "trash_removal",
  "security",
  "landscaping",
  "snow_removal",
  "parking",
  "roof_structure",
  "foundation_structure",
  "interior_repairs",
  "exterior_repairs",
  "capital_expenditures",
  "management_fees",
  "administrative_fees",
  "marketing_fund",
  "merchant_association_dues",
  "percentage_rent",
  "late_fees",
  "interest",
  "legal_fees",
  "tenant_insurance",
  "tenant_improvements",
  "alterations",
  "tenant_caused_damage",
  "separately_metered_charges",
  "excess_usage",
];

const EXPENSE_RULE_BLUEPRINTS = [
  { key: "base_rent", title: "Base Rent", keywords: ["base rent", "monthly rent"], includedWhenFullService: false, tenantDirect: true, rentLine: true },
  { key: "additional_rent", title: "Additional Rent", keywords: ["additional rent"], recoverable: true, conditional: true },
  { key: "cam", title: "CAM", keywords: ["cam", "common area maintenance"], recoverable: true, camLike: true },
  { key: "common_area_maintenance", title: "Common Area Maintenance", keywords: ["common area maintenance", "cam"], recoverable: true, camLike: true },
  { key: "operating_expenses", title: "Operating Expenses", keywords: ["operating expenses"], recoverable: true, camLike: true },
  { key: "real_estate_taxes", title: "Real Estate Taxes", keywords: ["real estate tax", "property tax", "taxes and assessments"], recoverable: true, camLike: true },
  { key: "property_insurance", title: "Property Insurance", keywords: ["property insurance", "insurance premium"], recoverable: true, camLike: true },
  { key: "utilities", title: "Utilities", keywords: ["utilities", "utility"], includedWhenFullService: true },
  { key: "electricity", title: "Electricity", keywords: ["electric", "electricity"], includedWhenFullService: true },
  { key: "water", title: "Water", keywords: ["water"], includedWhenFullService: true },
  { key: "sewer", title: "Sewer", keywords: ["sewer"], includedWhenFullService: true },
  { key: "gas", title: "Gas", keywords: ["gas"], includedWhenFullService: true },
  { key: "hvac", title: "HVAC", keywords: ["hvac", "air conditioning", "heating"], includedWhenFullService: true, conditional: true },
  { key: "janitorial", title: "Janitorial", keywords: ["janitorial", "cleaning"], includedWhenFullService: true },
  { key: "trash_removal", title: "Trash Removal", keywords: ["trash", "garbage"], includedWhenFullService: true },
  { key: "security", title: "Security", keywords: ["security"], includedWhenFullService: true },
  { key: "landscaping", title: "Landscaping", keywords: ["landscaping"], includedWhenFullService: true },
  { key: "snow_removal", title: "Snow Removal", keywords: ["snow removal"], includedWhenFullService: true },
  { key: "parking", title: "Parking", keywords: ["parking", "garage"], recoverable: true, fixedChargeField: "parking_fee_amount" },
  { key: "roof_structure", title: "Roof / Structure", keywords: ["roof", "structure"], tenantDirect: false },
  { key: "foundation_structure", title: "Foundation / Structure", keywords: ["foundation", "structural"], tenantDirect: false },
  { key: "interior_repairs", title: "Interior Repairs", keywords: ["interior repair", "interior maintenance"], conditional: true },
  { key: "exterior_repairs", title: "Exterior Repairs", keywords: ["exterior repair", "exterior maintenance"], conditional: true },
  { key: "capital_expenditures", title: "Capital Expenditures", keywords: ["capital expenditure", "capital improvement"], conditional: true },
  { key: "management_fees", title: "Management Fees", keywords: ["management fee"], recoverable: true, camLike: true },
  { key: "administrative_fees", title: "Administrative Fees", keywords: ["administrative fee", "admin fee"], recoverable: true, camLike: true },
  { key: "marketing_fund", title: "Marketing Fund", keywords: ["marketing fund"], recoverable: true, conditional: true },
  { key: "merchant_association_dues", title: "Merchant Association Dues", keywords: ["merchant association"], recoverable: true, conditional: true },
  { key: "percentage_rent", title: "Percentage Rent", keywords: ["percentage rent", "gross sales", "natural breakpoint", "artificial breakpoint"], recoverable: true, percentageRent: true },
  { key: "late_fees", title: "Late Fees", keywords: ["late fee", "late charge"], recoverable: true, direct: true, fixedChargeField: "late_fee_amount" },
  { key: "interest", title: "Interest", keywords: ["interest", "prime rate"], recoverable: true, direct: true, conditional: true },
  { key: "legal_fees", title: "Legal Fees", keywords: ["attorney", "legal fee", "enforcement"], recoverable: true, direct: true, conditional: true },
  { key: "tenant_insurance", title: "Tenant Insurance", keywords: ["tenant insurance", "liability insurance"], tenantDirect: true },
  { key: "tenant_improvements", title: "Tenant Improvements", keywords: ["tenant improvement", "ti allowance"], conditional: true },
  { key: "alterations", title: "Alterations", keywords: ["alteration", "improvement"], tenantDirect: true },
  { key: "tenant_caused_damage", title: "Tenant-Caused Damage", keywords: ["tenant caused damage", "damage caused by tenant"], recoverable: true, direct: true },
  { key: "separately_metered_charges", title: "Separately Metered Charges", keywords: ["separately metered", "separate meter"], recoverable: true, direct: true, conditional: true },
  { key: "excess_usage", title: "Excess Usage", keywords: ["excess use", "special equipment", "excess utility"], recoverable: true, direct: true, conditional: true },
  { key: "tenant_caused_repairs", title: "Tenant-Caused Repairs", keywords: ["damage", "tenant caused", "tenant-caused", "repair"], recoverable: true, direct: true },
  { key: "excess_utilities", title: "Excess Utilities", keywords: ["excess utility", "separately metered", "separate meter"], recoverable: true, direct: true, conditional: true },
  { key: "special_equipment_usage", title: "Special Equipment Usage", keywords: ["special equipment", "server", "equipment"], recoverable: true, direct: true, conditional: true },
  { key: "legal_default_costs", title: "Legal / Enforcement Costs", keywords: ["attorney", "legal cost", "enforcement"], recoverable: true, direct: true, conditional: true },
  { key: "tenant_alterations", title: "Tenant Alterations", keywords: ["alteration", "improvement", "tenant work"], tenantDirect: true },
];

const EXCLUDED_EXPENSE_RULE_KEYS = new Set([
  "base_rent",
  "monthly_rent",
  "annual_rent",
  "additional_rent",
]);

// Confidence threshold below which an extracted value should NOT be treated
// as a confirmed extraction. Values under this score get downgraded to
// "needs_review" so the reviewer treats them as a candidate, not a fact.
const LOW_CONFIDENCE_THRESHOLD = 0.55;

const CANONICAL_EXPENSE_RULE_CONFIG = [
  { canonicalKey: "common_area_maintenance", categoryName: "Common Area Maintenance", aliases: ["cam", "common_area_maintenance", "common area maintenance"] },
  { canonicalKey: "real_estate_taxes", categoryName: "Real Estate Taxes", aliases: ["property_tax", "real_estate_taxes", "taxes", "property taxes", "taxes and assessments"] },
  { canonicalKey: "property_insurance", categoryName: "Property Insurance", aliases: ["insurance", "property_insurance", "property insurance"] },
  { canonicalKey: "repairs_maintenance", categoryName: "Repairs & Maintenance", aliases: ["maintenance", "repairs", "repairs_maintenance", "interior_repairs", "exterior_repairs", "roof_structure", "foundation_structure", "hvac"] },
  { canonicalKey: "legal_enforcement_fees", categoryName: "Legal / Enforcement Fees", aliases: ["legal_fees", "legal_default_costs", "enforcement_fees", "attorneys_fees", "legal_enforcement_fees"] },
  { canonicalKey: "tenant_caused_damage", categoryName: "Tenant-Caused Damage", aliases: ["tenant_caused_damage", "tenant_caused_repairs"] },
  { canonicalKey: "excess_usage", categoryName: "Excess Usage", aliases: ["excess_usage", "excess_utilities", "special_equipment_usage"] },
  { canonicalKey: "alterations", categoryName: "Alterations", aliases: ["alterations", "tenant_alterations"] },
  { canonicalKey: "utilities", categoryName: "Utilities", aliases: ["utilities", "utility"] },
  { canonicalKey: "electricity", categoryName: "Utilities", subcategoryName: "Electricity", aliases: ["electricity", "electric"] },
  { canonicalKey: "water", categoryName: "Utilities", subcategoryName: "Water", aliases: ["water"] },
  { canonicalKey: "sewer", categoryName: "Utilities", subcategoryName: "Sewer", aliases: ["sewer"] },
  { canonicalKey: "gas", categoryName: "Utilities", subcategoryName: "Gas", aliases: ["gas"] },
];

const GENERIC_EXPENSE_RULE_SOURCE_PATTERNS = [
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

const CLAUSE_DEFINITIONS = [
  { type: "rent_escalation", title: "Rent & Escalation", keywords: ["base rent", "monthly rent", "minimum rent", "rent shall", "annual rent", "escalation", "increase"], maxChars: 720 },
  { type: "security_deposit", title: "Security Deposit", keywords: ["security deposit", "deposit"], maxChars: 520 },
  { type: "operating_expense_recovery", title: "Operating Expense Recovery", keywords: ["operating expenses", "additional rent", "tenant shall reimburse", "tenant shall pay", "taxes, insurance", "common area maintenance"], maxChars: 820 },
  { type: "cam_recoveries", title: "CAM / Recoveries", keywords: ["common area maintenance", "cam", "common area expenses"], maxChars: 820 },
  { type: "taxes", title: "Taxes", keywords: ["real estate taxes", "property taxes", "taxes and assessments"], maxChars: 620 },
  { type: "use_clause", title: "Use Clause", keywords: ["permitted use", "use of premises"], maxChars: 520 },
  { type: "assignment_subletting", title: "Assignment / Subletting", keywords: ["assignment", "subletting", "sublease"], maxChars: 620 },
  { type: "repairs_maintenance", title: "Repairs & Maintenance", keywords: ["repairs", "maintenance", "hvac"], maxChars: 620 },
  { type: "alterations", title: "Alterations", keywords: ["alterations", "improvements"], maxChars: 520 },
  { type: "insurance", title: "Insurance", keywords: ["insurance", "liability insurance", "workers compensation"], maxChars: 720 },
  { type: "hazardous_materials", title: "Hazardous Materials", keywords: ["hazardous", "hazardous materials", "environmental"], maxChars: 520 },
  { type: "default", title: "Default", keywords: ["default", "event of default"], maxChars: 520 },
  { type: "remedies", title: "Remedies", keywords: ["remedies", "cumulative remedies"], maxChars: 520 },
  { type: "surrender", title: "Surrender", keywords: ["surrender", "vacate"], maxChars: 520 },
  { type: "holdover", title: "Holdover", keywords: ["holdover"], maxChars: 420 },
  { type: "renewal_option", title: "Renewal Option", keywords: ["renewal option", "option to renew", "extend the term", "additional term"], maxChars: 720 },
  { type: "notices", title: "Notices", keywords: ["notices", "notice"], maxChars: 620 },
  { type: "subordination_estoppel", title: "Subordination / Estoppel", keywords: ["subordination", "estoppel"], maxChars: 520 },
  { type: "governing_law", title: "Governing Law", keywords: ["governing law"], maxChars: 320 },
  { type: "jury_waiver", title: "Jury Waiver", keywords: ["jury", "waiver of jury"], maxChars: 320 },
  { type: "successors_assigns", title: "Successors & Assigns", keywords: ["successors", "assigns"], maxChars: 420 },
];

const FIELD_SPECS = [
  { key: "lease_date", group: "lease_header", aliases: ["lease_date", "effective_date", "date_of_lease"], patterns: [/\b(?:dated|lease date|effective date)\b[^\n]{0,30}?([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i, /\bentered\s+into\s+as\s+of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i] },
  { key: "landlord_name", group: "lease_header", aliases: ["landlord_name", "landlord", "lessor", "owner_landlord", "owner_name"], patterns: [/\bLANDLORD[:\s-]+([A-Z0-9][^\n]{2,160}?)(?=\s+(?:By|TENANT|LESSEE|Address|whose|having)|\s*\n|$)/, /\bLessor[:\s-]+([A-Z0-9][^\n]{2,160})/, /\bbetween\s+([A-Z0-9][A-Za-z0-9.,&'\- ]{2,100}?(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|LLP|Trust|Holdings|Partners?))\s*\(['""]?[Ll]andlord['""]?\)/i] },
  { key: "landlord_address", group: "lease_header", aliases: ["landlord_address", "landlord_notice_address", "lessor_address"], patterns: [/\blandlord(?:'s)?\s+address\b[:\s-]+([^\n]{6,180})/i, /\baddress\s+of\s+landlord\b[:\s-]+([^\n]{6,180})/i] },
  { key: "tenant_name", group: "lease_header", aliases: ["tenant_name", "tenant", "lessee", "occupant"], patterns: [/\bTENANT[:\s-]+([A-Z][^\n]{2,160}?)(?=\s+(?:By|LANDLORD|LESSOR|Address|whose|having)|\s*\n|$)/, /\bLessee[:\s-]+([A-Z][^\n]{2,160})/] },
  { key: "assignor_name", group: "assignment_amendment", aliases: ["assignor_name", "assignor", "original_tenant", "transferor"], patterns: [/\b(?:assignor|original tenant|transferor)\b[:\s-]+([^\n]{2,160})/i] },
  { key: "assignee_name", group: "assignment_amendment", aliases: ["assignee_name", "assignee", "new_tenant", "transferee"], patterns: [/\b(?:assignee|new tenant|transferee)\b[:\s-]+([^\n]{2,160})/i] },
  { key: "assignment_effective_date", group: "assignment_amendment", aliases: ["assignment_effective_date", "assignment_date"], patterns: [/\b(?:assignment effective date|assignment date|effective date)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { key: "landlord_consent", group: "assignment_amendment", aliases: ["landlord_consent"], patterns: [/\b(landlord[^.\n]{0,120}(?:consents?|approves?)[^.\n]{0,120}(?:assignment|transfer)|consent\s+to\s+assignment[^.\n]{0,160}(?:granted|approved|given))/i] },
  { key: "assumption_scope", group: "assignment_amendment", aliases: ["assumption_scope"], patterns: [/\b(assignee[^.\n]{0,220}\b(?:assumes?|agrees\s+to\s+perform|shall\s+perform)[^.\n]{0,220}(?:obligations|liabilities|lease))/i] },
  { key: "assignee_notice_address", group: "assignment_amendment", aliases: ["assignee_notice_address"], patterns: [/\b(?:assignee(?:'s)?\s+notice\s+address|address\s+for\s+notices\s+to\s+assignee|assignee\s+address)\b[:\s-]+([^\n]{8,220})/i] },
  { key: "assignment_consideration", group: "assignment_amendment", aliases: ["assignment_consideration"], patterns: [/\b(?:assignment\s+consideration|consideration)\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { key: "all_other_terms_remain_same", group: "assignment_amendment", aliases: ["all_other_terms_remain_same"], patterns: [/\b(all\s+other\s+terms[^.\n]{0,160}(?:remain|shall\s+remain|continue)[^.\n]{0,120}(?:unchanged|same|full\s+force\s+and\s+effect))/i] },
  // tenant_contact_name aliases must include tenant_signatory_name (set by
  // the Gemini extractor) so the signer goes here, NOT into tenant_name.
  // The fallback regex for `By: <name>` is left in place for documents
  // where the signer wasn't tagged explicitly.
  { key: "tenant_contact_name", group: "lease_header", aliases: ["tenant_contact_name", "tenant_signatory_name", "signed_by"], patterns: [/\bBy:\s*([A-Z][A-Za-z.' -]{3,80})/, /\btenant(?:\s+contact|\s+representative|\s+signatory)?\b[:\s-]+([A-Z][A-Za-z.' -]{3,80})/i] },
  { key: "tenant_address", group: "lease_header", aliases: ["tenant_address"], patterns: [/\btenant(?:'s)?\s+address\b[:\s-]+([^\n]{6,180})/i] },
  { key: "property_name", group: "premises", aliases: ["property_name"] },
  { key: "property_address", group: "lease_header", aliases: ["property_address", "premises_address", "demised_premises_address", "leased_premises_address", "shopping_center_address", "building_address", "premises_location", "property_location"], patterns: [/\bfor\s+the\s+lease\s+of\s+approximately\s+[\d,]+\s+rentable\s+square\s+feet\s+of\s+space\s+\(?(?:the\s+['"]?premises['"]?)\)?\s+located\s+at\s+([^\n.]{10,220})/i, /\b(?:premises|demised premises|leased premises|leased property|shopping center|the property|the building)\s+(?:is\s+)?(?:located|situated|known|having an address)\s*(?:at|as)?[:\s-]+([^\n]{10,220})/i, /\bpremises\s+located\s+at\s+([^\n.]{10,220})/i, /\baddress\s+of\s+(?:the\s+)?(?:premises|property|building|shopping center)[:\s-]+([^\n]{10,220})/i, /\bpremises[:\s-]+([0-9]{1,6}\s+[A-Z][^\n]{6,200})/i] },
  { key: "suite_number", group: "premises", aliases: ["suite_number", "unit_number", "space_number", "premises_suite"], patterns: [/\b(?:suite|unit|space|apartment)\s+#?\s*([A-Za-z0-9-]+)/i] },
  { key: "rentable_area_sqft", group: "premises", aliases: ["rentable_area_sqft", "tenant_rsf", "square_footage", "leased_premises_area", "square_feet", "rentable_square_feet"], patterns: [/\bapproximately\s+([\d,]+)\s+rentable\s+square\s+feet/i, /(?:premises|leased|tenant)[^\n]{0,60}?([\d,]+)\s*(?:rentable\s+)?(?:square\s*feet|sq\.?\s*ft\.?|\bSF\b|\bRSF\b)/i, /([\d,]+)\s*rentable\s*(?:square\s*feet|sq\.?\s*ft\.?|\bRSF\b)/i] },
  { key: "lease_type", group: "lease_header", aliases: ["lease_type", "expense_structure", "rent_structure", "lease_structure"] },
  { key: "permitted_use", group: "lease_header", aliases: ["permitted_use", "use", "use_of_premises", "use_clause", "premises_use"], clauseType: "use_clause", patterns: [/\b(?:permitted use|use of premises|use of the premises)\b[:\s-]+([^\n.]{4,220})/i] },
  { key: "broker_name", group: "lease_header", aliases: ["broker_name"], patterns: [/\bbroker(?:age)?\b[:\s-]+([^\n]{4,160})/i] },
  { key: "security_deposit_amount", group: "rent_terms", aliases: ["security_deposit_amount", "security_deposit", "deposit"], patterns: [/\b(?:security\s+deposit|deposit)\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  // lease_term: match only concise label-value forms (e.g. "Lease Term: 86 months" or
  // "Term: 7 years"). The old [^\n]{2,120} was too greedy and captured entire clause
  // paragraphs containing unrelated content (grease trap amortization, etc.).
  { key: "lease_term", group: "lease_term", aliases: ["lease_term", "term"], patterns: [/\blease term\b[:\s-]+(\d[^\n]{1,40})/i] },
  { key: "commencement_date", group: "lease_term", aliases: ["commencement_date", "start_date", "lease_commencement_date", "term_commencement_date", "term_start", "beginning_of_term", "commencement"], patterns: [/\b(?:commencement date|lease commencement|term commencement|commences? on)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { key: "expiration_date", group: "lease_term", aliases: ["expiration_date", "end_date", "lease_expiration_date", "termination_date", "term_end", "end_of_term", "expiry_date"], patterns: [/\b(?:expiration date|lease expiration|termination date|term end|ends? on|expires? on)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { key: "renewal_notice_days", group: "lease_term", aliases: ["renewal_notice_days"], patterns: [/\bnotice\b[^\n]{0,60}?(\d{1,3})\s+days?/i] },
  { key: "renewal_escalation_percent", group: "lease_term", aliases: ["renewal_escalation_percent", "escalation_rate"], patterns: [/\brenewal\b[^\n]{0,80}?(\d{1,2}(?:\.\d+)?)\s*%/i] },
  { key: "holdover_rent_multiplier", group: "lease_term", aliases: ["holdover_rent_multiplier"], clauseType: "holdover", patterns: [/\bholdover\b[^\n]{0,80}?(\d(?:\.\d+)?)\s*x/i, /\bholdover\b[^\n]{0,80}?(\d{2,3})\s*%/i] },
  { key: "base_rent_monthly", group: "rent_terms", aliases: ["base_rent_monthly", "monthly_rent", "base_rent", "monthly_base_rent", "current_monthly_rent"], patterns: [/\b(?:base rent|monthly rent|rent)\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:per month|\/month|\/mo|monthly)/i] },
  { key: "annual_rent", group: "rent_terms", aliases: ["annual_rent"], patterns: [/\b(?:annual|yearly|base\s+annual)\s+rent[:\s]+\$?\s*([\d,]+(?:\.\d{2})?)/i, /\b(?:base\s+rent\s+for\s+(?:the\s+)?additional\s+year|additional\s+year\s+base\s+rent|amended\s+base\s+rent|extended\s+term\s+rent)\b[^\n$]{0,100}\$?\s*([\d,]+(?:\.\d{2})?)/i, /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*year|\/year|\/yr|annually)/i] },
  { key: "amended_base_rent_for_additional_year", group: "assignment_amendment", aliases: ["amended_base_rent_for_additional_year"], patterns: [/\b(?:base\s+rent\s+for\s+(?:the\s+)?additional\s+year|additional\s+year\s+base\s+rent|amended\s+base\s+rent|extended\s+term\s+rent)\b[^\n$]{0,100}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { key: "rent_due_day", group: "rent_terms", aliases: ["rent_due_day"], patterns: [/\brent\s+.*due[^\n]{0,20}?day\s+(\d{1,2})/i, /\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+day\s+of\s+each\s+month/i] },
  { key: "rent_frequency", group: "rent_terms", aliases: ["rent_frequency"], patterns: [/\b(monthly|quarterly|annually|annual)\b/i] },
  { key: "rent_payment_timing", group: "rent_terms", aliases: ["rent_payment_timing"], patterns: [/\b(monthly\s+in\s+advance|payable\s+monthly\s+in\s+advance|in\s+advance)\b/i] },
  { key: "late_fee_grace_days", group: "rent_terms", aliases: ["late_fee_grace_days"], patterns: [/\bafter\s+(\d{1,2})\s+days?\b[^\n]{0,30}?late/i] },
  { key: "late_fee_percent", group: "rent_terms", aliases: ["late_fee_percent"], patterns: [/\blate\s+fee\b[^\n]{0,40}?(\d{1,2}(?:\.\d+)?)\s*%/i] },
  { key: "default_interest_rate_formula", group: "rent_terms", aliases: ["default_interest_rate_formula"], clauseType: "default", patterns: [/\b(?:prime rate[^.\n]{0,80}|interest[^.\n]{0,160}maximum legal rate)/i] },
  { key: "building_rsf", group: "premises", aliases: ["building_rsf", "building_square_footage"], patterns: [/building[^\n]{0,40}?([\d,]+)\s*(?:square\s*feet|sq\.?\s*ft\.?|\bRSF\b)/i], manualRequired: true },
  // tenant_rsf must NOT fall back to property-level square_footage; only the
  // explicitly tenant-scoped fields apply. The rentable_area_sqft alias
  // resolves first because the extractor specifically scopes that to the
  // leased premises text.
  { key: "tenant_rsf", group: "premises", aliases: ["tenant_rsf", "rentable_area_sqft"] },
  { key: "floor_plan_reference", group: "premises", aliases: ["floor_plan_reference"], patterns: [/\bexhibit\s+([A-Z0-9-]+)/i] },
  { key: "parking_rights", group: "premises", aliases: ["parking_rights"], patterns: [/\bparking\b[^\n.]{0,180}/i] },
  { key: "common_area_description", group: "premises", aliases: ["common_area_description"], patterns: [/\bcommon areas?\b[^\n.]{0,220}/i] },
  { key: "base_year", group: "expense_terms", aliases: ["base_year"], patterns: [/\bbase year\b[^\n]{0,20}?(\d{4})/i] },
  { key: "base_year_expense_amount", group: "expense_terms", aliases: ["base_year_expense_amount", "base_year_amount"], patterns: [/\bbase year\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { key: "expense_stop_amount", group: "expense_terms", aliases: ["expense_stop_amount"], patterns: [/\bexpense stop\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { key: "expense_stop_unit", group: "expense_terms", aliases: ["expense_stop_unit"], patterns: [/\bexpense stop\b[^\n]{0,80}\b(per\s+square\s+foot|per\s+sf|total amount)\b/i] },
  { key: "fixed_cam_amount", group: "expense_terms", aliases: ["fixed_cam_amount", "cam_amount"], patterns: [/\b(?:fixed cam|cam charge shall be)\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { key: "fixed_cam_frequency", group: "expense_terms", aliases: ["fixed_cam_frequency"], patterns: [/\b(?:fixed cam|cam charge)\b[^\n]{0,80}\b(monthly|annual|annually|yearly)\b/i] },
  { key: "cam_escalation_percent", group: "expense_terms", aliases: ["cam_escalation_percent"], patterns: [/\bcam\b[^\n]{0,80}?(\d{1,2}(?:\.\d+)?)\s*%\s*(?:increase|escalation)/i] },
  { key: "percentage_rate", group: "rent_terms", aliases: ["percentage_rate"], patterns: [/\bpercentage rent\b[^\n]{0,80}?(\d{1,2}(?:\.\d+)?)\s*%/i] },
  { key: "breakpoint_amount", group: "rent_terms", aliases: ["breakpoint_amount"], patterns: [/\b(?:natural breakpoint|artificial breakpoint|breakpoint)\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { key: "breakpoint_type", group: "rent_terms", aliases: ["breakpoint_type"], patterns: [/\b(natural breakpoint|artificial breakpoint)\b/i] },
  { key: "gross_sales_reporting_frequency", group: "rent_terms", aliases: ["gross_sales_reporting_frequency"], patterns: [/\bgross sales\b[^\n]{0,80}\b(monthly|quarterly|annual|annually|yearly)\b/i] },
  { key: "land_area", group: "premises", aliases: ["land_area"], patterns: [/([\d,]+)\s*(?:acres?|land area)/i] },
  { key: "ground_rent", group: "rent_terms", aliases: ["ground_rent"], patterns: [/\bground rent\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { key: "ground_rent_escalations", group: "rent_terms", aliases: ["ground_rent_escalations"], patterns: [/\bground rent\b[^\n]{0,160}\b(escalat(?:ion|es)|increase)\b/i] },
  // Responsibility patterns require an explicit *action* verb (pay / provide /
  // maintain / carry / obtain / be responsible for). A bare "tenant" or
  // "landlord" appearing near the noun is not enough — reimbursement clauses
  // ("Landlord shall maintain insurance and Tenant shall reimburse")
  // mention BOTH parties and the old regex was always returning the first
  // match (landlord) regardless of who pays. The reimbursement keyword is
  // intentionally excluded so we don't misclassify reimbursement clauses
  // as direct responsibility; those land as needs_review via not_found.
  { key: "tax_responsibility", group: "expense_terms",
    aliases: ["tax_responsibility", "responsibility_taxes", "responsibility_tax", "tax_resp"],
    patterns: [
      /\b(?:tax(?:es)?|real estate taxes|property taxes)\b[^.\n]{0,80}\b(landlord|lessor|tenant|lessee)\s+(?:shall|will|must|is\s+(?:required|obligated)\s+to|agrees\s+to)\s+(?:pay|be\s+responsible)/i,
    ],
  },
  { key: "insurance_responsibility", group: "expense_terms",
    aliases: ["insurance_responsibility", "responsibility_insurance"],
    patterns: [
      /\b(?:property\s+insurance|liability\s+insurance|insurance)\b[^.\n]{0,80}\b(landlord|lessor|tenant|lessee)\s+(?:shall|will|must|is\s+(?:required|obligated)\s+to|agrees\s+to)\s+(?:provide|maintain|carry|obtain|procure|keep\s+in\s+force)/i,
    ],
  },
  { key: "maintenance_responsibility", group: "expense_terms",
    aliases: ["maintenance_responsibility", "responsibility_repairs", "responsibility_maintenance"],
    patterns: [
      /\b(?:maintenance|repairs?)\b[^.\n]{0,80}\b(landlord|lessor|tenant|lessee)\s+(?:shall|will|must|is\s+(?:required|obligated)\s+to|agrees\s+to)\s+(?:perform|maintain|repair|be\s+responsible)/i,
    ],
  },
  { key: "permitted_development", group: "premises", aliases: ["permitted_development"], patterns: [/\bpermitted development\b[:\s-]+([^\n.]{4,220})/i] },
  // ── Fields that were missing from FIELD_SPECS but present in the LLM schema.
  // Without these, the LLM's extracted values for these keys are absorbed into
  // the pipeline row but never promoted to lease_fields, so Lease Review
  // resolver finds nothing.
  { key: "rent_commencement_date", group: "dates_term", aliases: ["rent_commencement_date", "rent_start_date", "commencement_of_rent"], patterns: [/\b(?:rent\s+commencement\s+date|commencement\s+of\s+rent|rent\s+start\s+date|rent\s+commencement)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  // escalation_rate = initial-term annual increase.  renewal_escalation_percent
  // (line 200) covers the renewal-period escalation separately.
  { key: "escalation_rate", group: "rent_terms", aliases: ["escalation_rate", "annual_escalation", "base_rent_escalation"], patterns: [/\b(?:annual|base)\s+rent\b[^\n]{0,60}\bincreases?\s+by\s*(\d{1,2}(?:\.\d+)?)\s*%/i, /\bescalation\s+rate\b[:\s]+(\d{1,2}(?:\.\d+)?)\s*%/i, /\brent\b[^\n]{0,60}(?:increases?|escalates?)\s+(?:by\s+)?(\d{1,2}(?:\.\d+)?)\s*%[^\n]{0,40}(?:year|annual|each)/i] },
  // CAM structure fields — schema uses *_pct / *_percent suffixes that the LLM
  // returns verbatim; aliases bridge to whatever the workflow/UI key is.
  { key: "cam_cap_pct", group: "expense_terms", aliases: ["cam_cap_pct", "cam_cap_percent", "cap_percent", "controllable_cap_percent"], patterns: [/\b(?:cam\s+cap|controllable\s+(?:expense|operating\s+expense)s?\s+(?:cap|shall\s+not\s+increase)|operating\s+expense\s+cap)\b[^\n]{0,80}?(\d{1,2}(?:\.\d+)?)\s*%/i, /\bcontrollable\b[^\n]{0,80}?(?:not\s+(?:more|greater)\s+than|no\s+more\s+than)[^\n]{0,40}?(\d{1,2}(?:\.\d+)?)\s*%/i] },
  { key: "gross_up_enabled", group: "expense_terms", aliases: ["gross_up_enabled", "grossup_enabled"], patterns: [/\bgross[\s-]up\b/i] },
  { key: "gross_up_threshold", group: "expense_terms", aliases: ["gross_up_threshold", "gross_up_percent", "grossup_threshold"], patterns: [/\bgross[\s-]up\b[^\n]{0,80}?(\d{2,3})\s*%/i, /(?:less\s+than|below|under)\s+(\d{2,3})\s*%\s+(?:occupied|occupancy)[^\n]{0,80}?(?:gross[\s-]?up|variable\s+expenses?)/i, /gross[\s-]up[^\n]{0,60}?(?:as\s+if|to\s+reflect)[^\n]{0,40}?(\d{2,3})\s*%\s+(?:occupied|occupancy)/i] },
  { key: "hvac_responsibility", group: "expense_terms", aliases: ["hvac_responsibility", "hvac"], patterns: [/\bhvac\b[^\n]{0,120}\b(tenant|landlord|shared)\b/i] },
];

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isBlank(value: unknown) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function normalizeToken(value: unknown) {
  return cleanText(value).toLowerCase();
}

function sourcePageOf(value: any): number | null {
  const page = value?.page ?? value?.page_number ?? value?.source_page ?? null;
  const numeric = Number(page);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function isGenericSourceText(value: unknown) {
  const text = cleanText(value);
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/^(llm extracted|extracted|manual_review|manual review|workflow placeholder|not found|unknown|n\/a|na|null|none|missing)$/i.test(text)) return true;
  if (/(^|\b)(derived from|calculated from|reassigned from|workflow placeholder|fallback|internal)(\b|$)/i.test(lower)) return true;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(text)) return true;
  if (/^[a-z][a-z0-9_]{2,60}$/.test(text)) return true;
  return false;
}

function cleanSourceText(value: unknown) {
  const text = cleanText(value);
  return isGenericSourceText(text) ? null : text;
}

const SOURCE_SNIPPET_MAX_CHARS = 2400;
const SOURCE_SNIPPET_LOOKBACK = 1200;
const SOURCE_SNIPPET_LOOKAHEAD = 1400;
const SOURCE_ABBREVIATIONS = new Set([
  "co", "corp", "inc", "ltd", "llc", "lp", "llp", "mr", "mrs", "ms", "dr",
  "jr", "sr", "st", "ave", "blvd", "rd", "ste", "suite", "no", "jan", "feb",
  "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

function skipSourceBoundaryPadding(text: string, index: number) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function isSourceSentenceEnd(text: string, index: number) {
  const char = text[index];
  if (!".!?".includes(char)) return false;

  if (char === ".") {
    const before = text[index - 1] || "";
    const after = text[index + 1] || "";
    if (/\d/.test(before) && /\d/.test(after)) return false;

    const wordMatch = text.slice(Math.max(0, index - 16), index).match(/([A-Za-z]+)$/);
    if (wordMatch && SOURCE_ABBREVIATIONS.has(wordMatch[1].toLowerCase())) return false;
  }

  let cursor = index + 1;
  while (cursor < text.length && /["')\]]/.test(text[cursor])) cursor += 1;
  return cursor >= text.length || /\s/.test(text[cursor]);
}

function isCleanSnippetStart(snippet: string) {
  return (
    /^[A-Za-z][^:]{0,90}:\s\S/.test(snippet) ||
    /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(snippet) ||
    /^[A-Z0-9"'(]/.test(snippet) ||
    /^(approximately|suite|unit|space|monthly|annual|base rent|rent|permitted use|broker|address|landlord|tenant)\b/i.test(snippet)
  );
}

function isShortCompleteSourceRow(snippet: string) {
  if (!snippet || snippet.length > 260) return false;
  if (/\.{3}|…/.test(snippet)) return false;
  if (!isCleanSnippetStart(snippet)) return false;
  const partyMarkerCount = (snippet.match(/\b(?:landlord|tenant|lessee|lessor|address of landlord|address of tenant)\b/gi) || []).length;
  return partyMarkerCount <= 2;
}

function expandSourceSnippetFromMatch(text: string, matchStart: number, matchLength: number, maxChars = SOURCE_SNIPPET_MAX_CHARS) {
  const source = cleanText(text);
  if (!source) return null;
  const limit = Math.max(420, Math.min(maxChars, SOURCE_SNIPPET_MAX_CHARS));

  if (isShortCompleteSourceRow(source)) return source;
  if (source.length <= limit && isCleanSnippetStart(source)) return source;

  const safeMatchStart = Math.max(0, Math.min(matchStart, source.length));
  const safeMatchEnd = Math.max(safeMatchStart, Math.min(source.length, safeMatchStart + matchLength));
  const searchStart = Math.max(0, safeMatchStart - SOURCE_SNIPPET_LOOKBACK);
  const searchEnd = Math.min(source.length, safeMatchEnd + SOURCE_SNIPPET_LOOKAHEAD);

  let start: number | null = safeMatchStart === 0 ? 0 : null;
  for (let i = safeMatchStart - 1; i >= searchStart; i -= 1) {
    if (isSourceSentenceEnd(source, i)) {
      start = skipSourceBoundaryPadding(source, i + 1);
      break;
    }
  }
  if (start == null && searchStart === 0) start = 0;
  if (start == null) return null;

  let end: number | null = null;
  for (let i = safeMatchEnd; i < searchEnd; i += 1) {
    if (isSourceSentenceEnd(source, i)) {
      end = i + 1;
      break;
    }
  }
  if (end == null && searchEnd === source.length) end = source.length;
  if (end == null) return null;

  const snippet = cleanText(source.slice(start, end));
  if (!snippet || snippet.length > limit || !isCleanSnippetStart(snippet)) return null;
  if (!/[.!?]["')\]]?$/.test(snippet) && !/^[A-Za-z][^:]{0,90}:\s\S/.test(snippet)) return null;
  return snippet;
}

function cleanPartyAddressValue(fieldKey: string, value: unknown) {
  if (!["landlord_address", "tenant_address"].includes(fieldKey)) return value;
  let text = cleanText(value);
  if (!text) return value;

  const ownLabel = fieldKey === "landlord_address"
    ? /(?:^|\b)(?:\d+\.\s*)?(?:address\s+of\s+landlord|landlord(?:'s)?\s+address)\s*[:;-]?\s*/i
    : /(?:^|\b)(?:\d+\.\s*)?(?:address\s+of\s+tenant|tenant(?:'s)?\s+address)\s*[:;-]?\s*/i;
  const ownMatch = text.match(ownLabel);
  if (ownMatch?.index != null) {
    text = text.slice(ownMatch.index + ownMatch[0].length).trim();
  }

  // If after stripping our own label the text immediately starts with the other
  // party's numbered-summary label (e.g. "4. Tenant:"), the address is blank.
  const oppositeStart = fieldKey === "landlord_address"
    ? /^\d+\.\s*(?:tenant|lessee)\b/i
    : /^\d+\.\s*(?:landlord|lessor)\b/i;
  if (oppositeStart.test(text)) return null;

  const stopPatterns = fieldKey === "landlord_address"
    ? [
        /\b\d+\.\s*(?:tenant|lessee)\b\s*[:;-]?/i,
        /\b(?:tenant|lessee)\b\s*[:;-]/i,
        /\b(?:address\s+of\s+tenant|tenant(?:'s)?\s+address)\b/i,
        /\btenant_contact_/i,
      ]
    : [
        /\b\d+\.\s*(?:landlord|lessor)\b\s*[:;-]?/i,
        /\b(?:landlord|lessor)\b\s*[:;-]/i,
        /\b(?:address\s+of\s+landlord|landlord(?:'s)?\s+address)\b/i,
        /\blandlord_contact_/i,
      ];

  let stopAt = text.length;
  for (const pattern of stopPatterns) {
    const match = text.match(pattern);
    if (match?.index != null && match.index > 4) stopAt = Math.min(stopAt, match.index);
  }
  text = text.slice(0, stopAt).trim();
  text = text
    .replace(/^(?:\d+\.\s*)?(?:address\s+of\s+(?:landlord|tenant)|landlord(?:'s)?\s+address|tenant(?:'s)?\s+address)\s*[:;-]?\s*/i, "")
    .replace(/\s+\d+\.\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[;,\s]+$/g, "")
    .trim();

  if (text.length < 8) return value;
  return text;
}

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/[$,%\s,]/g, "");
  const parsed = Number(match);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(value: unknown): string | null {
  if (isBlank(value)) return null;
  const text = cleanText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(start: Date, end: Date): number | null {
  const diff = end.getTime() - start.getTime();
  if (!Number.isFinite(diff)) return null;
  return Math.round(diff / 86_400_000);
}

function parseLeaseTermMonths(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric && numeric > 0) return Math.round(numeric);

  const text = cleanText(value).toLowerCase();
  if (!text) return null;

  const yearMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:year|yr)s?/);
  if (yearMatch) {
    const years = Number(yearMatch[1]);
    if (Number.isFinite(years) && years > 0) return Math.round(years * 12);
  }

  const monthMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:month|mo)s?/);
  if (monthMatch) {
    const months = Number(monthMatch[1]);
    if (Number.isFinite(months) && months > 0) return Math.round(months);
  }

  return null;
}

function humanize(key: string) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getRowConfidence(row: Record<string, unknown>, key: string) {
  const raw =
    row?._field_confidences?.[key] ??
    row?.confidence_scores?.[key] ??
    row?.confidence_score ??
    null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw <= 1 ? Math.round(raw * 100) / 100 : Math.round(raw) / 100;
  }
  return null;
}

/**
 * Pull per-field evidence from the row's `_field_evidence` map. This is
 * stamped by the LLM extractor (validator.ts:flattenRecords) with the
 * source_text / source_page that Gemini quoted verbatim. Honoring this
 * here means workflow_output.lease_fields[key].source_clause / source_page
 * reflect what Gemini actually saw - not whatever the local text-matcher
 * happens to find.
 */
function getLlmEvidenceForAliases(row: Record<string, unknown>, aliases: string[] = []) {
  const evidenceMap = (row?._field_evidence ?? {}) as Record<string, { source_text?: string | null; source_page?: number | null }>;
  for (const alias of aliases) {
    const e = evidenceMap?.[alias];
    if (!e) continue;
    const sourceText = cleanSourceText(e.source_text);
    if (sourceText || typeof e.source_page === "number") {
      return {
        source_text: sourceText,
        source_page: typeof e.source_page === "number" && Number.isFinite(e.source_page) ? e.source_page : null,
      };
    }
  }
  return null;
}

function getFirstValue(row: Record<string, unknown>, aliases: string[] = []) {
  for (const alias of aliases) {
    const value = row?.[alias];
    if (!isBlank(value)) return value;
  }
  return null;
}

function extractPatternValue(text: string, patterns: RegExp[] = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanText(match[1]);
    if (match?.[0]) return cleanText(match[0]);
  }
  return null;
}

function extractClauseSnippet(textBlocks: any[], fullText: string, keywords: string[] = [], maxChars = 1600) {
  const effectiveMax = Math.max(maxChars, 1600);
  const loweredKeywords = keywords.map((keyword) => keyword.toLowerCase());
  for (let index = 0; index < textBlocks.length; index += 1) {
    const blockText = cleanText(textBlocks[index]?.text || "");
    const haystack = blockText.toLowerCase();
    if (!blockText) continue;
    const matchedKeyword = loweredKeywords.find((keyword) => haystack.includes(keyword));
    if (!matchedKeyword) continue;

    // When the matching block is large (e.g. a full summary section that
    // contains many numbered items), return only the sentence/line that
    // contains the keyword rather than the whole block + next 2 blocks.
    // This prevents the generic "SUMMARY OF BASIC LEASE INFORMATION…"
    // prefix from appearing as the source text for unrelated fields.
    let snippet: string | null;
    if (blockText.length > effectiveMax) {
      const idx = haystack.indexOf(matchedKeyword);
      const start = idx;
      const end = Math.min(blockText.length, idx + effectiveMax - 60);
      snippet = (start > 0 ? "…" : "") + blockText.slice(start, end).trim();
      snippet = expandSourceSnippetFromMatch(blockText, idx, matchedKeyword.length, effectiveMax);
    } else {
      snippet = [blockText, cleanText(textBlocks[index + 1]?.text || ""), cleanText(textBlocks[index + 2]?.text || "")]
        .filter(Boolean)
        .join(" ")
        .trim();
    }
    if (blockText.length <= effectiveMax) {
      const joined = [blockText, cleanText(textBlocks[index + 1]?.text || ""), cleanText(textBlocks[index + 2]?.text || "")]
        .filter(Boolean)
        .join(" ");
      if (joined.length <= effectiveMax) {
        snippet = joined;
      } else {
        const idx = joined.toLowerCase().indexOf(matchedKeyword);
        snippet = expandSourceSnippetFromMatch(joined, idx, matchedKeyword.length, effectiveMax);
      }
    }
    if (!snippet) continue;
    return {
      clause_text: snippet || null,
      source_page: Number.isFinite(Number(textBlocks[index]?.page)) ? Number(textBlocks[index].page) : null,
    };
  }

  const sentence = fullText
    .split(/(?<=[.!?])\s+/)
    .map((item) => cleanText(item))
    .find((item) => loweredKeywords.some((keyword) => item.toLowerCase().includes(keyword)));
  if (!sentence) return { clause_text: null, source_page: null };
  return { clause_text: sentence.length <= effectiveMax ? sentence : null, source_page: null };
}

function findEvidenceForValue(doclingRaw: any, fieldKey: string, value: unknown, clauseHint: string | null = null) {
  const textBlocks = asArray(doclingRaw?.text_blocks);
  const docFields = asArray(doclingRaw?.fields);
  const comparableValue = cleanText(value);

  if (clauseHint) {
    const clauseSearch = extractClauseSnippet(textBlocks, cleanText(doclingRaw?.full_text || ""), [clauseHint], 1800);
    if (clauseSearch.clause_text) {
      return {
        source_page: clauseSearch.source_page,
        source_clause: clauseSearch.clause_text,
      };
    }
  }

  // Strict match: only accept a docling field whose KEY semantically aligns
  // with the field we're searching for (key contains the humanized field
  // name). Falling back to a pure value-containment match was causing
  // unrelated rows (e.g. unit_number with value "1110") to be returned as
  // evidence for square_footage when the values happened to overlap.
  const humanizedFieldKey = fieldKey.replace(/_/g, " ").toLowerCase();
  const directField = docFields.find((field) => {
    const fieldValue = cleanText(field?.value || field?.text || "");
    const fieldKeyText = cleanText(field?.key || field?.label || "").toLowerCase();
    if (!fieldValue || !comparableValue) return false;
    const keyMatches = fieldKeyText && fieldKeyText.includes(humanizedFieldKey);
    if (!keyMatches) return false;
    return fieldValue.includes(comparableValue) || comparableValue.includes(fieldValue);
  });
  if (directField) {
    // source_clause MUST be a lease-text snippet, never a field key. Prefer
    // the docling field's text/value (the actual lease language) and never
    // fall back to a key/label identifier string.
    const directText = cleanText(directField?.source_text || directField?.text || directField?.value || "");
    const safeDirectText = cleanSourceText(directText);
    if (safeDirectText) {
      const hit = comparableValue ? safeDirectText.indexOf(comparableValue) : -1;
      const snippet = hit >= 0
        ? expandSourceSnippetFromMatch(safeDirectText, hit, comparableValue.length, 1800)
        : null;
      if (snippet) {
        return {
          source_page: sourcePageOf(directField),
          source_clause: snippet,
        };
      }
    }
  }

  for (const block of textBlocks) {
    const blockText = cleanText(block?.text || "");
    const hit = comparableValue ? blockText.indexOf(comparableValue) : -1;
    if (hit < 0) continue;
    const snippet = expandSourceSnippetFromMatch(blockText, hit, comparableValue.length, 1800);
    if (!snippet) continue;
    return {
      source_page: sourcePageOf(block),
      source_clause: snippet,
    };
  }

  const directBlock = null;
  if (directBlock) {
    const blockText = cleanText(directBlock?.text || "");
    // When the block is large (e.g. a full summary section), extract just the
    // sentence or line that contains the value instead of truncating the whole block.
    // This gives a precise verbatim snippet rather than a broad context dump.
    let snippet = null;
    if (blockText.length > 320 && comparableValue) {
      const idx = blockText.indexOf(comparableValue);
      if (idx >= 0) {
        const start = idx;
        const end = Math.min(blockText.length, idx + comparableValue.length + 80);
        snippet = (start > 0 ? "…" : "") + blockText.slice(start, end).trim() + (end < blockText.length ? "…" : "");
      }
    }
    return {
      source_page: sourcePageOf(directBlock),
      source_clause: snippet || null,
    };
  }

  return {
    source_page: null,
    source_clause: null,
  };
}

function containsAny(text: string, phrases: string[]) {
  const haystack = normalizeToken(text);
  return phrases.some((phrase) => haystack.includes(normalizeToken(phrase)));
}

/**
 * Returns true when the source text is contextually relevant to the field.
 * Prevents unrelated text blocks from being attached as source evidence.
 * A field with a good value but irrelevant source_clause will have its
 * source_clause cleared to null (shows "No source") instead of showing
 * a misleading snippet.
 */
function isSourceRelevantToField(fieldKey: string, sourceText: string | null): boolean {
  if (!sourceText || sourceText.trim().length < 4) return false;
  const haystack = sourceText.toLowerCase();

  const FIELD_KEYWORDS: Record<string, string[]> = {
    tenant_name:           ["tenant", "lessee", "occupant", "assignee"],
    tenant_signatory_name: ["tenant", "lessee", "by:", "signed by", "authorized signer"],
    landlord_name:         ["landlord", "lessor", "owner", "licensor"],
    landlord_signatory_name: ["landlord", "lessor", "by:", "signed by"],
    property_name:         ["property", "building", "premises", "project", "development", "shopping center", "center"],
    property_address:      ["premises", "property", "building", "located at", "address of", "shopping center"],
    premises_address:      ["premises", "property", "building", "located at", "address of", "shopping center"],
    landlord_address:      ["landlord", "lessor", "address of landlord", "landlord's address"],
    tenant_address:        ["tenant", "lessee", "address of tenant", "tenant's address"],
    permitted_use:         ["use", "permitted use", "use of premises", "purpose"],
    square_footage:        ["square feet", "sq ft", "sf", "rsf", "rentable", "premises", "approximately"],
    rentable_area_sqft:    ["square feet", "sq ft", "sf", "rsf", "rentable", "premises"],
    tenant_rsf:            ["square feet", "sf", "rsf", "rentable", "tenant"],
    monthly_rent:          ["rent", "base rent", "monthly rent", "monthly base rent", "per month"],
    annual_rent:           ["rent", "annual rent", "per year", "yearly"],
    rent_per_sf:           ["rent", "per square", "per sf", "per rsf", "$/sf"],
    billing_frequency:     ["monthly", "quarterly", "annual", "rent", "payment"],
    escalation_rate:       ["escalat", "increase", "percent", "annual", "rent"],
    security_deposit:      ["security deposit", "deposit", "security"],
    lease_type:            ["full service", "gross", "triple net", "nnn", "modified gross", "net lease", "expense structure", "base year", "full service gross"],
    responsibility_taxes:  ["tax", "real estate tax", "property tax", "assessment"],
    responsibility_insurance: ["insurance", "liability", "coverage", "property insurance"],
    responsibility_utilities: ["utilities", "utility", "electric", "gas", "water", "hvac"],
    responsibility_repairs:   ["repairs", "maintenance", "repair", "maintain"],
    cam_cap_pct:           ["cam", "common area", "cap", "controllable", "operating expenses"],
    cam_cap_type:          ["cam", "common area", "cap", "cumulative", "non-cumulative"],
    admin_fee_pct:         ["admin", "administrative fee", "management fee", "percent"],
    hvac_responsibility:   ["hvac", "heating", "cooling", "air conditioning"],
    gross_up_enabled:      ["gross up", "gross-up", "occupancy"],
    general_liability_min: ["insurance", "liability", "coverage", "commercial general"],
    waiver_of_subrogation: ["waiver", "subrogation", "insurance"],
    additional_insureds_required: ["additional insured", "insured", "insurance"],
    tenant_insurance_required:    ["insurance", "liability", "coverage", "tenant shall maintain"],
    property_insurance_responsibility: ["property insurance", "insurance", "landlord", "tenant"],
    right_of_first_refusal: ["first refusal", "rofr", "right of first"],
    early_termination_option: ["early termination", "terminate", "termination option"],
    assignment_provisions:  ["assignment", "assign", "transfer"],
    landlord_consent_for_transfer: ["assignment", "assign", "transfer", "consent"],
    default_cure_period:   ["default", "cure", "notice", "days"],
  };

  const required = FIELD_KEYWORDS[fieldKey];
  if (!required) return true; // no constraint for this field — accept any source
  return required.some((kw) => haystack.includes(kw.toLowerCase()));
}

function isMoneyLike(text: unknown): boolean {
  return /\$\s*\d|(?:^|\s)\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b|\b\d+(?:\.\d{2})?\s*(?:dollars?|usd)\b/i.test(cleanText(text));
}

function normalizeLeaseTypeValue(value: unknown): string | null {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return null;
  if (/\b(?:nnn|triple\s+net|triple-net)\b/.test(raw)) return "nnn";
  if (/\b(?:full\s+service|full-service|full\s+service\s+gross)\b/.test(raw)) return "full_service";
  if (/\bmodified\s+gross\b/.test(raw)) return "modified_gross";
  if (/\bgross\b/.test(raw)) return "gross";
  return null;
}

function fieldValueLooksInvalid(fieldKey: string, value: unknown, sourceText: string | null) {
  const valueText = cleanText(value);
  const source = cleanText(sourceText).toLowerCase();
  const combined = `${valueText} ${source}`.toLowerCase();
  if (!valueText) return null;

  if (fieldKey === "suite_number") {
    if (/\b(?:per|rent|dollar|square\s+foot|leasable|rsf|sf|monthly|annual)\b/i.test(valueText)) {
      return "suite_number_not_identifier";
    }
    if (!/^(?:suite|unit|space|#)?\s*[A-Za-z0-9-]{1,12}$/i.test(valueText)) {
      return "suite_number_invalid_format";
    }
  }

  if (["base_rent_monthly", "annual_rent", "security_deposit_amount", "ti_allowance"].includes(fieldKey)) {
    if (!isMoneyLike(valueText) && !isMoneyLike(sourceText)) return "money_field_without_money_evidence";
    if (fieldKey === "base_rent_monthly" && !/\b(?:rent|monthly|per\s+month|base\s+rent)\b/.test(combined)) {
      return "monthly_rent_without_rent_context";
    }
    if (fieldKey === "security_deposit_amount" && !/\bsecurity\s+deposit\b/.test(combined)) {
      return "security_deposit_without_deposit_context";
    }
    if (fieldKey === "ti_allowance" && !/\b(?:tenant\s+improvement|ti\s+allowance|allowance)\b/.test(combined)) {
      return "ti_allowance_without_ti_context";
    }
  }

  if (fieldKey === "property_name") {
    if (
      valueText.length < 4 ||
      /^(?:a|the|shopping|a shopping|shopping center|center|premises|property)$/i.test(valueText) ||
      /(?:shall|hereby|premises|article|section|rent|maintenance|insurance|taxes)/i.test(valueText)
    ) {
      return "property_name_not_specific";
    }
  }

  if (["tenant_name", "landlord_name", "broker_name", "tenant_contact_name"].includes(fieldKey)) {
    if (valueText.length > 90 || /(?:shall|hereby|premises|article|section|rent|maintenance|insurance|taxes)/i.test(valueText)) {
      return "party_name_looks_like_clause_text";
    }
  }

  if (fieldKey === "lease_type" && !normalizeLeaseTypeValue(valueText)) {
    return "lease_type_unknown";
  }

  return null;
}

function excerptForKeywords(textBlocks: any[], fullText: string, keywords: string[]) {
  // Returns the actual document snippet containing one of the keywords, or
  // null if no real text matched. Previously fell back to `keywords[0]`
  // (e.g. "real estate tax"), which leaked the canonical category KEY into
  // the rule's source_text — the UI then displayed that as if it were
  // verbatim source evidence. Now we return null so downstream code can
  // mark the rule as missing source evidence instead of faking it.
  const snippet = extractClauseSnippet(textBlocks, fullText, keywords, 1800);
  return snippet.clause_text || null;
}

function inferLeaseSignals(text: string, row: Record<string, unknown>) {
  const normalized = normalizeToken(text);
  const tenantPaysTaxes = containsAny(normalized, [
    "tenant shall pay taxes",
    "tenant pays taxes",
    "real estate taxes shall be paid by tenant",
    "taxes and assessments shall be paid by tenant",
  ]) || /nnn|triple net|double net|single net|ground lease|absolute net/.test(normalized);

  const tenantPaysInsurance = containsAny(normalized, [
    "tenant shall pay insurance",
    "tenant pays insurance",
    "property insurance shall be paid by tenant",
  ]) || /nnn|triple net|double net|ground lease|absolute net/.test(normalized);

  const tenantPaysCAM = containsAny(normalized, [
    "tenant shall pay common area maintenance",
    "tenant shall pay cam",
    "common area maintenance shall be paid by tenant",
  ]) || /nnn|triple net|absolute net/.test(normalized);

  const allOperatingExpensesIncludedInRent =
    containsAny(normalized, [
      "full service lease",
      "full-service lease",
      "gross lease",
      "expenses are included in rent",
      "operating expenses are included in rent",
      "taxes, insurance and common area maintenance are included",
    ]) ||
    (containsAny(normalized, ["included in rent"]) && !tenantPaysTaxes && !tenantPaysInsurance && !tenantPaysCAM);

  const someExpensesIncluded = containsAny(normalized, [
    "included in rent",
    "landlord shall provide",
    "landlord shall pay",
  ]);

  const someExpensesRecoverable = containsAny(normalized, [
    "tenant shall reimburse",
    "tenant shall pay",
    "additional rent",
    "recoverable",
    "reimbursable",
    "separately billed",
  ]);

  const fixedCamDetected = containsAny(normalized, [
    "fixed cam",
    "fixed common area maintenance",
    "cam charge shall be",
  ]) || asNumber(row?.fixed_cam_amount) != null;

  const percentageRentDetected = containsAny(normalized, [
    "percentage rent",
    "gross sales",
    "natural breakpoint",
    "artificial breakpoint",
  ]) || asNumber(row?.percentage_rate) != null;

  const baseYearDetected = containsAny(normalized, [
    "base year",
    "expenses in excess of base year",
    "base year expenses",
  ]) || asNumber(row?.base_year) != null;

  const expenseStopDetected = containsAny(normalized, [
    "expense stop",
    "expenses over",
    "expense threshold",
  ]) || asNumber(row?.expense_stop_amount) != null;

  const groundLeaseDetected = containsAny(normalized, ["ground lease", "land only"]);
  const absoluteNetDetected = containsAny(normalized, ["absolute net", "bondable net"]);
  const industrialGrossDetected = containsAny(normalized, ["industrial gross"]);

  return {
    tenantPaysTaxes,
    tenantPaysInsurance,
    tenantPaysCAM,
    allOperatingExpensesIncludedInRent,
    someExpensesIncluded,
    someExpensesRecoverable,
    fixedCamDetected,
    percentageRentDetected,
    baseYearDetected,
    expenseStopDetected,
    groundLeaseDetected,
    absoluteNetDetected,
    industrialGrossDetected,
  };
}

function classifyLeaseType(text: string, extractedExpenseRules: any[], signals: Record<string, boolean>) {
  if (containsAny(text, ["full service lease", "full-service lease"])) {
    return "Full Service";
  }
  if (containsAny(text, ["triple net", "nnn", "taxes, insurance and common area maintenance"])) {
    return "Triple Net";
  }
  // Check Modified Gross BEFORE base_year — a "Modified Gross with Base Year" document
  // contains BOTH phrases. Checking base_year first would misclassify it as "Base Year"
  // and lose the Modified Gross signal from the document title/body.
  if (containsAny(text, ["modified gross", "modified-gross"])) {
    return "Modified Gross";
  }
  if (containsAny(text, ["base year", "expenses in excess of base year", "base year expenses"])) {
    return "Base Year";
  }
  if (containsAny(text, ["expense stop", "expenses over", "expense threshold"])) {
    return "Expense Stop";
  }
  if (containsAny(text, ["percentage rent", "gross sales", "natural breakpoint", "artificial breakpoint"])) {
    return "Percentage Rent";
  }
  if (containsAny(text, ["fixed cam", "fixed common area maintenance", "cam charge shall be"])) {
    return "Fixed CAM";
  }
  if (signals.groundLeaseDetected) return "Ground Lease";
  if (signals.absoluteNetDetected) return "Absolute Net";
  if (signals.industrialGrossDetected) return "Industrial Gross";
  if (signals.tenantPaysTaxes && signals.tenantPaysInsurance && signals.tenantPaysCAM) {
    return "Triple Net";
  }
  if (signals.tenantPaysTaxes && signals.tenantPaysInsurance && !signals.tenantPaysCAM) {
    return "Double Net";
  }
  if (signals.tenantPaysTaxes && !signals.tenantPaysInsurance && !signals.tenantPaysCAM) {
    return "Single Net";
  }
  if (signals.someExpensesIncluded && signals.someExpensesRecoverable) {
    return "Modified Gross";
  }
  if (signals.allOperatingExpensesIncludedInRent) {
    return "Gross Lease";
  }

  const recoverableRules = extractedExpenseRules.filter((rule) => ["yes", "conditional", true].includes(rule?.recoverable_from_tenant as any)).length;
  const includedRules = extractedExpenseRules.filter((rule) => rule?.included_in_base_rent === true).length;
  if (includedRules > 0 && recoverableRules > 0) return "Hybrid / Custom";
  return "Unknown / Manual Review";
}

function extractInsuranceStructure(text: string) {
  const matchAmount = (pattern: RegExp) => {
    const match = text.match(pattern);
    return match?.[1] ? asNumber(match[1]) : null;
  };
  return {
    commercial_general_liability_required: /\bgeneral liability\b/i.test(text),
    liability_limit_each_occurrence: matchAmount(/(\$?[\d,]+(?:\.\d{2})?)\s*(?:each occurrence|per occurrence)/i),
    liability_limit_aggregate: matchAmount(/(\$?[\d,]+(?:\.\d{2})?)\s*(?:aggregate)/i),
    tenant_property_insurance_required: /\bproperty insurance\b/i.test(text),
    workers_comp_required: /\bworkers'? compensation\b/i.test(text),
    certificate_required: /\bcertificate of insurance\b/i.test(text),
  };
}

function buildClauseRecords(doclingRaw: any, fullText: string) {
  const textBlocks = asArray(doclingRaw?.text_blocks);
  return CLAUSE_DEFINITIONS.map((definition) => {
    const snippet = extractClauseSnippet(textBlocks, fullText, definition.keywords, Math.max(definition.maxChars, 2000));
    const clauseText = snippet.clause_text;
    let structuredFieldsJson: Record<string, unknown> = {};

    if (definition.type === "insurance" && clauseText) {
      structuredFieldsJson = extractInsuranceStructure(clauseText);
    }

    return {
      clause_type: definition.type,
      clause_title: definition.title,
      clause_text: clauseText,
      source_page: snippet.source_page,
      confidence_score: clauseText ? 0.78 : 0.25,
      structured_fields_json: structuredFieldsJson,
    };
  });
}

const BUSINESS_AREA_BY_FIELD_GROUP: Record<string, string> = {
  lease_header: "parties_premises",
  premises: "parties_premises",
  lease_term: "dates_term",
  rent_terms: "rent_charges",
  expense_terms: "expenses_recoveries",
  insurance: "insurance",
  assignment_amendment: "assignment_amendment",
};

const BUSINESS_AREA_BY_CLAUSE_TYPE: Record<string, string> = {
  rent_clause: "rent_charges",
  operating_expense_recovery: "expenses_recoveries",
  cam_recoveries: "cam_rules",
  insurance_requirements: "insurance",
  renewal_option: "critical_dates",
  termination: "critical_dates",
  assignment_subletting: "assignment_amendment",
  notices: "assignment_amendment",
  defaults_remedies: "legal_options",
  late_fees: "rent_charges",
  alterations: "legal_options",
  holdover: "rent_charges",
};

const FIXED_REVIEW_FIELD_KEYS = new Set([
  "tenant_name",
  "landlord_name",
  "property_address",
  "premises_address",
  "rentable_area_sqft",
  "square_footage",
  "premises_use",
  "permitted_use",
  "lease_date",
  "commencement_date",
  "rent_commencement_date",
  "expiration_date",
  "renewal_notice_months",
  "termination_notice_months",
  "option_exercise_deadline",
  "monthly_rent",
  "base_rent_monthly",
  "annual_rent",
  "rent_frequency",
  "billing_frequency",
  "escalation_type",
  "escalation_rate",
  "escalation_timing",
  "free_rent_months",
  "ti_allowance",
  "security_deposit_amount",
  "security_deposit",
  "lease_type",
  "tax_responsibility",
  "insurance_responsibility",
  "utilities_responsibility",
  "maintenance_responsibility",
  "base_year",
  "expense_stop",
  "cam_cap_type",
  "cap_percent",
  "admin_fee_percent",
  "management_fee_basis",
  "hvac_responsibility",
  "gross_up_enabled",
  "gross_up_percent",
  "tenant_insurance_required",
  "general_liability_min",
  "property_insurance_responsibility",
  "waiver_of_subrogation",
  "additional_insureds_required",
  "renewal_type",
  "renewal_options",
  "right_of_first_refusal",
  "early_termination_option",
  "assignment_provisions",
  "default_cure_period",
]);

function titleizeItemLabel(value: unknown) {
  return cleanText(value || "Discovered Field")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function displayTabForItem(itemType: unknown, businessArea: unknown, fieldKey?: unknown) {
  const type = normalizeToken(itemType);
  const area = normalizeToken(businessArea);
  const key = normalizeToken(fieldKey || itemType);
  if (area === "assignment_amendment") {
    if (/(assignor|assignee|tenant|landlord|notice address|address|premises)/.test(key)) return "parties_premises";
    if (/(date|term|expiration|commencement|effective|signature|consent date)/.test(key)) return "dates_term";
    if (/(rent|consideration|fee|charge|amount|deposit)/.test(key)) return "rent_charges";
    return "legal_options";
  }
  if (area === "critical_dates") return "dates_term";
  if ([
    "parties_premises",
    "dates_term",
    "rent_charges",
    "expenses_recoveries",
    "cam_rules",
    "insurance",
    "legal_options",
  ].includes(area)) return area;
  if (/(insurance|insured|subrogation|certificate)/.test(type)) return "insurance";
  if (/(cam|gross up|cap|admin|management|base year|expense stop|reconciliation|audit|capital expenditure)/.test(type)) return "cam_rules";
  if (/(tax|utility|repair|recover|expense|direct|base rent|exclusion)/.test(type)) return "expenses_recoveries";
  if (/(rent|fee|charge|deposit|interest|holdover|allowance|consideration)/.test(type)) return "rent_charges";
  if (/(date|term|deadline|expiration|commencement|effective)/.test(type)) return "dates_term";
  if (/(assign|consent|assumption|default|remedy|surrender|alteration|indemnity|sublet)/.test(type)) return "legal_options";
  return "clause_records";
}

const UNIVERSAL_ITEM_DEFS = [
  { item_type: "lease_date", business_area: "dates_term", field_key: "lease_date", maps: true, patterns: [/\b(?:lease\s+date|dated)\b[^\n]{0,40}?([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i] },
  { item_type: "original_lease_date", business_area: "dates_term", field_key: "lease_date", maps: true, patterns: [/\bLease\s+dated\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i] },
  { item_type: "premises_square_footage", business_area: "parties_premises", field_key: "rentable_area_sqft", maps: true, patterns: [/\bapproximately\s+([\d,]+)\s+rentable\s+square\s+feet/i, /\b(?:premises|leased premises|demised premises)[^.\n]{0,120}?([\d,]+)\s+rentable\s+square\s+feet/i, /\b([\d,]+)\s+rentable\s+square\s+feet[^.\n]{0,120}?(?:premises|leased premises|demised premises)/i] },
  { item_type: "premises_address", business_area: "parties_premises", field_key: "property_address", maps: true, patterns: [/\bfor\s+the\s+lease\s+of\s+approximately\s+[\d,]+\s+rentable\s+square\s+feet\s+of\s+space\s+\(?(?:the\s+['"]?premises['"]?)\)?\s+located\s+at\s+([^\n.]{10,220})/i, /\bpremises\s+located\s+at\s+([0-9]{2,6}[^.\n]{8,220})/i, /\b(?:premises|leased premises|demised premises)[^.\n]{0,120}?(?:located|address|known)\s+(?:at|as)?\s*([0-9]{2,6}[^.\n]{8,220})/i] },
  { item_type: "landlord", business_area: "parties_premises", field_key: "landlord_name", maps: true, patterns: [/\b(?:landlord|lessor)\b[:\s-]+([A-Z][^\n]{2,140}?)(?=\s+(?:and|,?\s*a\s|By:|Assignor|Assignee|Tenant|Lessee)|\n|$)/i] },
  { item_type: "assignor", business_area: "assignment_amendment", field_key: "assignor_name", maps: true, patterns: [/\b(?:assignor|original tenant|transferor)\b[:\s-]+([^\n]{2,160})/i] },
  { item_type: "assignee_current_tenant", business_area: "assignment_amendment", field_key: "tenant_name", maps: true, patterns: [/\b(?:assignee|new tenant|transferee)\s*[:\-]\s*([A-Z][A-Za-z0-9.,&'\- ]{2,100}?(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|LLP|Trust|Holdings|Partners?))/i] },
  { item_type: "assignee_name", business_area: "assignment_amendment", field_key: "assignee_name", maps: true, patterns: [/\b(?:assignee|new tenant|transferee)\s*[:\-]\s*([A-Z][A-Za-z0-9.,&'\- ]{2,100}?(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|LLP|Trust|Holdings|Partners?))/i] },
  { item_type: "assignment_effective_date", business_area: "assignment_amendment", field_key: "assignment_effective_date", maps: true, patterns: [/\b(?:assignment effective date|assignment date|effective date)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { item_type: "assignment_consideration", business_area: "assignment_amendment", field_key: "assignment_consideration", maps: false, patterns: [/\b(?:assignment\s+consideration|consideration)\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { item_type: "assumption_of_obligations", business_area: "assignment_amendment", field_key: "assumption_scope", maps: true, booleanValue: "yes", patterns: [/\b(assignee[^.\n]{0,220}\b(?:assumes?|agrees\s+to\s+perform|shall\s+perform)[^.\n]{0,220}(?:obligations|liabilities|lease))/i] },
  { item_type: "landlord_consent", business_area: "assignment_amendment", field_key: "landlord_consent", maps: true, booleanValue: "yes", patterns: [/\b(landlord[^.\n]{0,120}(?:consents?|approves?)[^.\n]{0,120}(?:assignment|transfer)|consent\s+to\s+assignment[^.\n]{0,160}(?:granted|approved|given))/i] },
  { item_type: "amended_expiration_date", business_area: "dates_term", field_key: "expiration_date", maps: true, patterns: [/\binitial\s+Term\s+shall\s+now\s+expire\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i, /\b(?:amended\s+expiration\s+date|expiration\s+date\s+is\s+amended\s+to|term\s+is\s+extended\s+to|extended\s+through|expiring|expires?\s+on)\b[:\s-]*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { item_type: "amended_base_rent_for_additional_year", business_area: "rent_charges", field_key: "annual_rent", maps: true, patterns: [/\b(?:base\s+rent\s+for\s+(?:the\s+)?additional\s+year|additional\s+year\s+base\s+rent|amended\s+base\s+rent|extended\s+term\s+rent)\b[^\n$]{0,100}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { item_type: "assignee_notice_address", business_area: "assignment_amendment", field_key: "assignee_notice_address", maps: true, patterns: [/\b(?:assignee(?:'s)?\s+notice\s+address|address\s+for\s+notices\s+to\s+assignee|assignee\s+address)\b[:\s-]+([^\n]{8,220})/i] },
  { item_type: "all_other_terms_remain_same", business_area: "assignment_amendment", field_key: "all_other_terms_remain_same", maps: false, booleanValue: "yes", patterns: [/\b(all\s+other\s+terms[^.\n]{0,160}(?:remain|shall\s+remain|continue)[^.\n]{0,120}(?:unchanged|same|full\s+force\s+and\s+effect))/i] },
];

const ASSIGNMENT_PROFILE_SIGNALS = [
  { key: "assignment_and_assumption", pattern: /\bassignment\s+and\s+assumption\b/i },
  { key: "assignment_of_lease", pattern: /\bassignment\s+of\s+(?:the\s+)?lease\b/i },
  { key: "assignor", pattern: /\bassignor\b/i },
  { key: "assignee", pattern: /\bassignee\b/i },
  { key: "landlord_consent", pattern: /\blandlord\s+consent\b/i },
  { key: "consent_to_assignment", pattern: /\bconsent\s+to\s+assignment\b/i },
  { key: "assignee_assumes_obligations", pattern: /\bassignee[^.\n]{0,220}\b(?:assumes?|agrees\s+to\s+perform|shall\s+perform)[^.\n]{0,220}(?:obligations|liabilities|lease)\b/i },
  { key: "assignment_effective_date", pattern: /\bassignment\s+effective\s+date\b/i },
  { key: "original_lease_reference", pattern: /\boriginal\s+lease\b|\blease\s+dated\s+[a-z]+\s+\d{1,2},?\s+\d{4}/i },
];

const AMENDMENT_PROFILE_SIGNALS = [
  { key: "amendment", pattern: /\bamendment\b/i },
  { key: "amended", pattern: /\bamended\b|\bamend(?:s|ed)?\b/i },
  { key: "modification", pattern: /\bmodification\b|\bmodified\b/i },
  { key: "initial_term_now_expire", pattern: /\binitial\s+term\s+shall\s+now\s+expire\b/i },
  { key: "term_extension", pattern: /\b(?:term\s+is\s+extended|extended\s+term|extension\s+term|extended\s+through)\b/i },
  { key: "amended_base_rent", pattern: /\b(?:base\s+rent\s+for\s+(?:the\s+)?additional\s+year|amended\s+base\s+rent|additional\s+year\s+base\s+rent)\b/i },
  { key: "all_other_terms_remain_unchanged", pattern: /\ball\s+other\s+terms[^.\n]{0,180}(?:remain|continue|shall\s+remain)[^.\n]{0,120}(?:unchanged|same|full\s+force\s+and\s+effect)\b/i },
];

function profileSignalContext(
  fullText: string,
  documentSubtype?: string | null,
  leaseFields?: Record<string, LeaseWorkflowField>,
  extractedItems?: any[],
) {
  const fieldContext = Object.entries(leaseFields || {})
    .filter(([, field]) => !isBlank(field?.value))
    .map(([key, field]) => `${key}: ${field?.value}`)
    .join(" ");
  const itemContext = asArray(extractedItems)
    .map((item) => `${item?.item_type || ""} ${item?.field_key || ""} ${item?.business_area || ""} ${item?.value || ""} ${item?.source_text || ""}`)
    .join(" ");
  return cleanText(`${documentSubtype || ""} ${fullText || ""} ${fieldContext} ${itemContext}`);
}

// Patterns that mark a document as an amendment at the TITLE/HEADING level
// (not in a passing clause mention). Full leases frequently contain phrases
// like "may not be amended" or "no modification" — those would trip the
// generic AMENDMENT_PROFILE_SIGNALS list but should NOT cause the document
// to be classified as an amendment. Requiring at least one of these strong
// signals before applying the amendment label prevents the false positive
// that triggers the assignment/amendment short-circuit on a real lease.
//
// Strong signal examples that should match:
//   "FIRST AMENDMENT TO LEASE"
//   "Amendment to Lease Agreement"
//   "Modification of Lease"
//   "Second Amended and Restated Lease"
// Strong signal examples that should NOT match (in body clauses):
//   "this Lease may not be amended except in writing"
//   "no modification of any term shall be binding"
const AMENDMENT_TITLE_SIGNALS = [
  // Ordinal/numeric amendment in a title position.
  { key: "amendment_title_ordinal", pattern: /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\d+(?:st|nd|rd|th))\s+amendment\b/i },
  // Bare "Amendment to / of (the) Lease/Agreement".
  { key: "amendment_to_lease", pattern: /\bamendment\s+(?:to|of)\s+(?:the\s+)?(?:lease|sublease|agreement|tenancy)\b/i },
  // "Modification of Lease/Agreement" in a title position.
  { key: "modification_of_lease", pattern: /\bmodification\s+of\s+(?:the\s+)?(?:lease|sublease|agreement|tenancy)\b/i },
  // "Amended and Restated …" title phrase.
  { key: "amended_and_restated", pattern: /\bamended\s+and\s+restated\b/i },
];

// Patterns that read as title/heading positioning when found in the
// document's first ~1500 chars OR in the document subtype. We deliberately
// do NOT scan the whole document body for these, because that's what
// causes false positives on full leases.
function isStrongAmendmentSignal(fullText: string, documentSubtype?: string | null) {
  const subtype = String(documentSubtype || "");
  const head = String(fullText || "").slice(0, 1500);
  for (const { pattern } of AMENDMENT_TITLE_SIGNALS) {
    if (pattern.test(subtype) || pattern.test(head)) return true;
  }
  return false;
}

function detectDocumentProfileSignals(
  fullText: string,
  documentSubtype?: string | null,
  leaseFields?: Record<string, LeaseWorkflowField>,
  extractedItems?: any[],
) {
  const context = profileSignalContext(fullText, documentSubtype, leaseFields, extractedItems);
  const subtype = normalizeToken(documentSubtype || "");
  const assignmentSignals = ASSIGNMENT_PROFILE_SIGNALS
    .filter((signal) => signal.pattern.test(context))
    .map((signal) => signal.key);
  const amendmentSignals = AMENDMENT_PROFILE_SIGNALS
    .filter((signal) => signal.pattern.test(context))
    .map((signal) => signal.key);

  if (/\bassignment\b/i.test(subtype) && !assignmentSignals.includes("document_subtype_assignment")) {
    assignmentSignals.unshift("document_subtype_assignment");
  }
  if (/\bamend(?:ment|ed)?\b/i.test(subtype) && !amendmentSignals.includes("document_subtype_amendment")) {
    amendmentSignals.unshift("document_subtype_amendment");
  }

  const assignmentSignalCount = assignmentSignals.length;
  const amendmentSignalCount = amendmentSignals.length;
  // Strong amendment context — title, heading, or explicit subtype. Without
  // at least one of these, the soft "amendment" / "modification" mentions
  // are treated as passing clause text rather than the document's own type.
  const hasStrongAmendmentContext = isStrongAmendmentSignal(fullText, documentSubtype);
  const explicitLeaseExpenseSignals = [
    /\b(?:common\s+area\s+maintenance|cam|operating\s+expenses?)\b/i,
    /\b(?:real\s+estate\s+taxes|property\s+taxes|tax\s+escalation|expense\s+stop|base\s+year)\b/i,
    /\b(?:property\s+insurance|insurance\s+premiums?|commercial\s+general\s+liability)\b/i,
    /\b(?:utilities|electricity|water|sewer|gas|janitorial|trash|security|landscap|snow\s+removal)\b/i,
    /\b(?:gross[\s-]?up|controllable\s+expense\s+cap|management\s+fee|administrative\s+fee|reconciliation)\b/i,
  ].filter((pattern) => pattern.test(context)).length;
  const fullLeaseSignals = [
    /\blease\s+agreement\b|\bstandard\s+form\s+lease\b|\bthis\s+lease\b/i,
    /\bpremises\b|\bdemised\s+premises\b|\bleased\s+premises\b/i,
    /\bcommencement\s+date\b|\bexpiration\s+date\b|\bterm\b/i,
    /\bbase\s+rent\b|\brent\s+schedule\b|\bmonthly\s+rent\b|\bannual\s+rent\b/i,
  ].filter((pattern) => pattern.test(context)).length;
  const strongFullLeaseSignals = explicitLeaseExpenseSignals >= 1 || fullLeaseSignals >= 3;
  let selectedDocumentProfile = "full_lease";

  if (/abstract|summary/.test(subtype)) selectedDocumentProfile = "abstract";
  else if (/addendum/.test(subtype)) selectedDocumentProfile = "addendum";
  else if (/exhibit/.test(subtype)) selectedDocumentProfile = "exhibit";
  else if (!strongFullLeaseSignals && assignmentSignalCount >= 2 && amendmentSignalCount >= 1 && hasStrongAmendmentContext) selectedDocumentProfile = "assignment_amendment";
  else if (!strongFullLeaseSignals && assignmentSignalCount >= 2) selectedDocumentProfile = "assignment";
  else if (!strongFullLeaseSignals && amendmentSignalCount >= 2 && hasStrongAmendmentContext) selectedDocumentProfile = "amendment";

  return {
    selected_document_profile: selectedDocumentProfile,
    assignment_signal_count: assignmentSignalCount,
    amendment_signal_count: amendmentSignalCount,
    has_strong_amendment_context: hasStrongAmendmentContext,
    explicit_lease_expense_signal_count: explicitLeaseExpenseSignals,
    full_lease_signal_count: fullLeaseSignals,
    strong_full_lease_signals: strongFullLeaseSignals,
    profile_detection_signals: {
      document_subtype: documentSubtype || null,
      assignment: assignmentSignals,
      amendment: amendmentSignals,
      strong_amendment_context: hasStrongAmendmentContext,
      explicit_lease_expense_signal_count: explicitLeaseExpenseSignals,
      full_lease_signal_count: fullLeaseSignals,
      strong_full_lease_signals: strongFullLeaseSignals,
      context_text_chars: context.length,
    },
  };
}

function detectDocumentProfile(fullText: string, documentSubtype?: string | null) {
  return detectDocumentProfileSignals(fullText, documentSubtype).selected_document_profile;
}

function findUniversalMatch(doclingRaw: any, fullText: string, patterns: RegExp[]) {
  const blocks = asArray(doclingRaw?.text_blocks);
  for (const pattern of patterns) {
    for (const block of blocks) {
      const text = cleanText(block?.text || "");
      const match = text.match(pattern);
      if (match?.[0]) {
        return {
          raw: cleanText(match[1] || match[0]),
          source_text: cleanText(match[0]),
          source_page: sourcePageOf(block),
        };
      }
    }
    const match = fullText.match(pattern);
    if (match?.[0]) {
      const sourceText = cleanText(match[0]);
      const sourceBlock = blocks.find((block) => cleanText(block?.text || "").includes(sourceText));
      return {
        raw: cleanText(match[1] || match[0]),
        source_text: sourceText,
        source_page: sourcePageOf(sourceBlock),
      };
    }
  }
  return null;
}

function normalizeUniversalValue(itemType: string, raw: unknown) {
  if (raw == null) return null;
  if (/date/.test(itemType)) return toIsoDate(raw) || cleanText(raw);
  if (/rent|consideration|size|sqft|amount/.test(itemType)) {
    const numeric = asNumber(raw);
    return numeric != null ? numeric : cleanText(raw);
  }
  return cleanText(raw);
}

function createDocumentItem(args: Record<string, unknown>) {
  const sourceText = cleanText(args.source_text || "");
  const safeSourceText = cleanSourceText(sourceText);
  const fieldKey = args.field_key ? String(args.field_key) : null;
  const mapsToFixedField = Boolean(args.maps_to_fixed_field ?? (fieldKey && FIXED_REVIEW_FIELD_KEYS.has(fieldKey)));
  const mapsToExistingField = Boolean(args.maps_to_existing_field ?? args.maps_to_fixed_field ?? fieldKey);
  const displayTab = args.display_tab || displayTabForItem(args.item_type, args.business_area, fieldKey);
  return {
    item_id: String(args.item_id || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`),
    document_id: args.document_id ?? null,
    lease_id: args.lease_id ?? null,
    label: args.label || titleizeItemLabel(args.item_type || fieldKey),
    document_profile: args.document_profile ?? "full_lease",
    section_title: args.section_title ?? null,
    section_number: args.section_number ?? null,
    item_type: args.item_type,
    business_area: args.business_area || "unknown_needs_review",
    display_tab: displayTab,
    field_key: fieldKey,
    category: args.category ?? null,
    subcategory: args.subcategory ?? null,
    value: args.value ?? null,
    normalized_value: args.normalized_value ?? args.value ?? null,
    raw_value: args.raw_value ?? args.value ?? null,
    source_text: safeSourceText,
    source_page: args.source_page ?? null,
    confidence: args.confidence ?? (safeSourceText ? 0.78 : 0.35),
    extraction_method: args.extraction_method || "workflow_universal_item",
    extraction_status: args.extraction_status || (safeSourceText ? "extracted" : "needs_review"),
    maps_to_existing_field: mapsToExistingField,
    maps_to_fixed_field: mapsToFixedField,
    creates_dynamic_row: Boolean(args.creates_dynamic_row ?? (!mapsToFixedField && safeSourceText)),
    creates_lease_expense_rule: Boolean(args.creates_lease_expense_rule),
    requires_original_lease: Boolean(args.requires_original_lease),
    review_status: args.review_status || "needs_review",
  };
}

function buildUniversalDocumentItems(args: {
  row: Record<string, unknown>;
  doclingRaw: any;
  fullText: string;
  documentProfile: string;
  leaseFields: Record<string, LeaseWorkflowField>;
  clauses: LeaseWorkflowClause[];
}) {
  const { row, doclingRaw, fullText, documentProfile, leaseFields, clauses } = args;
  const items: any[] = [];
  const seen = new Set<string>();
  const addItem = (item: any) => {
    const key = [
      item.item_type,
      item.field_key || "",
      normalizeToken(item.source_text || item.raw_value || item.value || "").slice(0, 140),
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const [fieldKey, field] of Object.entries(leaseFields || {})) {
    if (isBlank(field?.value) || isBlank(field?.source_clause)) continue;
    if (field?.extraction_status === "calculated") continue;
    const group = field?.field_group || "clause_records";
    addItem(createDocumentItem({
      item_id: `field:${fieldKey}`,
      document_profile: documentProfile,
      item_type: fieldKey,
      business_area: BUSINESS_AREA_BY_FIELD_GROUP[group] || "clause_records",
      field_key: fieldKey,
      value: field.value,
      normalized_value: field.value,
      raw_value: field.value,
      source_text: field.source_clause,
      source_page: field.source_page,
      confidence: field.confidence_score ?? 0.74,
      extraction_method: "mapped_lease_field",
      extraction_status: field.extraction_status || "extracted",
      maps_to_existing_field: true,
      creates_lease_expense_rule: group === "expense_terms",
    }));
  }

  for (const def of UNIVERSAL_ITEM_DEFS) {
    const match = findUniversalMatch(doclingRaw, fullText, def.patterns);
    if (!match?.source_text) continue;
    const value = def.booleanValue || normalizeUniversalValue(def.item_type, match.raw);
    addItem(createDocumentItem({
      item_id: `universal:${def.item_type}:${normalizeToken(match.source_text).slice(0, 40)}`,
      document_profile: documentProfile,
      item_type: def.item_type,
      business_area: def.business_area,
      field_key: def.field_key,
      value,
      normalized_value: value,
      raw_value: match.raw,
      source_text: match.source_text,
      source_page: match.source_page,
      confidence: 0.82,
      extraction_method: "universal_pattern",
      extraction_status: "extracted",
      maps_to_existing_field: def.maps,
      creates_lease_expense_rule: false,
    }));
  }

  for (const clause of clauses || []) {
    if (!clause?.clause_text) continue;
    const clauseType = clause.clause_type || "clause_record";
    addItem(createDocumentItem({
      item_id: `clause:${clauseType}`,
      document_profile: documentProfile,
      section_title: clause.clause_title,
      item_type: clauseType,
      // Always route clause records to the clause_records tab so they don't
      // appear as duplicate title-only rows in field-specific tabs.
      business_area: "clause_records",
      display_tab: "clause_records",
      value: clause.clause_text,
      normalized_value: clause.clause_text,
      raw_value: clause.clause_text,
      source_text: clause.clause_text,
      source_page: clause.source_page,
      confidence: clause.confidence_score ?? 0.78,
      extraction_method: "clause_record",
      extraction_status: "extracted",
      maps_to_existing_field: false,
      creates_lease_expense_rule: ["operating_expense_recovery", "cam_recoveries", "insurance_requirements", "repairs_maintenance", "late_fees"].includes(clauseType),
    }));
  }

  const hasExpenseClause = items.some((item) =>
    item.creates_lease_expense_rule ||
    ["expenses_recoveries", "cam_rules", "insurance"].includes(item.business_area)
  );
  if (["assignment", "amendment", "assignment_amendment"].includes(documentProfile) && !hasExpenseClause) {
    const support = items.find((item) =>
      item.business_area === "assignment_amendment" &&
      /assignment|assignee|amend|all other terms|remain/i.test(String(item.source_text || ""))
    );
    addItem(createDocumentItem({
      item_id: "coverage_gap:original_lease_required_for_expense_rules",
      document_profile: documentProfile,
      item_type: "original_lease_required_for_expense_rules",
      business_area: "expenses_recoveries",
      field_key: "original_lease_required_for_expense_rules",
      value: "yes",
      normalized_value: "yes",
      raw_value: "original lease required",
      source_text: support?.source_text || null,
      source_page: support?.source_page ?? null,
      confidence: support?.source_text ? 0.74 : 0.45,
      extraction_method: "document_profile",
      extraction_status: "needs_review",
      maps_to_existing_field: false,
      creates_lease_expense_rule: false,
      requires_original_lease: true,
    }));
  }

  return items;
}

function applyDocumentItemsToLeaseFields(
  leaseFields: Record<string, LeaseWorkflowField>,
  items: any[],
) {
  for (const item of items || []) {
    if (!item?.maps_to_fixed_field || !item?.field_key || isBlank(item.value) || !item.source_text) continue;
    const fieldKey = String(item.field_key);
    const existing = leaseFields[fieldKey];
    const shouldOverride =
      !existing ||
      isBlank(existing.value) ||
      ["not_found", "manual_required", "needs_review", "missing_source_evidence"].includes(String(existing.extraction_status || ""));
    const assignmentCurrentTenant = item.item_type === "assignee_current_tenant";
    if (!shouldOverride && !assignmentCurrentTenant) continue;
    leaseFields[fieldKey] = {
      ...(existing || {
        key: fieldKey,
        editable: true,
        field_group: item.business_area === "assignment_amendment" ? "assignment_amendment" : "lease_header",
      }),
      key: fieldKey,
      value: normalizeWorkflowFieldValue(fieldKey, item.normalized_value ?? item.value),
      source_page: item.source_page ?? null,
      source_clause: item.source_text,
      confidence_score: item.confidence ?? 0.82,
      extraction_status: "extracted",
      editable: true,
      field_group: existing?.field_group || (item.business_area === "assignment_amendment" ? "assignment_amendment" : "lease_header"),
    };
  }

  if (leaseFields.rentable_area_sqft?.value && !leaseFields.square_footage) {
    leaseFields.square_footage = {
      ...leaseFields.rentable_area_sqft,
      key: "square_footage",
      field_group: "premises",
    };
  }
}

function buildLeaseFieldMap(row: Record<string, unknown>, doclingRaw: any, clauses: LeaseWorkflowClause[]) {
  const fullText = cleanText(doclingRaw?.full_text || "");
  const fieldMap: Record<string, LeaseWorkflowField> = {};

  for (const spec of FIELD_SPECS) {
    let value = getFirstValue(row, spec.aliases);
    let extractionStatus: LeaseWorkflowField["extraction_status"] = "extracted";
    let confidenceScore = getRowConfidence(row, spec.aliases?.[0] || spec.key) ?? 0.74;

    if (isBlank(value) && spec.patterns?.length) {
      value = extractPatternValue(fullText, spec.patterns);
      if (!isBlank(value)) {
        confidenceScore = Math.max(confidenceScore, 0.7);
      }
    }

    if (spec.key === "rent_frequency" && isBlank(value) && row?.monthly_rent) {
      value = "monthly";
      extractionStatus = "calculated";
      confidenceScore = 0.95;
    }

    if (spec.key === "lease_term" && isBlank(value)) {
      const months = asNumber(row?.lease_term_months);
      if (months) {
        value = months % 12 === 0 ? `${months / 12} year${months === 12 ? "" : "s"}` : `${months} months`;
        extractionStatus = "calculated";
        confidenceScore = 0.95;
      }
    }

    if (spec.key === "tenant_rsf" && isBlank(value)) {
      value = getFirstValue(row, ["square_footage", "rentable_area_sqft"]);
    }

    if (spec.key === "rentable_area_sqft" && isBlank(value)) {
      value = getFirstValue(row, ["square_footage", "tenant_rsf"]);
    }

    if (spec.key === "base_rent_monthly" && isBlank(value)) {
      // Only fall back to row.monthly_rent if it is a real, positive value.
      // The leases table column has a NOT NULL DEFAULT 0, so a zero here is
      // almost always "we never extracted it" — not "the lease really says
      // $0". Treating that as extracted produced a misleading green badge.
      const rowMonthly = asNumber(getFirstValue(row, ["monthly_rent"]));
      const rowAnnual = asNumber(getFirstValue(row, ["annual_rent"]));
      if (rowMonthly != null && rowMonthly > 0) {
        value = rowMonthly;
        // If row.monthly_rent looks like annual_rent / 12 (within $1, since
        // lease-normalizer rounds), this value is CALCULATED, not extracted
        // from a clause. Mark accordingly so the UI doesn't display a
        // misleading "extracted" badge against a derived figure.
        if (rowAnnual != null && rowAnnual > 0) {
          const derived = rowAnnual / 12;
          if (Math.abs(derived - rowMonthly) < 1) {
            extractionStatus = "calculated";
            confidenceScore = 0.95;
          }
        }
      } else {
        value = null;
      }
    }

    // Only fall back to start_date if it looks like a commencement date (not just
    // the lease signing date). The LLM schema description already instructs null for
    // formulaic commencement dates, so start_date here is likely the correct value.
    if (spec.key === "commencement_date" && isBlank(value)) {
      const sd = getFirstValue(row, ["start_date"]);
      // Don't fall back when start_date == lease_date — that means the LLM returned
      // the signing date, which is not the commencement date.
      const leaseDate = getFirstValue(row, ["lease_date"]);
      if (sd && String(sd) !== String(leaseDate)) {
        value = sd;
      }
    }

    if (spec.key === "expiration_date" && isBlank(value)) {
      value = getFirstValue(row, ["end_date"]);
    }

    if (spec.key === "security_deposit_amount" && isBlank(value)) {
      value = getFirstValue(row, ["security_deposit"]);
    }

    if (spec.key === "landlord_address" || spec.key === "tenant_address") {
      value = cleanPartyAddressValue(spec.key, value);
    }

    if (isBlank(value)) {
      extractionStatus = spec.manualRequired ? "manual_required" : "not_found";
      confidenceScore = 0;
    } else if (
      typeof confidenceScore === "number" &&
      confidenceScore < LOW_CONFIDENCE_THRESHOLD &&
      extractionStatus === "extracted"
    ) {
      // Low-confidence extracted values must not show the green "Extracted"
      // badge. Downgrade to a review-required state so the reviewer treats
      // the value as a candidate, not a confirmed extraction.
      extractionStatus = "needs_review";
    }

    const relatedClause = spec.clauseType
      ? clauses.find((clause) => clause.clause_type === spec.clauseType && clause.clause_text)
      : null;
    // Evidence resolution order:
    //   1. Related clause snippet (highest fidelity for clause-bound fields)
    //   2. LLM-quoted evidence (Gemini's verbatim source_text + source_page)
    //   3. Local text-matcher fallback (docling text search)
    // This makes sure Gemini's evidence doesn't get overwritten by a
    // text-match against a generic value like "unknown" or "1110".
    const llmEvidence = getLlmEvidenceForAliases(row, spec.aliases || [spec.key]);
    const textMatchEvidence = (relatedClause || llmEvidence)
      ? { source_page: null as number | null, source_clause: null as string | null }
      : findEvidenceForValue(doclingRaw, spec.key, value, relatedClause?.clause_title || null);

    const resolvedSourceClause = relatedClause?.clause_text ?? llmEvidence?.source_text ?? textMatchEvidence.source_clause;
    // Only attach source_clause when it is contextually relevant to the field.
    // An irrelevant block (e.g. a transferee financial-worth paragraph used as
    // source for tenant_name) shows "No source" instead of misleading "Exact".
    let relevantSourceClause = resolvedSourceClause && isSourceRelevantToField(spec.key, resolvedSourceClause)
      ? resolvedSourceClause
      : null;
    let normalizedValue = normalizeWorkflowFieldValue(spec.key, value);
    const invalidReason = fieldValueLooksInvalid(spec.key, normalizedValue, relevantSourceClause);
    if (invalidReason) {
      if (["suite_number", "tenant_name", "landlord_name", "broker_name", "tenant_contact_name", "property_name", "lease_type"].includes(spec.key)) {
        normalizedValue = null;
        extractionStatus = spec.manualRequired ? "manual_required" : "not_found";
      } else if (extractionStatus === "extracted") {
        extractionStatus = "missing_source_evidence";
      }
      relevantSourceClause = null;
      confidenceScore = Math.min(Number(confidenceScore ?? 0.35), 0.35);
    }
    if (!isBlank(normalizedValue) && extractionStatus === "extracted" && !relevantSourceClause) {
      extractionStatus = "missing_source_evidence";
      confidenceScore = Math.min(Number(confidenceScore ?? 0.35), 0.35);
    }

    fieldMap[spec.key] = {
      key: spec.key,
      value: normalizedValue,
      source_page: relevantSourceClause ? (relatedClause?.source_page ?? llmEvidence?.source_page ?? textMatchEvidence.source_page) : null,
      source_clause: relevantSourceClause,
      confidence_score: extractionStatus === "not_found" || extractionStatus === "manual_required" ? null : round2(confidenceScore),
      extraction_status: extractionStatus,
      editable: true,
      field_group: spec.group,
    };
  }

  const signals = inferLeaseSignals(fullText, row);
  const classifiedLeaseType = classifyLeaseType(fullText, [], signals);
  const existingLeaseType = normalizeLeaseTypeValue(fieldMap.lease_type?.value);
  const normalizedLeaseType = normalizeLeaseTypeValue(classifiedLeaseType) ?? existingLeaseType;
  const leaseTypeEvidence = normalizedLeaseType
    ? findEvidenceForValue(doclingRaw, "lease_type", classifiedLeaseType, classifiedLeaseType)
    : { source_page: null, source_clause: null };
  const leaseTypeSource = leaseTypeEvidence.source_clause && isSourceRelevantToField("lease_type", leaseTypeEvidence.source_clause)
    ? leaseTypeEvidence.source_clause
    : null;
  fieldMap.lease_type = {
    ...(fieldMap.lease_type || {
      key: "lease_type",
      value: null,
      source_page: null,
      source_clause: null,
      confidence_score: null,
      extraction_status: "not_found",
      editable: true,
      field_group: "lease_header",
    }),
    value: normalizedLeaseType,
    source_page: leaseTypeSource ? leaseTypeEvidence.source_page : fieldMap.lease_type?.source_page ?? null,
    source_clause: leaseTypeSource ?? fieldMap.lease_type?.source_clause ?? null,
    confidence_score: normalizedLeaseType ? (normalizeLeaseTypeValue(classifiedLeaseType) ? 0.86 : fieldMap.lease_type?.confidence_score ?? 0.72) : 0.5,
    extraction_status: normalizedLeaseType ? (normalizeLeaseTypeValue(classifiedLeaseType) ? "calculated" : fieldMap.lease_type?.extraction_status ?? "needs_review") : "manual_required",
  };

  const tenantRsf = asNumber(fieldMap.tenant_rsf?.value);
  const buildingRsf = asNumber(fieldMap.building_rsf?.value);
  const proRataShare = tenantRsf && buildingRsf ? round4(tenantRsf / buildingRsf) : null;
  fieldMap.tenant_pro_rata_share = {
    key: "tenant_pro_rata_share",
    value: proRataShare,
    source_page: fieldMap.tenant_rsf?.source_page ?? fieldMap.building_rsf?.source_page ?? null,
    source_clause: proRataShare != null ? "Calculated from tenant_rsf / building_rsf" : null,
    confidence_score: proRataShare != null ? 1 : null,
    extraction_status: proRataShare != null ? "calculated" : "manual_required",
    editable: true,
    field_group: "premises",
  };

  const commencementDate = toIsoDate(fieldMap.commencement_date?.value);
  const expirationDate = toIsoDate(fieldMap.expiration_date?.value);
  if (commencementDate && expirationDate) {
    const startDate = new Date(`${commencementDate}T00:00:00Z`);
    const endDate = new Date(`${expirationDate}T00:00:00Z`);
    const termMonths =
      parseLeaseTermMonths(row?.lease_term_months) ??
      parseLeaseTermMonths(fieldMap.lease_term_months?.value) ??
      parseLeaseTermMonths(fieldMap.lease_term?.value);
    const actualDays = daysBetween(startDate, endDate);
    const minimumExpectedDays = termMonths && termMonths >= 6 ? Math.max(45, Math.round(termMonths * 24)) : null;
    const hasImplausiblyShortTerm =
      minimumExpectedDays != null &&
      actualDays != null &&
      actualDays > 0 &&
      actualDays < minimumExpectedDays;
    if (
      Number.isFinite(startDate.getTime()) &&
      Number.isFinite(endDate.getTime()) &&
      (endDate <= startDate || hasImplausiblyShortTerm)
    ) {
      const corrected = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        endDate.getUTCMonth(),
        endDate.getUTCDate(),
      ));
      while (
        corrected <= startDate ||
        (minimumExpectedDays != null && (daysBetween(startDate, corrected) ?? 0) < minimumExpectedDays)
      ) {
        corrected.setUTCFullYear(corrected.getUTCFullYear() + 1);
      }
      const expirationEvidence = extractClauseSnippet(
        asArray(doclingRaw?.text_blocks),
        fullText,
        ["expiration date", "expires", "term", "January 31", "Jan 31"],
        360,
      );
      fieldMap.expiration_date = {
        ...(fieldMap.expiration_date || {
          key: "expiration_date",
          editable: true,
          field_group: "lease_term",
        }),
        value: corrected.toISOString().slice(0, 10),
        source_page: fieldMap.expiration_date?.source_page ?? expirationEvidence.source_page ?? null,
        source_clause: expirationEvidence.clause_text ?? fieldMap.expiration_date?.source_clause ?? "Calculated as the next plausible expiration occurrence after commencement date",
        confidence_score: Math.min(Number(fieldMap.expiration_date?.confidence_score ?? 0.74), 0.82),
        extraction_status: "calculated",
      };
    }
  }
  if (commencementDate && !toIsoDate(fieldMap.expiration_date?.value)) {
    const startDate = new Date(`${commencementDate}T00:00:00Z`);
    const termMonths =
      parseLeaseTermMonths(row?.lease_term_months) ??
      parseLeaseTermMonths(fieldMap.lease_term_months?.value) ??
      parseLeaseTermMonths(fieldMap.lease_term?.value);
    if (Number.isFinite(startDate.getTime()) && termMonths && termMonths > 0) {
      const derivedExpiration = new Date(startDate);
      derivedExpiration.setUTCMonth(derivedExpiration.getUTCMonth() + termMonths);
      derivedExpiration.setUTCDate(derivedExpiration.getUTCDate() - 1);
      const termEvidence = extractClauseSnippet(
        asArray(doclingRaw?.text_blocks),
        fullText,
        ["lease term", "term", "commencement date", "expiration date", "months"],
        420,
      );
      fieldMap.expiration_date = {
        ...(fieldMap.expiration_date || {
          key: "expiration_date",
          editable: true,
          field_group: "lease_term",
        }),
        value: derivedExpiration.toISOString().slice(0, 10),
        source_page: termEvidence.source_page ?? fieldMap.lease_term?.source_page ?? fieldMap.commencement_date?.source_page ?? null,
        source_clause: termEvidence.clause_text ?? fieldMap.lease_term?.source_clause ?? fieldMap.commencement_date?.source_clause ?? null,
        confidence_score: 0.72,
        extraction_status: "needs_review",
      };
    }
  }

  const canonicalClassifiedLeaseType = normalizeLeaseTypeValue(classifiedLeaseType);
  if (canonicalClassifiedLeaseType === "full_service") {
    const explicitRecoverables = [
      asNumber(row?.cam_amount),
      asNumber(row?.nnn_amount),
      asNumber(row?.tax_reimbursement_amount),
      asNumber(row?.insurance_reimbursement_amount),
    ].filter((value) => value && value > 0);
    if (explicitRecoverables.length > 0) {
      fieldMap.lease_type = {
        ...fieldMap.lease_type,
        extraction_status: "conflict_detected",
      };
    }
  }

  // ── Task 4: Derive expense/CAM/insurance rows for Full Service leases ────────
  // When the lease is Full Service and responsibility fields were not explicitly
  // extracted, populate them as "calculated" rows so the Expenses/Recoveries,
  // CAM, and Insurance tabs show meaningful content instead of all-blank rows.
  if (canonicalClassifiedLeaseType === "full_service" || canonicalClassifiedLeaseType === "gross") {
    const clauseFor = (...types: string[]) => clauses.find((clause) => types.includes(clause.clause_type) && clause.clause_text);
    const deriveResponsibility = (key: string, value: string, clauseTypes: string[], note: string) => {
      const clause = clauseFor(...clauseTypes);
      if (!isBlank(fieldMap[key]?.value) || !clause) return;
      fieldMap[key] = {
        key,
        value,
        source_page: clause.source_page ?? null,
        source_clause: clause.clause_text,
        confidence_score: 0.70,
        extraction_status: "calculated",
        evidence_type: "derived",
        source_text_quality: "derived",
        source_field_keys: ["lease_type"],
        derivation_trace: note,
        editable: true,
        field_group: "expense_terms",
      };
    };
    deriveResponsibility(
      "responsibility_taxes",
      "landlord",
      ["taxes", "operating_expense_recovery"],
      "Full service/gross lease: taxes are treated as included in base rent unless the cited clause states a pass-through exception.",
    );
    deriveResponsibility(
      "responsibility_insurance",
      "landlord",
      ["insurance", "operating_expense_recovery"],
      "Full service/gross lease: property insurance is treated as included in base rent; tenant insurance obligations remain separate.",
    );
    deriveResponsibility(
      "responsibility_utilities",
      "landlord",
      ["operating_expense_recovery", "repairs_maintenance"],
      "Full service/gross lease: utilities are treated as included unless separately metered or expressly charged to tenant.",
    );
    deriveResponsibility(
      "responsibility_repairs",
      "landlord",
      ["repairs_maintenance", "operating_expense_recovery"],
      "Full service/gross lease: landlord maintains building/common systems, subject to tenant damage or premises-specific exceptions.",
    );
    // Full Service → no separate CAM recovery
    const camClause = clauseFor("cam_recoveries", "operating_expense_recovery");
    if (isBlank(fieldMap.cam_amount?.value) && camClause) {
      fieldMap.cam_amount = {
        key: "cam_amount",
        value: 0,
        source_page: camClause.source_page ?? null,
        source_clause: camClause.clause_text,
        confidence_score: 0.70,
        extraction_status: "calculated",
        evidence_type: "derived",
        source_text_quality: "derived",
        source_field_keys: ["lease_type"],
        derivation_trace: "Full service/gross lease: separate CAM recovery defaults to 0 unless a clause states a distinct fixed or pass-through charge.",
        editable: true,
        field_group: "expense_terms",
      };
    }
  }

  // ── Task 3: Normalization hardening ─────────────────────────────────────────

  // property_name must not be a boolean sentinel
  if (!isBlank(fieldMap.property_name?.value)) {
    const pn = String(fieldMap.property_name.value).trim();
    if (/^(yes|no|true|false|none|n\/a|na|unknown)$/i.test(pn)) {
      fieldMap.property_name = { ...(fieldMap.property_name as any), value: null, extraction_status: "not_found" };
    }
  }

  // Party signatory names must not contain trailing "Date" or signature labels
  for (const key of ["tenant_signatory_name", "landlord_signatory_name", "tenant_contact_name"]) {
    if (!isBlank(fieldMap[key]?.value)) {
      const raw = String(fieldMap[key].value).trim();
      // Strip trailing "Date", "By:", date strings, or address lines
      const cleaned = raw
        .replace(/\s+(Date|By:|Signed:|Date:|[\d]{1,2}[-/][\d]{1,2}[-/][\d]{2,4}).*/i, "")
        .replace(/\s+(January|February|March|April|May|June|July|August|September|October|November|December).*/i, "")
        .trim();
      if (cleaned !== raw && cleaned.length > 2) {
        fieldMap[key] = { ...(fieldMap[key] as any), value: cleaned };
      }
    }
  }

  // Address fields must not combine multiple unrelated rows (multiple company
  // names, phone numbers, or addresses from different parties)
  for (const key of ["landlord_address", "tenant_address"]) {
    if (!isBlank(fieldMap[key]?.value)) {
      const v = String(fieldMap[key].value);
      const phoneCount = (v.match(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g) || []).length;
      const entityCount = (v.match(/\b(?:LLC|Inc\.|Corp\.|Ltd\.|L\.L\.C\.|L\.P\.)\b/gi) || []).length;
      const lineCount = v.split(/\n/).filter((l) => l.trim().length > 3).length;
      if (phoneCount > 1 || entityCount > 2 || lineCount > 5) {
        // Value is a multi-party block — not a clean single address
        fieldMap[key] = { ...(fieldMap[key] as any), value: null, source_clause: null, extraction_status: "not_found" };
      }
    }
  }

  // Generic single-word sentinels that are not meaningful normalized values
  const GENERIC_VALUE_PATTERN = /^(default|insurance|tenant|landlord|property|lease|required|transfer|assignee|assignment|unknown|n\/a|na|none|yes|no|true|false)$/i;
  const GENERIC_SENTINEL_FIELDS = [
    "landlord_consent_for_transfer", "assignment_rights", "assignment_provisions",
    "sublease_rights", "early_termination_option", "right_of_first_refusal",
    "default_cure_period",
  ];
  for (const key of GENERIC_SENTINEL_FIELDS) {
    if (!isBlank(fieldMap[key]?.value) && typeof fieldMap[key].value === "string") {
      if (GENERIC_VALUE_PATTERN.test(String(fieldMap[key].value).trim())) {
        fieldMap[key] = { ...(fieldMap[key] as any), value: null, extraction_status: "not_found" };
      }
    }
  }

  // Humanize landlord_consent_for_transfer — raw key-like text → readable
  if (!isBlank(fieldMap.landlord_consent_for_transfer?.value)) {
    const v = String(fieldMap.landlord_consent_for_transfer.value).trim();
    const lower = v.toLowerCase();
    if (lower === "required" || lower === "landlord consent required" || /required.*transfer/i.test(v)) {
      fieldMap.landlord_consent_for_transfer = {
        ...(fieldMap.landlord_consent_for_transfer as any),
        value: "Landlord consent required for assignment or transfer",
      };
    }
  }

  return fieldMap;
}

function normalizeWorkflowFieldValue(fieldKey: string, value: unknown) {
  if (isBlank(value)) return null;
  if (/(date)$/.test(fieldKey)) return toIsoDate(value) || cleanText(value);
  if (/(amount|percent|multiplier|sqft|rsf|share|day)$/.test(fieldKey) || ["rentable_area_sqft", "building_rsf", "tenant_rsf"].includes(fieldKey)) {
    const numeric = asNumber(value);
    return numeric != null ? numeric : cleanText(value);
  }
  return cleanText(value);
}

function summarizeResponsibility(text: string, keywords: string[]) {
  const normalized = normalizeToken(text);
  const joined = keywords.join("|").replace(/\//g, "\\/");
  const tenantPattern = new RegExp(`(?:${joined})[^.\\n]{0,160}\\b(?:tenant|lessee)\\b[^.\\n]{0,40}\\b(?:pay|reimburse|responsible)`, "i");
  const landlordPattern = new RegExp(`(?:${joined})[^.\\n]{0,160}\\b(?:landlord|lessor|owner)\\b[^.\\n]{0,40}\\b(?:pay|provide|responsible)`, "i");
  const sharedPattern = new RegExp(`(?:${joined})[^.\\n]{0,200}\\b(?:shared|pro rata|allocated|apportioned)`, "i");
  if (tenantPattern.test(normalized)) return "tenant";
  if (landlordPattern.test(normalized)) return "landlord";
  if (sharedPattern.test(normalized)) return "shared";
  return "unknown";
}

function categoryAnnualBudgetKey(category: string) {
  const map: Record<string, string> = {
    cam: "cam",
    common_area_maintenance: "cam",
    operating_expenses: "operating_expenses",
    real_estate_taxes: "real_estate_taxes",
    property_insurance: "property_insurance",
    management_fees: "management_fees",
    administrative_fees: "administrative_fees",
    utilities: "utilities",
    electricity: "electricity",
    water: "water",
    sewer: "sewer",
    gas: "gas",
    hvac: "hvac",
    janitorial: "janitorial",
  };
  return map[category] || category;
}

function findSupportingClauseForRule(
  clauses: LeaseWorkflowClause[],
  textBlocks: any[],
  fullText: string,
  keywords: string[],
) {
  // Score-based clause matcher.
  //
  // Previously this returned the FIRST clause containing any keyword —
  // which gave bad results: "Security" expense matched the
  // "SECURITY DEPOSIT" article (a different concept), and a single
  // gross-lease summary paragraph got reused for utilities, repairs,
  // janitorial, etc. (all keywords appeared in the same paragraph).
  //
  // Now we score every candidate clause and pick the most specific one:
  //   +30  keyword appears in the first 80 chars (likely heading/title)
  //   +20  keyword appears as a standalone word in a heading line (ARTICLE X foo, Section X.X Foo)
  //   +5   per additional keyword occurrence in the clause body
  //   -3   per *unrelated* category keyword present in the same clause
  //         (penalizes generic paragraphs that mention many things)
  //   -25  if a sibling "deposit"/"reserve"/"escrow" word fences the keyword
  //         away from the expense meaning (security DEPOSIT, tax ESCROW)
  //
  // Clauses scoring < 5 are rejected → caller treats as missing evidence.
  const loweredKeywords = keywords.map((keyword) => normalizeToken(keyword));
  const looksLikeHeading = (text: string) => /^\s*(?:article|section|exhibit|addendum)\s+[a-z0-9]+\b/i.test(text)
    || /^\s*\d+(?:\.\d+)*\s/.test(text);

  // Build a set of all OTHER category words across the blueprints so we can
  // penalize paragraphs that look like a generic summary.
  const allCategoryWords = new Set<string>();
  for (const bp of EXPENSE_RULE_BLUEPRINTS) {
    for (const k of bp.keywords) allCategoryWords.add(normalizeToken(k));
  }
  const ourKeywordSet = new Set(loweredKeywords);

  let bestClause: LeaseWorkflowClause | null = null;
  let bestScore = 0;

  for (const clause of clauses || []) {
    const text = clause?.clause_text || "";
    if (!text) continue;
    const lower = normalizeToken(text);
    const head80 = lower.slice(0, 80);
    let score = 0;
    let hits = 0;

    for (const kw of loweredKeywords) {
      if (!kw) continue;
      // Use word-boundary-ish matching: surround keyword with non-letter context.
      const bounded = new RegExp(`(^|[^a-z0-9])${escapeForRegex(kw)}($|[^a-z0-9])`);
      const matches = lower.match(new RegExp(bounded, "g")) || [];
      if (matches.length === 0) continue;
      hits += matches.length;
      score += 5 * matches.length;
      if (bounded.test(head80)) score += 30;
      if (looksLikeHeading(text) && bounded.test(head80)) score += 20;
    }
    if (hits === 0) continue;

    // Penalize generic paragraphs that mention many unrelated categories.
    let unrelated = 0;
    for (const cw of allCategoryWords) {
      if (ourKeywordSet.has(cw)) continue;
      const cwRe = new RegExp(`(^|[^a-z0-9])${escapeForRegex(cw)}($|[^a-z0-9])`);
      if (cwRe.test(lower)) unrelated += 1;
    }
    score -= unrelated * 3;

    // Specific "deposit/escrow" defence: "security" keyword colliding with
    // "security deposit" is the canonical false-positive in this codebase.
    for (const kw of loweredKeywords) {
      const collider = new RegExp(`${escapeForRegex(kw)}\\s+(?:deposit|reserve|escrow|interest|account)`);
      if (collider.test(lower)) score -= 25;
    }

    if (score > bestScore) {
      bestScore = score;
      bestClause = clause;
    }
  }

  if (bestClause && bestScore >= 5) {
    return {
      clause_text: bestClause.clause_text,
      source_page: bestClause.source_page,
      clause_type: bestClause.clause_type,
    };
  }

  // No good clause match — try a paragraph-level snippet from raw text.
  // extractClauseSnippet returns null for clause_text now when no document
  // text matches (no more keyword fallback), so the caller will correctly
  // mark the rule as missing source evidence.
  return null;
}

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveExpenseRules(
  row: Record<string, unknown>,
  fieldMap: Record<string, LeaseWorkflowField>,
  clauses: LeaseWorkflowClause[],
  doclingRaw: any,
) {
  const leaseType = cleanText(fieldMap.lease_type?.value || "");
  const normalizedLeaseType = leaseType.toLowerCase().replace(/[_-]+/g, " ");
  const isFullService = /full service|gross lease/.test(normalizedLeaseType);
  const isGross = /\bgross\b|gross lease|industrial gross/.test(normalizedLeaseType) && !/modified gross/.test(normalizedLeaseType);
  const isModifiedGross = /modified gross|hybrid/.test(normalizedLeaseType);
  const isTripleNet = /triple net|nnn|absolute net/.test(normalizedLeaseType);
  const isDoubleNet = /double net|nn lease/.test(normalizedLeaseType);
  const isSingleNet = /single net| n /.test(` ${normalizedLeaseType} `);
  // A "Modified Gross with Base Year" lease has leaseType = "Modified Gross"
  // after the classifyLeaseType fix, so /base year/ won't match the type string.
  // Fall back to checking whether the LLM actually extracted a base_year value —
  // if it did, the document has a base year structure regardless of the type label.
  const isModifiedGrossRaw = /modified gross|hybrid/.test(normalizedLeaseType);
  const isBaseYear = /base year/.test(normalizedLeaseType)
    || (isModifiedGrossRaw && asNumber(row?.base_year) != null)
    || (isModifiedGrossRaw && asNumber(fieldMap.base_year?.value) != null);
  const isExpenseStop = /expense stop/.test(normalizedLeaseType);
  const isFixedCam = /fixed cam/.test(normalizedLeaseType);
  const isPercentageRent = /percentage rent/.test(normalizedLeaseType);
  const isGroundLease = /ground lease/.test(normalizedLeaseType);
  const fullText = cleanText(doclingRaw?.full_text || clauses.map((clause) => clause.clause_text || "").join(" "));
  const textBlocks = asArray(doclingRaw?.text_blocks);
  const explicitBaseYear = asNumber(fieldMap.base_year_expense_amount?.value) ?? asNumber(fieldMap.base_year?.value);
  const explicitExpenseStop = asNumber(fieldMap.expense_stop_amount?.value);
  // admin_fee_pct — schema key used by LLM; also read from fieldMap for cases
  // where the FIELD_SPEC populated it via pattern matching.
  const explicitAdminFee = asNumber(fieldMap.admin_fee_pct?.value ?? row?.admin_fee_pct);
  // gross_up — schema key is gross_up_threshold (LLM/FIELD_SPEC); legacy row
  // key is gross_up_percent; keep both for back-compat.
  const explicitGrossUp = asNumber(
    fieldMap.gross_up_threshold?.value
    ?? row?.gross_up_threshold
    ?? row?.gross_up_percent
    ?? row?.cam_cap_rate,
  );
  // cam_cap_pct — controllable/CAM cap percentage extracted by LLM or patterns.
  const explicitCapPercent = asNumber(
    fieldMap.cam_cap_pct?.value
    ?? row?.cam_cap_pct
    ?? row?.cam_cap_percent
    ?? row?.cap_percent,
  );

  const rules = EXPENSE_RULE_BLUEPRINTS.map((blueprint) => {
    const supportingClause = findSupportingClauseForRule(clauses, textBlocks, fullText, blueprint.keywords);

    const mentioned = containsAny(fullText, blueprint.keywords);
    const responsibility = summarizeResponsibility(fullText, blueprint.keywords);
    let includedInBaseRent: boolean | null = null;
    let separatelyBilled: boolean | null = null;
    let recoverableFromTenant: boolean | null = null;
    let recoveryMethod = "manual_review";
    let allocationBasis = fieldMap.tenant_pro_rata_share?.value != null ? "rentable_area" : "manual";
    let capType = "none";
    let capAmount = null;
    // For CAM-eligible rules, seed capPercent from the extracted
    // controllable/CAM cap value (cam_cap_pct / controllable_cap_percent).
    // This surfaces in deriveCamProfile as cam_cap_percent without changing
    // any calculation logic — deriveCamProfile only reads from expenseRules.
    let capPercent = blueprint.camLike ? explicitCapPercent : null;
    let baseYear = null;
    let expenseStopAmount = null;
    let adminFeePercent = explicitAdminFee;
    let grossUpPercent = explicitGrossUp;
    let tenantSharePercent = fieldMap.tenant_pro_rata_share?.value ?? null;
    let explicitChargeAmount = null;
    let fixedMonthlyAmount = null;
    let notes = "";
    let status: LeaseWorkflowField["extraction_status"] | "inferred" = mentioned ? "extracted" : "not_found";

    if (blueprint.fixedChargeField) {
      explicitChargeAmount = asNumber(row?.[blueprint.fixedChargeField]);
      if (explicitChargeAmount != null) fixedMonthlyAmount = explicitChargeAmount;
    }
    if (blueprint.key === "utilities") {
      explicitChargeAmount = asNumber(row?.utility_reimbursement_amount);
    }
    if (blueprint.key === "water" || blueprint.key === "sewer") {
      explicitChargeAmount = asNumber(row?.water_sewer_reimbursement_amount);
    }
    if (blueprint.key === "property_insurance" || blueprint.key === "tenant_insurance") {
      explicitChargeAmount = asNumber(row?.insurance_reimbursement_amount);
    }
    if (blueprint.key === "real_estate_taxes") {
      explicitChargeAmount = asNumber(row?.tax_reimbursement_amount);
    }
    if (blueprint.key === "cam" || blueprint.key === "common_area_maintenance") {
      explicitChargeAmount = asNumber(row?.cam_amount ?? row?.fixed_cam_amount);
    }
    if (blueprint.key === "percentage_rent") {
      explicitChargeAmount = asNumber(row?.percentage_rate);
    }

    if (explicitChargeAmount != null && fixedMonthlyAmount == null && !blueprint.direct && !blueprint.percentageRent) {
      fixedMonthlyAmount = explicitChargeAmount;
    }

    if (isFullService || isGross) {
      if ([
        "utilities", "electricity", "water", "sewer", "gas", "hvac", "janitorial",
        "real_estate_taxes", "property_insurance", "cam", "common_area_maintenance", "operating_expenses",
      ].includes(blueprint.key)) {
        includedInBaseRent = true;
        separatelyBilled = false;
        recoverableFromTenant = false;
        recoveryMethod = "included_in_rent";
        notes = "Included in base rent under full-service / gross lease treatment.";
        status = mentioned ? "extracted" : "inferred";
      }
      if (["excess_utilities", "tenant_caused_repairs", "tenant_caused_damage", "legal_default_costs", "legal_fees", "separately_metered_charges", "excess_usage"].includes(blueprint.key)) {
        includedInBaseRent = false;
        separatelyBilled = true;
        recoverableFromTenant = true;
        recoveryMethod = "direct_bill";
        allocationBasis = blueprint.key === "separately_metered_charges" || blueprint.key === "excess_usage" ? "metered_usage" : "fixed_amount";
        notes = "Billable exception charge under full-service / gross lease.";
        status = mentioned ? "extracted" : "inferred";
      }
    } else if (isTripleNet) {
      if (blueprint.camLike || ["utilities", "electricity", "water", "sewer", "gas", "hvac", "janitorial"].includes(blueprint.key)) {
        includedInBaseRent = false;
        separatelyBilled = true;
        recoverableFromTenant = true;
        recoveryMethod = explicitChargeAmount != null ? "fixed_monthly" : (tenantSharePercent != null ? "pro_rata_share" : "manual_review");
        allocationBasis = tenantSharePercent != null ? "rentable_area" : "manual";
        notes = "Recoverable under Triple Net structure.";
        status = explicitChargeAmount != null ? "extracted" : (tenantSharePercent != null ? "calculated" : "manual_required");
      }
    } else if (isDoubleNet) {
      if (["real_estate_taxes", "property_insurance"].includes(blueprint.key)) {
        includedInBaseRent = false;
        separatelyBilled = true;
        recoverableFromTenant = true;
        recoveryMethod = tenantSharePercent != null ? "pro_rata_share" : "manual_review";
        status = tenantSharePercent != null ? "calculated" : "manual_required";
        notes = "Recoverable under Double Net structure.";
      }
    } else if (isSingleNet) {
      if (blueprint.key === "real_estate_taxes") {
        includedInBaseRent = false;
        separatelyBilled = true;
        recoverableFromTenant = true;
        recoveryMethod = tenantSharePercent != null ? "pro_rata_share" : "manual_review";
        status = tenantSharePercent != null ? "calculated" : "manual_required";
        notes = "Recoverable under Single Net structure.";
      }
    } else if (isModifiedGross) {
      if (mentioned) {
        includedInBaseRent = responsibility === "landlord" ? true : responsibility === "tenant" ? false : null;
        separatelyBilled = responsibility === "tenant" || responsibility === "shared";
        recoverableFromTenant = responsibility === "tenant" || responsibility === "shared";
        recoveryMethod = recoverableFromTenant ? (explicitChargeAmount != null ? "fixed_monthly" : tenantSharePercent != null ? "pro_rata_share" : "manual_review") : "included_in_rent";
        status = recoverableFromTenant && recoveryMethod === "manual_review" ? "manual_required" : "extracted";
        notes = "Mixed included and recoverable treatment under Modified Gross lease.";
      }
    } else if (isBaseYear) {
      if (blueprint.camLike || ["utilities", "janitorial", "real_estate_taxes", "property_insurance", "operating_expenses"].includes(blueprint.key)) {
        includedInBaseRent = false;
        separatelyBilled = true;
        recoverableFromTenant = true;
        recoveryMethod = "base_year_excess";
        allocationBasis = tenantSharePercent != null ? "rentable_area" : "manual";
        capType = "base_year";
        baseYear = asNumber(fieldMap.base_year?.value);
        capAmount = explicitBaseYear;
        status = baseYear != null && explicitBaseYear != null && tenantSharePercent != null ? "calculated" : "manual_required";
        notes = explicitBaseYear == null
          ? "Base year exists, but base year expense amount was not found."
          : "Tenant pays increases above base year.";
      }
    } else if (isExpenseStop) {
      if (blueprint.camLike || ["utilities", "janitorial", "operating_expenses"].includes(blueprint.key)) {
        includedInBaseRent = false;
        separatelyBilled = true;
        recoverableFromTenant = true;
        recoveryMethod = "expense_stop_excess";
        allocationBasis = tenantSharePercent != null ? "rentable_area" : "manual";
        capType = "expense_stop";
        expenseStopAmount = explicitExpenseStop;
        status = expenseStopAmount != null && tenantSharePercent != null ? "calculated" : "manual_required";
        notes = "Tenant pays expenses above the expense stop threshold.";
      }
    } else if (isFixedCam && (blueprint.key === "cam" || blueprint.key === "common_area_maintenance")) {
      includedInBaseRent = false;
      separatelyBilled = true;
      recoverableFromTenant = true;
      recoveryMethod = "fixed_monthly";
      allocationBasis = "fixed_amount";
      fixedMonthlyAmount = asNumber(fieldMap.fixed_cam_amount?.value) ?? explicitChargeAmount;
      explicitChargeAmount = fixedMonthlyAmount;
      status = fixedMonthlyAmount != null ? "calculated" : "manual_required";
      notes = "Fixed CAM charge under the lease.";
    } else if (isPercentageRent && blueprint.key === "percentage_rent") {
      includedInBaseRent = false;
      separatelyBilled = true;
      recoverableFromTenant = true;
      recoveryMethod = "percentage_rent";
      allocationBasis = "gross_sales";
      status = asNumber(fieldMap.percentage_rate?.value) != null ? "extracted" : "manual_required";
      notes = "Percentage rent based on gross sales and breakpoint.";
    } else if (isGroundLease) {
      if (["real_estate_taxes", "property_insurance", "cam", "common_area_maintenance", "operating_expenses", "roof_structure", "foundation_structure", "exterior_repairs"].includes(blueprint.key)) {
        includedInBaseRent = false;
        separatelyBilled = false;
        recoverableFromTenant = false;
        recoveryMethod = "tenant_direct_contract";
        allocationBasis = "manual";
        status = mentioned ? "extracted" : "inferred";
        notes = "Tenant usually bears the obligation directly under a ground lease.";
      }
    }

    if (blueprint.tenantDirect) {
      includedInBaseRent = false;
      separatelyBilled = false;
      recoverableFromTenant = false;
      recoveryMethod = "tenant_direct_contract";
      allocationBasis = "manual";
      tenantSharePercent = null;
      status = mentioned ? "extracted" : "inferred";
      notes = notes || "Tenant pays directly under the lease.";
    }

    if (blueprint.direct) {
      includedInBaseRent = false;
      separatelyBilled = true;
      recoverableFromTenant = true;
      recoveryMethod = blueprint.key === "separately_metered_charges" || blueprint.key === "excess_usage"
        ? "actual_usage"
        : "direct_bill";
      allocationBasis = recoveryMethod === "actual_usage" ? "metered_usage" : "fixed_amount";
      status = mentioned || explicitChargeAmount != null ? "extracted" : "inferred";
      notes = notes || "Direct reimbursement obligation triggered by lease exception language.";
    }

    if (explicitChargeAmount != null && recoverableFromTenant == null) {
      includedInBaseRent = false;
      separatelyBilled = true;
      recoverableFromTenant = true;
      recoveryMethod = blueprint.percentageRent
        ? "percentage_rent"
        : blueprint.direct
          ? recoveryMethod
          : "fixed_monthly";
      allocationBasis = blueprint.percentageRent ? "gross_sales" : "fixed_amount";
      status = mentioned ? "extracted" : "calculated";
      notes = notes || "Explicit recurring charge extracted from the lease.";
    }

    if (includedInBaseRent == null && mentioned) {
      includedInBaseRent = responsibility === "landlord" ? true : responsibility === "tenant" ? false : null;
      separatelyBilled = responsibility === "tenant" ? true : null;
      recoverableFromTenant = responsibility === "tenant" ? true : responsibility === "landlord" ? false : null;
      recoveryMethod = recoverableFromTenant ? "manual_review" : includedInBaseRent ? "included_in_rent" : recoveryMethod;
      status = recoverableFromTenant == null ? "manual_required" : "extracted";
      notes = notes || "Lease mentions this category, but treatment needs review.";
    }

    if (blueprint.key === "percentage_rent" && asNumber(fieldMap.percentage_rate?.value) != null) {
      includedInBaseRent = false;
      separatelyBilled = true;
      recoverableFromTenant = true;
      recoveryMethod = "percentage_rent";
      allocationBasis = "gross_sales";
      status = asNumber(fieldMap.breakpoint_amount?.value) != null ? "extracted" : "manual_required";
      notes = notes || "Percentage rent rules were extracted from lease rent clauses.";
    }

    if (blueprint.key === "cam" && asNumber(fieldMap.fixed_cam_amount?.value) != null) {
      includedInBaseRent = false;
      separatelyBilled = true;
      recoverableFromTenant = true;
      recoveryMethod = "fixed_monthly";
      allocationBasis = "fixed_amount";
      fixedMonthlyAmount = asNumber(fieldMap.fixed_cam_amount?.value);
      explicitChargeAmount = fixedMonthlyAmount;
      status = "calculated";
      notes = notes || "Fixed CAM amount extracted from lease CAM clause.";
    }

    const leaseTreatment =
      includedInBaseRent === true
        ? "included_in_rent"
        : recoverableFromTenant === true
          ? "tenant_recovery"
          : recoveryMethod === "tenant_direct_contract"
            ? "tenant_direct"
            : "manual_review";
    const recoveryStatus =
      recoverableFromTenant === true
        ? (blueprint.conditional ? "conditional" : "recoverable")
        : includedInBaseRent === true
          ? "non_recoverable"
          : recoveryMethod === "tenant_direct_contract"
            ? "excluded"
            : "needs_review";

    const clauseText = supportingClause?.clause_text || excerptForKeywords(textBlocks, fullText, blueprint.keywords);
    const sourcePage = supportingClause?.source_page ?? null;
    // Honest evidence requires SOMETHING from the document: a real clause
    // text snippet or a source_page anchor. If we have neither, the rule
    // is at best inferred from lease-type heuristics — not extracted.
    // Reflect that in BOTH the extraction_status and the confidence so the
    // UI doesn't show "Missing" alongside "99%" anymore.
    const hasRealEvidence = Boolean(clauseText) || sourcePage != null;
    const effectiveStatus: typeof status =
      !hasRealEvidence && (status === "extracted" || status === "inferred")
        ? "missing_source_evidence"
        : status;
    const confidence =
      effectiveStatus === "calculated" ? 0.9
      : effectiveStatus === "manual_required" ? 0.45
      : effectiveStatus === "missing_source_evidence" ? 0.35
      : mentioned ? 0.78
      : 0.55;

    return {
      expense_category: blueprint.key,
      expense_subcategory: null,
      category_name: blueprint.title,
      responsibility,
      included_in_base_rent: includedInBaseRent,
      separately_billed: separatelyBilled,
      recoverable_from_tenant: recoverableFromTenant,
      recovery_method: recoveryMethod,
      allocation_basis: allocationBasis,
      cap_type: capType,
      cap_amount: capAmount,
      cap_percent: capPercent,
      base_year: baseYear,
      expense_stop_amount: expenseStopAmount,
      admin_fee_percent: adminFeePercent,
      gross_up_percent: grossUpPercent,
      source_clause: clauseText || null,
      exact_source_text: clauseText || null,
      source_page: sourcePage,
      confidence_score: confidence,
      extraction_status: effectiveStatus,
      status: effectiveStatus,
      editable: true,
      notes,
      fixed_monthly_amount: fixedMonthlyAmount,
      explicit_charge_amount: explicitChargeAmount,
      // compatibility fields used by existing app services
      lease_treatment: leaseTreatment,
      included_in_rent: includedInBaseRent,
      recoverable_flag: recoverableFromTenant,
      tenant_share_percent: tenantSharePercent,
      billing_frequency: fixedMonthlyAmount != null || explicitChargeAmount != null ? "monthly" : (blueprint.direct ? "triggered" : "none"),
      rule_classification: recoveryStatus,
      clauses: clauseText
        ? [{
          clause_type: supportingClause?.clause_type || "supporting_text",
          clause_text: clauseText,
          page_number: sourcePage,
          confidence,
        }]
        : [],
    };
  });

  const sourceBackedRules = rules.filter((rule) => {
    const sourcePage = asNumber(rule.source_page);
    const sourceClause = cleanSourceText(rule.source_clause);
    const clauseType = String(rule.clauses?.[0]?.clause_type || "").toLowerCase();
    return Boolean(sourceClause) && sourcePage != null && sourcePage > 0 && clauseType !== "supporting_text";
  });

  return finalizeDerivedExpenseRules(sourceBackedRules);
}

function deriveCamProfile(fieldMap: Record<string, LeaseWorkflowField>, expenseRules: any[]) {
  const leaseType = cleanText(fieldMap.lease_type?.value || "");
  const normalizedLeaseType = leaseType.toLowerCase().replace(/[_-]+/g, " ");
  const tenantRsf = asNumber(fieldMap.tenant_rsf?.value);
  const buildingRsf = asNumber(fieldMap.building_rsf?.value);
  const proRataShare = asNumber(fieldMap.tenant_pro_rata_share?.value);
  const camCategories = [
    "cam",
    "common_area_maintenance",
    "operating_expenses",
    "real_estate_taxes",
    "property_insurance",
    "management_fees",
    "administrative_fees",
  ];
  const camRules = expenseRules.filter((rule) => camCategories.includes(rule.expense_category));
  const includedExpenses = camRules.filter((rule) => rule.included_in_base_rent === true).map((rule) => rule.expense_category);
  const recoverableExpenses = camRules.filter((rule) => ["yes", "conditional", true].includes(rule.recoverable_from_tenant as any)).map((rule) => rule.expense_category);
  const excludedExpenses = camRules.filter((rule) => rule.rule_classification === "excluded").map((rule) => rule.expense_category);
  const estimateBasedRules = camRules.filter((rule) =>
    ["pro_rata_share", "base_year_excess", "expense_stop_excess"].includes(rule.recovery_method),
  );
  const fixedRules = camRules.filter((rule) => rule.recovery_method === "fixed_monthly");
  const fixedMonthlyCharge = round2(
    fixedRules.reduce((sum, rule) => sum + (asNumber(rule.fixed_monthly_amount) ?? asNumber(rule.explicit_charge_amount) ?? 0), 0),
  );
  const reconciliationRequired = estimateBasedRules.length > 0;
  const manualRequired =
    (recoverableExpenses.length > 0 && !reconciliationRequired && fixedMonthlyCharge === 0) ||
    (estimateBasedRules.length > 0 && proRataShare == null);
  const recoveryStatus =
    recoverableExpenses.length === 0
      ? "Included in Rent"
      : includedExpenses.length > 0
        ? "Mixed Recovery"
        : "Tenant Recoverable";
  const camStructure =
    leaseType ||
    (recoverableExpenses.length === 0 ? "Gross Lease" : "Manual Review");
  const estimateFrequency = fixedRules.length > 0 ? "monthly" : recoverableExpenses.length > 0 ? "monthly" : "none";
  const reconciliationFrequency = reconciliationRequired ? "annual" : "none";
  const status = manualRequired ? "manual_required" : "active";

  return {
    cam_structure: camStructure,
    recovery_status: recoveryStatus,
    cam_start_date: fieldMap.commencement_date?.value || null,
    cam_end_date: fieldMap.expiration_date?.value || null,
    estimate_frequency: estimateFrequency,
    reconciliation_frequency: reconciliationFrequency,
    tenant_rsf: tenantRsf,
    building_rsf: buildingRsf,
    tenant_pro_rata_share: proRataShare,
    cam_cap_type: camRules.find((rule) => rule.cap_type && rule.cap_type !== "none")?.cap_type || null,
    cam_cap_percent: camRules.find((rule) => asNumber(rule.cap_percent) != null)?.cap_percent ?? null,
    admin_fee_percent: camRules.find((rule) => asNumber(rule.admin_fee_percent) != null)?.admin_fee_percent ?? null,
    gross_up_percent: camRules.find((rule) => asNumber(rule.gross_up_percent) != null)?.gross_up_percent ?? null,
    included_expenses: includedExpenses,
    recoverable_expenses: recoverableExpenses,
    excluded_expenses: excludedExpenses,
    actual_cam_expense: null,
    annual_cam_estimate: fixedMonthlyCharge > 0 ? round2(fixedMonthlyCharge * 12) : null,
    estimated_cam_billed: fixedMonthlyCharge > 0 ? round2(fixedMonthlyCharge * 12) : 0,
    reconciliation_amount: reconciliationRequired ? null : 0,
    tenant_balance_due_or_credit: reconciliationRequired ? null : 0,
    monthly_cam_charge: /full service|gross lease/.test(normalizedLeaseType) ? 0 : fixedMonthlyCharge,
    annual_cam_charge: fixedMonthlyCharge > 0 ? round2(fixedMonthlyCharge * 12) : 0,
    normal_expense_recovery: /full service|gross lease/.test(normalizedLeaseType) ? 0 : (fixedMonthlyCharge > 0 ? round2(fixedMonthlyCharge * 12) : null),
    reconciliation_required: reconciliationRequired,
    status,
    calculation_status: manualRequired ? "manual_required" : "calculated",
  };
}

function monthRange(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate) return [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];

  const months = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= endCursor) {
    months.push({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      label: cursor.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function deriveBudgetPreview(fieldMap: Record<string, LeaseWorkflowField>, expenseRules: any[], camProfile: any) {
  const monthlyRent = asNumber(fieldMap.base_rent_monthly?.value) ?? 0;
  const leaseType = cleanText(fieldMap.lease_type?.value || "");
  const months = monthRange(
    String(fieldMap.commencement_date?.value || ""),
    String(fieldMap.expiration_date?.value || ""),
  );
  const rentBudget = months.map((month) => ({
    month: month.label,
    budget_category: "base_rent",
    amount: monthlyRent,
    source: "lease",
    calculation_method: "base_rent_monthly",
    editable: true,
    status: monthlyRent > 0 ? "calculated" : "manual_required",
  }));

  const annualBaseRent = round2(monthlyRent * months.length);
  const operatingExpenseBudget = EXPENSE_CATEGORIES.map((category) => {
    const matchingRule = expenseRules.find((rule) => rule.expense_category === category);
    return {
      budget_category: category,
      included_in_rent: matchingRule?.included_in_rent ?? null,
      tenant_recoverable_amount: matchingRule?.recoverable_flag ? null : 0,
      source: matchingRule ? "lease_rule" : "default_category",
      status: matchingRule?.status || "manual_required",
    };
  });

  const recurringAmountFor = (categories: string[]) =>
    round2(
      expenseRules
        .filter((rule) => categories.includes(rule.expense_category) && rule.recoverable_flag)
        .reduce((sum, rule) => sum + (asNumber(rule.fixed_monthly_amount) ?? asNumber(rule.explicit_charge_amount) ?? 0), 0),
    );

  const monthlyCam = camProfile.monthly_cam_charge ?? recurringAmountFor(["cam", "common_area_maintenance", "operating_expenses"]);
  const monthlyTax = recurringAmountFor(["real_estate_taxes"]);
  const monthlyInsurance = recurringAmountFor(["property_insurance"]);
  const monthlyUtilities = recurringAmountFor(["utilities", "electricity", "water", "sewer", "gas", "hvac"]);
  const monthlyFixedCharges = recurringAmountFor(["parking", "additional_rent"]);
  const monthlyPercentageRent = /percentage rent/i.test(leaseType) ? 0 : recurringAmountFor(["percentage_rent"]);
  const monthlyOtherRecoveries = recurringAmountFor([
    "janitorial",
    "security",
    "trash_removal",
    "landscaping",
    "snow_removal",
    "management_fees",
    "administrative_fees",
  ]);

  const tenantBillingSchedule = months.map((month) => {
    const totalMonthlyInvoice = round2(
      monthlyRent +
      monthlyCam +
      monthlyTax +
      monthlyInsurance +
      monthlyUtilities +
      monthlyFixedCharges +
      monthlyPercentageRent +
      monthlyOtherRecoveries,
    );
    return {
      month: month.label,
      base_rent: monthlyRent,
      cam: monthlyCam,
      taxes: monthlyTax,
      insurance: monthlyInsurance,
      utilities: monthlyUtilities,
      fixed_charges: monthlyFixedCharges,
      percentage_rent: monthlyPercentageRent,
      other_recoveries: monthlyOtherRecoveries,
      total_monthly_invoice: totalMonthlyInvoice,
      source: "lease_rules",
      status: monthlyRent > 0 ? "calculated" : "manual_required",
    };
  });

  const recoveries = expenseRules.map((rule) => ({
    budget_category: rule.expense_category,
    annual_recovery: (() => {
      const fixedAmount = asNumber(rule.fixed_monthly_amount) ?? asNumber(rule.explicit_charge_amount);
      if (rule.recoverable_flag !== true) return 0;
      if (fixedAmount != null) return round2(fixedAmount * 12);
      return null;
    })(),
    source: "lease_rule",
    calculation_method: rule.recovery_method,
    status: rule.status,
  }));

  const renewalEscalationPercent = asNumber(fieldMap.renewal_escalation_percent?.value);
  const renewalProjection = renewalEscalationPercent != null && monthlyRent > 0
    ? [
      {
        year: 1,
        monthly_rent: round2(monthlyRent * (1 + renewalEscalationPercent / 100)),
        status: "calculated",
      },
      {
        year: 2,
        monthly_rent: round2(monthlyRent * (1 + renewalEscalationPercent / 100) * (1 + renewalEscalationPercent / 100)),
        status: "calculated",
      },
    ]
    : [];

  return {
    rent_revenue_budget: rentBudget,
    operating_expense_budget: operatingExpenseBudget,
    cam_recovery_budget: recoveries,
    tenant_billing_schedule: tenantBillingSchedule,
    annual_base_rent: annualBaseRent,
    renewal_projection: renewalProjection,
  };
}

function buildValidationResults(fieldMap: Record<string, LeaseWorkflowField>, expenseRules: any[], camProfile: any, budgetPreview: any) {
  const results = [];
  const leaseType = cleanText(fieldMap.lease_type?.value || "");
  const normalizedLeaseType = leaseType.toLowerCase().replace(/[_-]+/g, " ");
  const isFullService = /full service|gross/.test(normalizedLeaseType);

  if (isFullService) {
    results.push({
      rule: "full_service_cam_zero",
      pass: camProfile.monthly_cam_charge === 0,
      message: "Full Service Lease must produce zero monthly CAM charge.",
    });
    results.push({
      rule: "full_service_normal_expense_recovery_zero",
      pass: camProfile.normal_expense_recovery === 0,
      message: "Full Service Lease must produce zero normal expense recovery.",
    });
  }

  const tenantRsf = asNumber(fieldMap.tenant_rsf?.value);
  const buildingRsf = asNumber(fieldMap.building_rsf?.value);
  results.push({
    rule: "tenant_prorata_manual_required_when_building_missing",
    pass: !(tenantRsf && !buildingRsf) || fieldMap.tenant_pro_rata_share?.extraction_status === "manual_required",
    message: "Tenant pro-rata share requires manual review when tenant RSF exists but building RSF is missing.",
  });

  results.push({
    rule: "monthly_rent_schedule_generated",
    pass: !(asNumber(fieldMap.base_rent_monthly?.value) && fieldMap.commencement_date?.value && fieldMap.expiration_date?.value) ||
      (budgetPreview.rent_revenue_budget?.length || 0) > 0,
    message: "Monthly rent schedule should be generated when rent and term dates are present.",
  });

  results.push({
    rule: "renewal_projection_generated",
    pass: !asNumber(fieldMap.renewal_escalation_percent?.value) || (budgetPreview.renewal_projection?.length || 0) > 0,
    message: "Renewal projection should be generated when renewal escalation percent exists.",
  });

  for (const category of ["utilities", "janitorial", "property_tax", "property_insurance"]) {
    const normalizedCategory = category === "property_tax" ? "real_estate_taxes" : category;
    const rule = expenseRules.find((item) => item.expense_category === normalizedCategory);
    if (isFullService && rule) {
      results.push({
        rule: `full_service_${normalizedCategory}_included_in_rent`,
        pass: rule.included_in_rent === true && rule.recoverable_flag === false,
        message: `${normalizedCategory} should be included in rent and non-recoverable for full-service leases.`,
      });
    }
  }

  for (const category of ["excess_usage", "tenant_caused_damage", "legal_enforcement_fees"]) {
    const rule = expenseRules.find((item) => item.expense_category === category);
    if (rule) {
      results.push({
        rule: `direct_reimbursement_${category}`,
        pass: rule.included_in_rent === false && rule.recoverable_flag === true && ["direct_bill", "actual_usage"].includes(rule.recovery_method),
        message: `${category} should be modeled as direct reimbursement.`,
      });
    }
  }

  if (/fixed cam/i.test(leaseType)) {
    const fixedCamRule = expenseRules.find((item) => ["common_area_maintenance", "cam"].includes(item.expense_category));
    results.push({
      rule: "fixed_cam_has_monthly_charge",
      pass: (camProfile.monthly_cam_charge ?? 0) > 0 || asNumber(fixedCamRule?.fixed_monthly_amount) != null,
      message: "Fixed CAM leases should produce a fixed monthly CAM charge.",
    });
  }

  if (/base year/i.test(leaseType)) {
    results.push({
      rule: "base_year_amount_present_or_manual_review",
      pass: asNumber(fieldMap.base_year_expense_amount?.value) != null ||
        expenseRules.some((rule) => rule.recovery_method === "base_year_excess" && rule.status === "manual_required"),
      message: "Base Year leases require a base year amount or explicit manual review.",
    });
  }

  if (/expense stop/i.test(leaseType)) {
    results.push({
      rule: "expense_stop_present_or_manual_review",
      pass: asNumber(fieldMap.expense_stop_amount?.value) != null ||
        expenseRules.some((rule) => rule.recovery_method === "expense_stop_excess" && rule.status === "manual_required"),
      message: "Expense Stop leases require an expense stop amount or explicit manual review.",
    });
  }

  return results;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}

function normalizeConfidenceScore(value: unknown) {
  const numeric = asNumber(value);
  if (numeric == null) return null;
  if (numeric <= 1) return Math.max(0, Math.min(1, numeric));
  return Math.max(0, Math.min(1, numeric / 100));
}

function resolveCanonicalExpenseRuleConfig(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  for (const config of CANONICAL_EXPENSE_RULE_CONFIG) {
    if (config.aliases.some((alias) => normalizeToken(alias).replace(/[^a-z0-9]+/g, "_") === normalized)) {
      return config;
    }
  }

  return {
    canonicalKey: normalized || "uncategorized",
    categoryName: humanize(normalized || "uncategorized"),
    subcategoryName: null,
  };
}

function normalizeExpenseRuleSourceText(rule: Record<string, unknown>) {
  return cleanText(rule?.exact_source_text || rule?.source_clause || rule?.source || rule?.notes || "");
}

function isWeakExpenseRuleSourceText(value: unknown) {
  const text = cleanText(value);
  if (!text || text.length < 18) return true;
  return GENERIC_EXPENSE_RULE_SOURCE_PATTERNS.some((pattern) => pattern.test(text));
}

function isExpenseRuleResponsibilityKnown(value: unknown) {
  const normalized = normalizeToken(value);
  return Boolean(normalized) && !["unknown", "manual_review"].includes(normalized);
}

function isExpenseRuleRecoverableKnown(rule: Record<string, unknown>) {
  if (typeof rule?.recoverable_from_tenant === "boolean") return true;
  if (["yes", "no", "conditional"].includes(normalizeToken(rule?.recoverable_from_tenant))) return true;
  if (typeof rule?.included_in_base_rent === "boolean") return true;
  return ["recoverable", "conditional", "non_recoverable", "excluded"].includes(normalizeToken(rule?.rule_classification));
}

function isExpenseRuleRecoveryMethodSpecific(value: unknown) {
  const normalized = normalizeToken(value);
  return Boolean(normalized) && !["manual_review", "none", "unknown"].includes(normalized);
}

function scoreExpenseRuleCandidate(rule: Record<string, unknown>) {
  const confidence = normalizeConfidenceScore(rule?.confidence_score) ?? 0;
  const sourceText = normalizeExpenseRuleSourceText(rule);
  const hasPage = Number.isFinite(Number(rule?.source_page));
  return (
    (hasPage ? 200 : 0) +
    (isWeakExpenseRuleSourceText(sourceText) ? 0 : 160) +
    Math.round(confidence * 100) +
    (asNumber(rule?.explicit_charge_amount) != null || asNumber(rule?.fixed_monthly_amount) != null ? 25 : 0) +
    (normalizeToken(rule?.status) === "extracted" ? 20 : 0)
  );
}

function finalizeDerivedExpenseRules(rules: Record<string, unknown>[]) {
  const deduped = new Map<string, Record<string, unknown>>();

  for (const rule of rules || []) {
    const canonical = resolveCanonicalExpenseRuleConfig(rule?.expense_category || rule?.category || rule?.key);
    if (EXCLUDED_EXPENSE_RULE_KEYS.has(canonical.canonicalKey)) continue;

    const exactSourceText = normalizeExpenseRuleSourceText(rule);
    const hasStrongEvidence =
      Number.isFinite(Number(rule?.source_page)) &&
      !isWeakExpenseRuleSourceText(exactSourceText);
    const explicitExtractionStatus = normalizeToken(rule?.extraction_status || rule?.status);
    const extractionStatus =
      explicitExtractionStatus === "not_found"
        ? "not_found"
        : explicitExtractionStatus === "manual_required"
          ? "manual_required"
          : explicitExtractionStatus === "calculated" && hasStrongEvidence
            ? "calculated"
            : hasStrongEvidence
              ? "extracted"
              : "inferred";
    const confidenceScore = normalizeConfidenceScore(rule?.confidence_score);
    const autoApproved =
      extractionStatus !== "inferred" &&
      extractionStatus !== "manual_required" &&
      hasStrongEvidence &&
      isExpenseRuleResponsibilityKnown(rule?.responsibility) &&
      isExpenseRuleRecoverableKnown(rule) &&
      isExpenseRuleRecoveryMethodSpecific(rule?.recovery_method) &&
      confidenceScore != null &&
      confidenceScore >= 0.82;
    const reviewStatus = autoApproved ? "approved" : "needs_review";
    const normalizedRule = {
      ...rule,
      expense_category: canonical.canonicalKey,
      category_name: canonical.categoryName,
      expense_subcategory: canonical.subcategoryName || null,
      subcategory_name: canonical.subcategoryName || null,
      normalized_key: canonical.canonicalKey,
      exact_source_text: exactSourceText || null,
      extraction_status: extractionStatus,
      status: extractionStatus,
      confidence_score: confidenceScore,
      review_status: reviewStatus,
      approval_status: "draft",
      published_to_cam: false,
      row_status: extractionStatus === "not_found" ? "not_mentioned" : autoApproved ? "mapped" : "needs_review",
      responsibility: isExpenseRuleResponsibilityKnown(rule?.responsibility) ? rule?.responsibility : "unknown",
    };

    const dedupKey = `${canonical.canonicalKey}::${normalizeToken(canonical.subcategoryName).replace(/[^a-z0-9]+/g, "_")}`;
    const existing = deduped.get(dedupKey);
    if (!existing || scoreExpenseRuleCandidate(normalizedRule) >= scoreExpenseRuleCandidate(existing)) {
      deduped.set(dedupKey, normalizedRule);
    }
  }

  return [...deduped.values()];
}

export function buildLeaseWorkflowAbstraction(args: {
  row: Record<string, unknown>;
  doclingRaw?: Record<string, unknown> | null;
  documentSubtype?: string | null;
}) {
  const row = args?.row || {};
  const doclingRaw = args?.doclingRaw || {};
  const fullText = cleanText(doclingRaw?.full_text || "");
  // doclingPagesParsed = number of distinct pages Docling produced text
  // blocks for. For scanned / handwritten PDFs this is often << the real
  // page count because Docling can't structure-parse image-only pages.
  // pdfPageCountTotal = the source PDF's actual page count, surfaced by
  // parse-pdf-docling on doclingRaw.page_count. When file bytes are sent
  // to Vision (callVertexAIFileJSON) Gemini reads ALL pages natively,
  // even when Docling only produced text blocks for one.
  const doclingPagesParsed = new Set(
    asArray(doclingRaw?.text_blocks)
      .map((block) => sourcePageOf(block))
      .filter((page) => page != null),
  ).size;
  const pdfPageCountTotal = (() => {
    const n = Number((doclingRaw as any)?.page_count);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  // Back-compat: keep `pages_detected` as docling-parsed pages so older
  // panels keep working. New panels can read pdf_page_count_total.
  const pagesDetected = doclingPagesParsed;
  const clauses = buildClauseRecords(doclingRaw, fullText);
  let profileDetection = detectDocumentProfileSignals(fullText, args?.documentSubtype || null);
  let documentProfile = profileDetection.selected_document_profile;
  const leaseFields = buildLeaseFieldMap(row, doclingRaw, clauses);
  let extractedDocumentItems = buildUniversalDocumentItems({
    row,
    doclingRaw,
    fullText,
    documentProfile,
    leaseFields,
    clauses,
  });
  applyDocumentItemsToLeaseFields(leaseFields, extractedDocumentItems);
  profileDetection = detectDocumentProfileSignals(fullText, args?.documentSubtype || null, leaseFields, extractedDocumentItems);
  if (profileDetection.selected_document_profile !== documentProfile) {
    documentProfile = profileDetection.selected_document_profile;
  }
  extractedDocumentItems = buildUniversalDocumentItems({
    row,
    doclingRaw,
    fullText,
    documentProfile,
    leaseFields,
    clauses,
  });
  const genericSourceTextRejected = Object.values(leaseFields).reduce((count, field) => {
    if (field?.source_clause && isGenericSourceText(field.source_clause)) {
      field.source_clause = null;
      if (field.extraction_status === "extracted") field.extraction_status = "missing_source_evidence";
      return count + 1;
    }
    if (
      !isBlank(field?.value) &&
      field?.extraction_status === "extracted" &&
      !field?.source_clause &&
      !Number.isFinite(Number(field?.source_page))
    ) {
      field.extraction_status = "missing_source_evidence";
    }
    return count;
  }, 0);
  const assignmentItems = extractedDocumentItems.filter((item) =>
    ["assignment_amendment", "parties_premises", "dates_term", "rent_charges"].includes(String(item.business_area || "")) &&
    ["assignment", "amendment", "assignment_amendment"].includes(documentProfile)
  );
  const premisesCandidates = extractedDocumentItems
    .filter((item) => item.item_type === "premises_address" || item.field_key === "property_address")
    .map((item) => ({ value: item.value, source_text: item.source_text, source_page: item.source_page }));
  const mappedFieldsFromAssignment = assignmentItems.filter((item) => item.maps_to_existing_field).length;
  console.log("[lease-workflow assignment mapping]", {
    document_profile: documentProfile,
    profile_detection_signals: profileDetection.profile_detection_signals,
    assignment_signal_count: profileDetection.assignment_signal_count,
    amendment_signal_count: profileDetection.amendment_signal_count,
    assignment_items_extracted: assignmentItems.length,
    mapped_fields_from_assignment: mappedFieldsFromAssignment,
    premises_address_candidates: premisesCandidates,
    selected_premises_address: leaseFields.property_address?.value ?? null,
    selected_premises_address_source_text: leaseFields.property_address?.source_clause ?? null,
    generic_source_text_rejected: genericSourceTextRejected,
    extracted_document_items_count: extractedDocumentItems.length,
  });
  let expenseRules = deriveExpenseRules(row, leaseFields, clauses, doclingRaw);
  const signals = inferLeaseSignals(fullText, row);
  const finalLeaseType = classifyLeaseType(fullText, expenseRules, signals);
  const finalLeaseTypeCanonical = normalizeLeaseTypeValue(finalLeaseType);
  // Only apply the computed type when it adds information:
  //   (a) The computed type is a real classification (not the Unknown fallback), OR
  //   (b) The current type is blank/not_found (Unknown is still better than nothing).
  // This prevents classifyLeaseType from clobbering a valid LLM extraction of
  // e.g. "modified_gross" with "Unknown / Manual Review" when the embedded
  // text is too short (page 1 only) to trigger the signal checks.
  const currentLlmType = leaseFields.lease_type?.value;
  const currentIsBlank = isBlank(currentLlmType) || leaseFields.lease_type?.extraction_status === "not_found";
  const computedIsUnknown = !finalLeaseTypeCanonical;
  const shouldApplyComputed = (finalLeaseTypeCanonical || currentIsBlank) && finalLeaseTypeCanonical !== currentLlmType &&
    (!computedIsUnknown || currentIsBlank);
  if (shouldApplyComputed) {
    leaseFields.lease_type = {
      ...(leaseFields.lease_type || {
        key: "lease_type",
        source_page: null,
        source_clause: null,
        confidence_score: null,
        extraction_status: "not_found",
        editable: true,
        field_group: "lease_header",
      }),
      value: finalLeaseTypeCanonical,
      extraction_status: finalLeaseTypeCanonical ? "calculated" : "manual_required",
      confidence_score: finalLeaseTypeCanonical ? 0.86 : 0.5,
    };
    expenseRules = deriveExpenseRules(row, leaseFields, clauses, doclingRaw);
  }

  // ── Assignment / amendment short-circuit ──────────────────────────────
  // For assignment / amendment / consent / estoppel documents that don't
  // contain an explicit expense recovery clause, the blueprint loop above
  // produces ~31 "not_found" coverage rows that the UI surfaces as
  // "lease expense rules generated". Replace them with a single
  // `original_lease_required` coverage marker so the panel reflects what
  // the document actually says.
  //
  // An explicit clause keeps the blueprint output intact so terms the
  // assignment introduces (e.g. "Assignee shall pay CAM charges from the
  // Effective Date") still extract into normal rules.
  const isAssignmentOrAmendment =
    documentProfile === "assignment"
    || documentProfile === "amendment"
    || documentProfile === "assignment_amendment"
    || /\b(consent|estoppel)\b/i.test(normalizeToken(`${args?.documentSubtype || ""} ${fullText}`));
  const explicitExpenseClausePatterns = [
    /tenant\s+shall\s+(?:pay|reimburse|contribute).{0,100}(?:cam|common\s+area\s+maintenance|operating\s+expenses?|real\s+estate\s+tax(?:es)?|property\s+tax(?:es)?|insurance\s+premium)/i,
    /(?:assignee|tenant)\s+shall\s+(?:pay|reimburse).{0,100}(?:cam|tax(?:es)?|insurance|utilit|operating\s+expenses?)/i,
    /(?:cam|common\s+area\s+maintenance|operating\s+expenses?).{0,140}(?:tenant'?s\s+pro\s*rata\s+share|reimburs|recover|additional\s+rent)/i,
    /base\s+year.{0,120}(?:operating\s+expenses?|tax(?:es)?|insurance)|expense\s+stop/i,
    /full[-\s]?service.{0,160}(?:utilities|janitorial|tax(?:es)?|insurance|operating\s+expenses?)/i,
    /separately\s+metered.{0,120}(?:tenant\s+shall\s+pay|direct(?:ly)?\s+to\s+(?:the\s+)?utility)/i,
    /utilities\s+shall\s+be.{0,80}(?:tenant'?s)?\s+(?:direct|sole)\s+responsibility/i,
  ];
  const explicitExpenseClauseCount = explicitExpenseClausePatterns
    .filter((pattern) => pattern.test(fullText))
    .length;
  const assignmentExpenseShortCircuitApplied =
    isAssignmentOrAmendment && explicitExpenseClauseCount === 0;
  const templateRulesSkippedCount = assignmentExpenseShortCircuitApplied ? expenseRules.length : 0;

  if (assignmentExpenseShortCircuitApplied) {
    // Use the "all other terms remain unchanged" / "ratification" clause as
    // source_text if it's present in the doc — otherwise null so the row
    // surfaces as needs_review without a fabricated quote.
    const ratificationSnippet = (() => {
      const m = fullText.match(/(?:all\s+other\s+terms[^.]{0,160}(?:remain[^.]{0,80}(?:same|unchanged|full\s+force))|ratif(?:y|ies|ied)[^.]{0,160})/i);
      return m?.[0] ? cleanText(m[0]).slice(0, 280) : null;
    })();
    expenseRules = [{
      expense_category: "original_lease_required",
      normalized_key: "original_lease_required",
      category_name: "Original Lease Required",
      rule_type: "coverage_gap",
      row_type: "coverage_gap",
      generation_source: "original_lease_required",
      source_type: "document_profile",
      source_field_key: "original_lease_required_for_expense_rules",
      document_profile: documentProfile,
      mentioned_in_lease: false,
      recoverable_from_tenant: "needs_review",
      cam_eligible: "needs_review",
      is_recoverable: false,
      is_excluded: false,
      published_to_cam: false,
      review_status: "needs_review",
      approval_status: "draft",
      extraction_status: "needs_review",
      row_status: "needs_review",
      source_clause: ratificationSnippet,
      exact_source_text: ratificationSnippet,
      source_page: null,
      confidence_score: 0.65,
      notes:
        `This document is an ${documentProfile.replace(/_/g, " ")} and does not contain expense recovery clauses. ` +
        "Load the original lease to extract CAM / tax / insurance / utility rules.",
    }];
  }
  // ── Core mapping success / failure diagnostics ────────────────────────
  // The expense-rule blueprint loop generates rows from loose keyword
  // presence in fullText, so it can report "N lease expense terms found"
  // even when NO standard lease field (tenant, rent, dates, premises) was
  // actually mapped from the document. To stop that from masquerading as a
  // successful extraction we measure how many standard fields were mapped
  // and how many are backed by real source evidence (a clause snippet or a
  // page anchor + confidence). A "source-backed" field is the only kind we
  // treat as a confirmed extraction.
  const fullTextChars = fullText.length;
  const leaseFieldList = Object.values(leaseFields);
  const mappedStandardFieldsCount = leaseFieldList.filter((field) => !isBlank(field?.value)).length;
  const sourceBackedFieldsCount = leaseFieldList.filter((field) =>
    !isBlank(field?.value) &&
    (field.extraction_status === "extracted" || field.extraction_status === "calculated") &&
    Number.isFinite(Number(field.confidence_score)) &&
    (!isBlank(field.source_clause) || Number.isFinite(Number(field.source_page)))
  ).length;
  const valueOnlyFieldsCount = leaseFieldList.filter((field) =>
    !isBlank(field?.value) &&
    isBlank(field.source_clause) &&
    !Number.isFinite(Number(field.source_page))
  ).length;
  const fieldsRejectedMissingSourceCount = leaseFieldList.filter((field) =>
    field?.extraction_status === "missing_source_evidence"
  ).length;
  const partialDocumentTextDetected = Boolean(
    pdfPageCountTotal &&
    pdfPageCountTotal > 1 &&
    doclingPagesParsed <= 1 &&
    fullTextChars > 0 &&
    fullTextChars < 2500,
  );
  // lease_structure is the normalized expense-recovery structure (distinct
  // from document_profile, which is the document's role). Derived from the
  // classified lease type so downstream can branch on modified_gross /
  // full_service / nnn / base_year without re-parsing the type label.
  const leaseStructure = (() => {
    const t = String(finalLeaseType || leaseFields.lease_type?.value || "").toLowerCase();
    if (!t || /unknown|manual/.test(t)) return null;
    if (/triple\s*net|nnn/.test(t)) return "nnn";
    if (/double\s*net/.test(t)) return "double_net";
    if (/single\s*net/.test(t)) return "single_net";
    if (/absolute\s*net/.test(t)) return "absolute_net";
    if (/base\s*year/.test(t)) return "base_year";
    if (/full\s*service/.test(t)) return "full_service";
    if (/industrial\s*gross/.test(t)) return "industrial_gross";
    if (/modified\s*gross/.test(t)) return "modified_gross";
    if (/gross/.test(t)) return "gross";
    return normalizeToken(t);
  })();
  // mapping_failure_reason: the single most diagnostic field. null when the
  // extraction produced source-backed standard fields.
  const mappingFailureReason = (() => {
    if (fullTextChars === 0) return "no_text_extracted";
    if (partialDocumentTextDetected) return "partial_document_text_detected";
    if (mappedStandardFieldsCount === 0) return "no_fields_mapped_from_document";
    if (sourceBackedFieldsCount === 0) return "fields_mapped_without_source_evidence";
    return null;
  })();
  const coreMappingFailed = mappingFailureReason !== null;

  // ── Expense-rule gating on core mapping failure (do NOT flow to CAM) ───
  // When NO standard lease field is source-backed, the keyword-derived
  // expense rows cannot be trusted as lease-derived terms. Demote any real
  // (non-coverage-gap) rules to coverage-gap / needs_review so they are not
  // presented as approved lease terms and do not publish to CAM / Expense
  // Classification. Source snippets are preserved so nothing is silently
  // dropped — the reviewer still sees what was detected.
  let expenseRulesDemotedForMappingFailure = 0;
  if (coreMappingFailed && !assignmentExpenseShortCircuitApplied) {
    expenseRules = expenseRules.map((rule: any) => {
      const isCoverageGap = rule?.rule_type === "coverage_gap" || rule?.generation_source === "original_lease_required";
      if (isCoverageGap) return rule;
      expenseRulesDemotedForMappingFailure += 1;
      return {
        ...rule,
        rule_type: "coverage_gap",
        row_type: "coverage_gap",
        lease_derived: false,
        coverage_gap_due_to_mapping_failure: true,
        recoverable_from_tenant: "needs_review",
        is_recoverable: false,
        published_to_cam: false,
        review_status: "needs_review",
        approval_status: "draft",
        extraction_status: "needs_review",
        row_status: "needs_review",
      };
    });
  }

  const camProfile = deriveCamProfile(leaseFields, expenseRules);
  const budgetPreview = deriveBudgetPreview(leaseFields, expenseRules, camProfile);
  const validations = buildValidationResults(leaseFields, expenseRules, camProfile, budgetPreview);

  return {
    document_subtype: args?.documentSubtype || null,
    document_profile: documentProfile,
    lease_structure: leaseStructure,
    mapping_failure_reason: mappingFailureReason,
    core_mapping_failed: coreMappingFailed,
    profile_detection_signals: profileDetection.profile_detection_signals,
    assignment_signal_count: profileDetection.assignment_signal_count,
    amendment_signal_count: profileDetection.amendment_signal_count,
    selected_document_profile: profileDetection.selected_document_profile,
    lease_fields: leaseFields,
    lease_clauses: clauses,
    extracted_document_items: extractedDocumentItems,
    clause_records: extractedDocumentItems,
    expense_rules: expenseRules,
    cam_profile: camProfile,
    budget_preview: budgetPreview,
    validations,
    summary: {
      extracted_field_count: Object.values(leaseFields).filter((field) => field.extraction_status === "extracted").length,
      extracted_source_backed_count: Object.values(leaseFields).filter((field) =>
        field.extraction_status === "extracted" &&
        !isBlank(field.value) &&
        Number.isFinite(Number(field.confidence_score)) &&
        (!isBlank(field.source_clause) || Number.isFinite(Number(field.source_page)))
      ).length,
      missing_source_evidence_count: Object.values(leaseFields).filter((field) => field.extraction_status === "missing_source_evidence").length,
      calculated_field_count: Object.values(leaseFields).filter((field) => field.extraction_status === "calculated").length,
      manual_required_count: Object.values(leaseFields).filter((field) => field.extraction_status === "manual_required").length,
      not_found_count: Object.values(leaseFields).filter((field) => field.extraction_status === "not_found").length,
      conflict_count: Object.values(leaseFields).filter((field) => field.extraction_status === "conflict_detected").length,
      clause_count: clauses.filter((clause) => clause.clause_text).length,
      extracted_document_item_count: extractedDocumentItems.length,
      expense_rule_count: expenseRules.length,
      validation_error_count: validations.filter((item) => item.pass === false).length,
      document_profile: documentProfile,
      selected_document_profile: profileDetection.selected_document_profile,
      profile_detection_signals: profileDetection.profile_detection_signals,
      assignment_signal_count: profileDetection.assignment_signal_count,
      amendment_signal_count: profileDetection.amendment_signal_count,
      // Assignment / amendment short-circuit diagnostics. When applied,
      // expense_rule_count drops to 1 (the original_lease_required marker)
      // and template_rules_skipped_count reflects how many blueprint
      // coverage rows were suppressed.
      assignment_expense_short_circuit_applied: assignmentExpenseShortCircuitApplied,
      explicit_expense_clause_count: explicitExpenseClauseCount,
      template_rules_skipped_count: templateRulesSkippedCount,
      original_lease_required_count: assignmentExpenseShortCircuitApplied ? 1 : 0,
      real_expense_rules_generated_count: assignmentExpenseShortCircuitApplied
        ? 0
        : expenseRules.filter((r: any) => r?.rule_type !== "coverage_gap" && r?.generation_source !== "original_lease_required").length,
      coverage_gap_rules_generated_count: expenseRules.filter((r: any) => r?.rule_type === "coverage_gap" || r?.generation_source === "original_lease_required").length,
      pages_detected: pagesDetected,
      docling_pages_parsed: doclingPagesParsed,
      pdf_page_count_total: pdfPageCountTotal,
      // Vision (Gemini multimodal) processes every page of the PDF when the
      // file bytes are sent via callVertexAIFileJSON. There's no per-page
      // toggle — it's all-or-nothing from the LLM step. This flag reflects
      // what's POSSIBLE; the actual vision_fallback_triggered diagnostic
      // (in normalize-pdf-output's extractionDebug) reflects what RAN.
      vision_pages_available: pdfPageCountTotal,
      fixed_fields_extracted: Object.values(leaseFields).filter((field) => field.extraction_status === "extracted").length,
      extracted_source_backed_count: Object.values(leaseFields).filter((field) =>
        field.extraction_status === "extracted" &&
        !isBlank(field.value) &&
        Number.isFinite(Number(field.confidence_score)) &&
        (!isBlank(field.source_clause) || Number.isFinite(Number(field.source_page)))
      ).length,
      missing_source_evidence_count: Object.values(leaseFields).filter((field) => field.extraction_status === "missing_source_evidence").length,
      calculated_count: Object.values(leaseFields).filter((field) => field.extraction_status === "calculated").length,
      manual_count: Object.values(leaseFields).filter((field) => field.extraction_status === "manual_required").length,
      not_found_count: Object.values(leaseFields).filter((field) => field.extraction_status === "not_found").length,
      dynamic_items_extracted: extractedDocumentItems.length,
      dynamic_items_displayed: extractedDocumentItems.filter((item) => item.creates_dynamic_row && item.display_tab !== "clause_records").length,
      mapped_items_count: extractedDocumentItems.filter((item) => item.maps_to_fixed_field).length,
      unmapped_items_count: extractedDocumentItems.filter((item) => !item.maps_to_fixed_field).length,
      clause_records_count: extractedDocumentItems.length,
      lease_expense_rules_generated: expenseRules.length,
      coverage_gaps_generated: extractedDocumentItems.filter((item) => item.requires_original_lease || item.extraction_status === "needs_review").length,
      rejected_generic_source_count: genericSourceTextRejected,
      // ── Core mapping diagnostics (drive mapping_failure_reason) ──────
      lease_structure: leaseStructure,
      mapping_failure_reason: mappingFailureReason,
      core_mapping_failed: coreMappingFailed,
      full_text_chars: fullTextChars,
      partial_document_text_detected: partialDocumentTextDetected,
      lease_fields_count: leaseFieldList.length,
      mapped_standard_fields_count: mappedStandardFieldsCount,
      source_backed_fields_count: sourceBackedFieldsCount,
      value_only_fields_count: valueOnlyFieldsCount,
      fields_rejected_missing_source_count: fieldsRejectedMissingSourceCount,
      fields_rejected_generic_source_count: genericSourceTextRejected,
      expense_rules_generated_count: expenseRules.length,
      real_expense_rules_count: coreMappingFailed
        ? 0
        : expenseRules.filter((r: any) => r?.rule_type !== "coverage_gap" && r?.generation_source !== "original_lease_required").length,
      coverage_gap_rules_count: expenseRules.filter((r: any) => r?.rule_type === "coverage_gap" || r?.generation_source === "original_lease_required").length,
      expense_rules_demoted_for_mapping_failure: expenseRulesDemotedForMappingFailure,
    },
  };
}
