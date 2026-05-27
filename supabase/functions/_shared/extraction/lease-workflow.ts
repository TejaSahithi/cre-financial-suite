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
  { type: "notices", title: "Notices", keywords: ["notices", "notice"], maxChars: 620 },
  { type: "subordination_estoppel", title: "Subordination / Estoppel", keywords: ["subordination", "estoppel"], maxChars: 520 },
  { type: "governing_law", title: "Governing Law", keywords: ["governing law"], maxChars: 320 },
  { type: "jury_waiver", title: "Jury Waiver", keywords: ["jury", "waiver of jury"], maxChars: 320 },
  { type: "successors_assigns", title: "Successors & Assigns", keywords: ["successors", "assigns"], maxChars: 420 },
];

const FIELD_SPECS = [
  { key: "lease_date", group: "lease_header", aliases: ["lease_date"], patterns: [/\b(?:dated|lease date)\b[^\n]{0,30}?([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { key: "landlord_name", group: "lease_header", aliases: ["landlord_name", "landlord", "lessor", "owner_landlord", "owner_name"], patterns: [/\bLANDLORD[:\s-]+([A-Z][^\n]{2,160}?)(?=\s+(?:By|TENANT|LESSEE|Address|whose|having)|\s*\n|$)/, /\bLessor[:\s-]+([A-Z][^\n]{2,160})/] },
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
  { key: "lease_term", group: "lease_term", aliases: ["lease_term", "term"], patterns: [/\blease term\b[:\s-]+([^\n]{2,120})/i] },
  { key: "commencement_date", group: "lease_term", aliases: ["commencement_date", "start_date", "lease_commencement_date", "term_commencement_date", "term_start", "beginning_of_term", "commencement"], patterns: [/\b(?:commencement date|lease commencement|term commencement|commences? on)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { key: "expiration_date", group: "lease_term", aliases: ["expiration_date", "end_date", "lease_expiration_date", "termination_date", "term_end", "end_of_term", "expiry_date"], patterns: [/\b(?:expiration date|lease expiration|termination date|term end|ends? on|expires? on)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { key: "renewal_notice_days", group: "lease_term", aliases: ["renewal_notice_days", "renewal_notice_months"], patterns: [/\bnotice\b[^\n]{0,60}?(\d{1,3})\s+days?/i] },
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
  { key: "tax_responsibility", group: "expense_terms", aliases: ["tax_responsibility"], patterns: [/\b(?:tax(?:es)?|real estate taxes|property taxes)\b[^.\n]{0,80}\b(landlord|lessor|tenant|lessee)\s+(?:shall|will|must|is\s+(?:required|obligated)\s+to|agrees\s+to)\s+(?:pay|be\s+responsible)/i] },
  { key: "insurance_responsibility", group: "expense_terms", aliases: ["insurance_responsibility"], patterns: [/\b(?:property\s+insurance|liability\s+insurance|insurance)\b[^.\n]{0,80}\b(landlord|lessor|tenant|lessee)\s+(?:shall|will|must|is\s+(?:required|obligated)\s+to|agrees\s+to)\s+(?:provide|maintain|carry|obtain|procure|keep\s+in\s+force)/i] },
  { key: "maintenance_responsibility", group: "expense_terms", aliases: ["maintenance_responsibility"], patterns: [/\b(?:maintenance|repairs?)\b[^.\n]{0,80}\b(landlord|lessor|tenant|lessee)\s+(?:shall|will|must|is\s+(?:required|obligated)\s+to|agrees\s+to)\s+(?:perform|maintain|repair|be\s+responsible)/i] },
  { key: "permitted_development", group: "premises", aliases: ["permitted_development"], patterns: [/\bpermitted development\b[:\s-]+([^\n.]{4,220})/i] },
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
  return Number.isFinite(numeric) ? numeric : null;
}

function isGenericSourceText(value: unknown) {
  const text = cleanText(value);
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(text)) return true;
  if (lower.includes("derived from")) return true;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(text)) return true;
  if (/^[a-z][a-z0-9_]{2,60}$/.test(text)) return true;
  return false;
}

function cleanSourceText(value: unknown) {
  const text = cleanText(value);
  return isGenericSourceText(text) ? null : text;
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

function extractClauseSnippet(textBlocks: any[], fullText: string, keywords: string[] = [], maxChars = 520) {
  const loweredKeywords = keywords.map((keyword) => keyword.toLowerCase());
  for (let index = 0; index < textBlocks.length; index += 1) {
    const blockText = cleanText(textBlocks[index]?.text || "");
    const haystack = blockText.toLowerCase();
    if (!blockText) continue;
    if (!loweredKeywords.some((keyword) => haystack.includes(keyword))) continue;

    const snippet = [blockText, cleanText(textBlocks[index + 1]?.text || ""), cleanText(textBlocks[index + 2]?.text || "")]
      .filter(Boolean)
      .join(" ")
      .slice(0, maxChars);
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
  return { clause_text: sentence.slice(0, maxChars), source_page: null };
}

function findEvidenceForValue(doclingRaw: any, fieldKey: string, value: unknown, clauseHint: string | null = null) {
  const textBlocks = asArray(doclingRaw?.text_blocks);
  const docFields = asArray(doclingRaw?.fields);
  const comparableValue = cleanText(value);

  if (clauseHint) {
    const clauseSearch = extractClauseSnippet(textBlocks, cleanText(doclingRaw?.full_text || ""), [clauseHint], 420);
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
    const directText = cleanText(directField?.text || directField?.value || "");
    const safeDirectText = cleanSourceText(directText);
    if (safeDirectText) {
      return {
        source_page: sourcePageOf(directField),
        source_clause: safeDirectText.slice(0, 260),
      };
    }
  }

  const directBlock = textBlocks.find((block) => comparableValue && cleanText(block?.text || "").includes(comparableValue));
  if (directBlock) {
    return {
      source_page: sourcePageOf(directBlock),
      source_clause: cleanText(directBlock?.text || "").slice(0, 260) || null,
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

function excerptForKeywords(textBlocks: any[], fullText: string, keywords: string[]) {
  // Returns the actual document snippet containing one of the keywords, or
  // null if no real text matched. Previously fell back to `keywords[0]`
  // (e.g. "real estate tax"), which leaked the canonical category KEY into
  // the rule's source_text — the UI then displayed that as if it were
  // verbatim source evidence. Now we return null so downstream code can
  // mark the rule as missing source evidence instead of faking it.
  const snippet = extractClauseSnippet(textBlocks, fullText, keywords, 420);
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
    const snippet = extractClauseSnippet(textBlocks, fullText, definition.keywords, definition.maxChars);
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
  { item_type: "assignee_current_tenant", business_area: "assignment_amendment", field_key: "tenant_name", maps: true, patterns: [/\b(?:assignee|new tenant|transferee)\b[:\s-]+([^\n]{2,160})/i] },
  { item_type: "assignee_name", business_area: "assignment_amendment", field_key: "assignee_name", maps: true, patterns: [/\b(?:assignee|new tenant|transferee)\b[:\s-]+([^\n]{2,160})/i] },
  { item_type: "assignment_effective_date", business_area: "assignment_amendment", field_key: "assignment_effective_date", maps: true, patterns: [/\b(?:assignment effective date|assignment date|effective date)\b[:\s-]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { item_type: "assignment_consideration", business_area: "assignment_amendment", field_key: "assignment_consideration", maps: false, patterns: [/\b(?:assignment\s+consideration|consideration)\b[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { item_type: "assumption_of_obligations", business_area: "assignment_amendment", field_key: "assumption_scope", maps: true, booleanValue: "yes", patterns: [/\b(assignee[^.\n]{0,220}\b(?:assumes?|agrees\s+to\s+perform|shall\s+perform)[^.\n]{0,220}(?:obligations|liabilities|lease))/i] },
  { item_type: "landlord_consent", business_area: "assignment_amendment", field_key: "landlord_consent", maps: true, booleanValue: "yes", patterns: [/\b(landlord[^.\n]{0,120}(?:consents?|approves?)[^.\n]{0,120}(?:assignment|transfer)|consent\s+to\s+assignment[^.\n]{0,160}(?:granted|approved|given))/i] },
  { item_type: "amended_expiration_date", business_area: "dates_term", field_key: "expiration_date", maps: true, patterns: [/\binitial\s+Term\s+shall\s+now\s+expire\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i, /\b(?:amended\s+expiration\s+date|expiration\s+date\s+is\s+amended\s+to|term\s+is\s+extended\s+to|extended\s+through|expiring|expires?\s+on)\b[:\s-]*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i] },
  { item_type: "amended_base_rent_for_additional_year", business_area: "rent_charges", field_key: "annual_rent", maps: true, patterns: [/\b(?:base\s+rent\s+for\s+(?:the\s+)?additional\s+year|additional\s+year\s+base\s+rent|amended\s+base\s+rent|extended\s+term\s+rent)\b[^\n$]{0,100}\$?\s*([\d,]+(?:\.\d{2})?)/i] },
  { item_type: "assignee_notice_address", business_area: "assignment_amendment", field_key: "assignee_notice_address", maps: true, patterns: [/\b(?:assignee(?:'s)?\s+notice\s+address|address\s+for\s+notices\s+to\s+assignee|assignee\s+address)\b[:\s-]+([^\n]{8,220})/i] },
  { item_type: "all_other_terms_remain_same", business_area: "assignment_amendment", field_key: "all_other_terms_remain_same", maps: false, booleanValue: "yes", patterns: [/\b(all\s+other\s+terms[^.\n]{0,160}(?:remain|shall\s+remain|continue)[^.\n]{0,120}(?:unchanged|same|full\s+force\s+and\s+effect))/i] },
];

function detectDocumentProfile(fullText: string, documentSubtype?: string | null) {
  const text = normalizeToken(`${documentSubtype || ""} ${fullText}`);
  const isAssignment = /assignment|assignor|assignee|consent to assignment|assumption of lease/.test(text);
  const isAmendment = /amendment|amended|extension|extended|modified|all other terms/.test(text);
  if (isAssignment && isAmendment) return "assignment_amendment";
  if (isAssignment) return "assignment";
  if (isAmendment) return "amendment";
  if (/abstract|summary/.test(text)) return "abstract";
  if (/addendum/.test(text)) return "addendum";
  if (/exhibit/.test(text)) return "exhibit";
  return "full_lease";
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
      business_area: BUSINESS_AREA_BY_CLAUSE_TYPE[clauseType] || "clause_records",
      value: clause.clause_title,
      normalized_value: clause.clause_title,
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

    if (spec.key === "commencement_date" && isBlank(value)) {
      value = getFirstValue(row, ["start_date"]);
    }

    if (spec.key === "expiration_date" && isBlank(value)) {
      value = getFirstValue(row, ["end_date"]);
    }

    if (spec.key === "security_deposit_amount" && isBlank(value)) {
      value = getFirstValue(row, ["security_deposit"]);
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

    fieldMap[spec.key] = {
      key: spec.key,
      value: normalizeWorkflowFieldValue(spec.key, value),
      source_page: relatedClause?.source_page ?? llmEvidence?.source_page ?? textMatchEvidence.source_page,
      source_clause: relatedClause?.clause_text ?? llmEvidence?.source_text ?? textMatchEvidence.source_clause,
      confidence_score: extractionStatus === "not_found" || extractionStatus === "manual_required" ? null : round2(confidenceScore),
      extraction_status: extractionStatus,
      editable: true,
      field_group: spec.group,
    };
  }

  const signals = inferLeaseSignals(fullText, row);
  const classifiedLeaseType = classifyLeaseType(fullText, [], signals);
  const leaseTypeEvidence = findEvidenceForValue(doclingRaw, "lease_type", classifiedLeaseType, classifiedLeaseType);
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
    value: classifiedLeaseType,
    source_page: leaseTypeEvidence.source_page,
    source_clause: leaseTypeEvidence.source_clause || classifiedLeaseType,
    confidence_score: classifiedLeaseType && classifiedLeaseType !== "Unknown / Manual Review" ? 0.86 : 0.5,
    extraction_status: classifiedLeaseType === "Unknown / Manual Review" ? "manual_required" : "calculated",
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

  if (classifiedLeaseType && /full service/i.test(classifiedLeaseType)) {
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
  const fallback = extractClauseSnippet(textBlocks, fullText, keywords, 420);
  return {
    clause_text: fallback.clause_text,
    source_page: fallback.source_page,
    clause_type: "supporting_text",
  };
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
  const isFullService = /full service|gross lease/.test(leaseType.toLowerCase());
  const isGross = /gross lease|industrial gross/.test(leaseType.toLowerCase());
  const isModifiedGross = /modified gross|hybrid/.test(leaseType.toLowerCase());
  const isTripleNet = /triple net|nnn|absolute net/.test(leaseType.toLowerCase());
  const isDoubleNet = /double net|nn lease/.test(leaseType.toLowerCase());
  const isSingleNet = /single net| n /.test(` ${leaseType.toLowerCase()} `);
  const isBaseYear = /base year/.test(leaseType.toLowerCase());
  const isExpenseStop = /expense stop/.test(leaseType.toLowerCase());
  const isFixedCam = /fixed cam/.test(leaseType.toLowerCase());
  const isPercentageRent = /percentage rent/.test(leaseType.toLowerCase());
  const isGroundLease = /ground lease/.test(leaseType.toLowerCase());
  const fullText = cleanText(doclingRaw?.full_text || clauses.map((clause) => clause.clause_text || "").join(" "));
  const textBlocks = asArray(doclingRaw?.text_blocks);
  const explicitBaseYear = asNumber(fieldMap.base_year_expense_amount?.value) ?? asNumber(fieldMap.base_year?.value);
  const explicitExpenseStop = asNumber(fieldMap.expense_stop_amount?.value);
  const explicitAdminFee = asNumber(row?.admin_fee_pct);
  const explicitGrossUp = asNumber(row?.gross_up_percent ?? row?.cam_cap_rate);

  return finalizeDerivedExpenseRules(EXPENSE_RULE_BLUEPRINTS.map((blueprint) => {
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
    let capPercent = null;
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
  }));
}

function deriveCamProfile(fieldMap: Record<string, LeaseWorkflowField>, expenseRules: any[]) {
  const leaseType = cleanText(fieldMap.lease_type?.value || "");
  const normalizedLeaseType = leaseType.toLowerCase();
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
  const isFullService = /full service|gross/.test(leaseType.toLowerCase());

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
  const documentProfile = detectDocumentProfile(fullText, args?.documentSubtype || null);
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
  if (finalLeaseType && finalLeaseType !== leaseFields.lease_type?.value) {
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
      value: finalLeaseType,
      extraction_status: finalLeaseType === "Unknown / Manual Review" ? "manual_required" : "calculated",
      confidence_score: finalLeaseType === "Unknown / Manual Review" ? 0.5 : 0.86,
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
  const camProfile = deriveCamProfile(leaseFields, expenseRules);
  const budgetPreview = deriveBudgetPreview(leaseFields, expenseRules, camProfile);
  const validations = buildValidationResults(leaseFields, expenseRules, camProfile, budgetPreview);

  return {
    document_subtype: args?.documentSubtype || null,
    document_profile: documentProfile,
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
      calculated_field_count: Object.values(leaseFields).filter((field) => field.extraction_status === "calculated").length,
      manual_required_count: Object.values(leaseFields).filter((field) => field.extraction_status === "manual_required").length,
      conflict_count: Object.values(leaseFields).filter((field) => field.extraction_status === "conflict_detected").length,
      clause_count: clauses.filter((clause) => clause.clause_text).length,
      extracted_document_item_count: extractedDocumentItems.length,
      expense_rule_count: expenseRules.length,
      validation_error_count: validations.filter((item) => item.pass === false).length,
      document_profile: documentProfile,
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
      dynamic_items_extracted: extractedDocumentItems.length,
      dynamic_items_displayed: extractedDocumentItems.filter((item) => item.creates_dynamic_row && item.display_tab !== "clause_records").length,
      mapped_items_count: extractedDocumentItems.filter((item) => item.maps_to_fixed_field).length,
      unmapped_items_count: extractedDocumentItems.filter((item) => !item.maps_to_fixed_field).length,
      clause_records_count: extractedDocumentItems.length,
      lease_expense_rules_generated: expenseRules.length,
      coverage_gaps_generated: extractedDocumentItems.filter((item) => item.requires_original_lease || item.extraction_status === "needs_review").length,
      rejected_generic_source_count: genericSourceTextRejected,
    },
  };
}
