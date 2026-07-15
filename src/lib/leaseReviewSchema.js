/**
 * Schema that drives the Lease Review workspace tabs and per-field actions.
 *
 * The review state for each field is persisted into
 * `leases.extraction_data.field_reviews[<field_key>]` as JSON. Only fields
 * whose `key` matches an actual `leases` table column have their normalized
 * value mirrored back to the column (handled by leaseService); all other
 * fields live entirely inside extraction_data so the data model stays
 * additive and non-breaking.
 */

import { resolveLeaseField, getFieldAliases } from "./leaseFieldResolver";
export const REVIEW_STATUSES = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  EDITED: "edited",
  REJECTED: "rejected",
  N_A: "not_applicable",
  NEEDS_LEGAL: "needs_legal_review",
  MANUAL_REQUIRED: "manual_required",
};

export const REVIEW_STATUS_LABELS = {
  [REVIEW_STATUSES.PENDING]: "Pending",
  [REVIEW_STATUSES.ACCEPTED]: "Accepted",
  [REVIEW_STATUSES.EDITED]: "Edited",
  [REVIEW_STATUSES.REJECTED]: "Rejected",
  [REVIEW_STATUSES.N_A]: "N/A",
  [REVIEW_STATUSES.NEEDS_LEGAL]: "Needs Legal",
  [REVIEW_STATUSES.MANUAL_REQUIRED]: "Manual Required",
};

export const REVIEW_STATUS_STYLES = {
  [REVIEW_STATUSES.PENDING]: "bg-slate-100 text-slate-700",
  [REVIEW_STATUSES.ACCEPTED]: "bg-emerald-100 text-emerald-700",
  [REVIEW_STATUSES.EDITED]: "bg-blue-100 text-blue-700",
  [REVIEW_STATUSES.REJECTED]: "bg-red-100 text-red-700",
  [REVIEW_STATUSES.N_A]: "bg-slate-200 text-slate-600",
  [REVIEW_STATUSES.NEEDS_LEGAL]: "bg-purple-100 text-purple-700",
  [REVIEW_STATUSES.MANUAL_REQUIRED]: "bg-amber-100 text-amber-800",
};

// A review status counts as "resolved" if the user took a decisive action
// on it. Only resolved required fields can satisfy the approval gate.
export const RESOLVED_REVIEW_STATUSES = new Set([
  REVIEW_STATUSES.ACCEPTED,
  REVIEW_STATUSES.EDITED,
  REVIEW_STATUSES.N_A,
  REVIEW_STATUSES.MANUAL_REQUIRED,
]);

export const LEASE_REVIEW_TABS = [
  { key: "summary", label: "Summary" },
  { key: "parties_premises", label: "Parties & Premises" },
  { key: "dates_term", label: "Dates & Term" },
  { key: "rent_charges", label: "Rent & Charges" },
  { key: "expenses_recoveries", label: "Expenses / Recoveries" },
  { key: "cam_rules", label: "CAM Rules" },
  { key: "taxes", label: "Taxes" },
  { key: "insurance", label: "Insurance" },
  { key: "utilities", label: "Utilities" },
  { key: "repairs_maintenance", label: "Repairs & Maintenance" },
  { key: "legal_options", label: "Legal / Options" },
  { key: "critical_dates", label: "Critical Dates" },
  { key: "notices", label: "Notices" },
  { key: "signatures", label: "Signatures" },
  { key: "documents_exhibits", label: "Documents / Exhibits" },
  { key: "clause_records", label: "Clause Records" },
  { key: "budget_preview", label: "Budget Preview" },
  { key: "extraction_debug", label: "Extraction Debug" },
];

// Field metadata.
//   - `required: true` blocks approval until the row reaches a resolved status.
//   - `allowNA: false` hides Mark N/A for fields that semantically must exist.
//   - `type` drives the edit dialog input shape and value normalization.
//   - `options` references a key in lib/leaseFieldOptions.js.
export const LEASE_REVIEW_FIELDS = [
  // Parties & Premises
  { key: "tenant_name",        label: "Tenant Name",                  tab: "parties_premises", required: true,  allowNA: false, type: "text" },
  { key: "tenant_signatory_name", label: "Tenant Signatory",          tab: "parties_premises", type: "text" },
  { key: "landlord_name",      label: "Landlord Name",                tab: "parties_premises", required: true,  allowNA: false, type: "text" },
  { key: "landlord_signatory_name", label: "Landlord Signatory",      tab: "parties_premises", type: "text" },
  { key: "property_name",      label: "Property Name",                tab: "parties_premises", type: "text" },
  { key: "premises_address",   label: "Premises Address",             tab: "parties_premises", required: true,  allowNA: false, type: "text" },
  { key: "suite_number",       label: "Suite Number",                 tab: "parties_premises", type: "text" },
  { key: "floor",              label: "Floor",                        tab: "parties_premises", type: "text" },
  { key: "square_footage",     label: "Square Footage (RSF)",         tab: "parties_premises", required: true,  allowNA: false, type: "number" },
  { key: "building_rsf",       label: "Building RSF",                 tab: "parties_premises", type: "number" },
  { key: "premises_use",       label: "Permitted Use",                tab: "parties_premises", required: true,  allowNA: false, type: "text" },
  { key: "broker_name",        label: "Broker Name",                  tab: "parties_premises", type: "text" },
  { key: "parking_rights",     label: "Parking Rights",               tab: "parties_premises", type: "text" },
  { key: "common_area_description", label: "Common Area Description", tab: "parties_premises", type: "text" },

  // Dates & Term â€” Lease Date (signing), Commencement Date (term start),
  // and Expiration Date are explicitly distinct. Commencement/expiration are
  // stored on both the legacy start_date/end_date columns AND the dedicated
  // commencement_date/expiration_date columns so downstream queries that read
  // either pair keep working.
  { key: "lease_date",                 label: "Lease Date (signed)",                 tab: "dates_term", required: true,  allowNA: false, type: "date" },
  { key: "lease_term",                 label: "Lease Term",                          tab: "dates_term", required: true,  allowNA: false, type: "text", allowCalculatedAccept: true },
  { key: "commencement_date",          label: "Commencement Date",                   tab: "dates_term", required: true,  allowNA: false, type: "date" },
  { key: "rent_commencement_date",     label: "Rent Commencement Date",              tab: "dates_term", type: "date" },
  { key: "expiration_date",            label: "Expiration Date",                     tab: "dates_term", required: true,  allowNA: false, type: "date" },
  { key: "renewal_notice_months",      label: "Renewal Notice (months)",             tab: "dates_term", type: "number", allowCalculatedAccept: true },
  { key: "termination_notice_months",  label: "Termination Notice (months)",         tab: "dates_term", type: "number", allowCalculatedAccept: true },
  { key: "option_exercise_deadline",   label: "Option Exercise Deadline",            tab: "dates_term", type: "date" },

  // Rent & Charges
  { key: "monthly_rent",        label: "Monthly Rent",            tab: "rent_charges", required: true, allowNA: false, type: "currency" },
  { key: "annual_rent",         label: "Annual Rent",             tab: "rent_charges", type: "currency", allowCalculatedAccept: true },
  { key: "rent_per_sf",         label: "Base Rent ($/SF/yr)",     tab: "rent_charges", type: "number", allowCalculatedAccept: true },
  { key: "billing_frequency",   label: "Billing Frequency",       tab: "rent_charges", type: "select", options: "billing_frequency" },
  { key: "escalation_type",     label: "Escalation Type",         tab: "rent_charges", type: "select", options: "escalation_type" },
  { key: "escalation_rate",     label: "Escalation Rate (%)",     tab: "rent_charges", type: "number" },
  { key: "escalation_timing",   label: "Escalation Timing",       tab: "rent_charges", type: "select", options: "escalation_timing" },
  { key: "free_rent_months",    label: "Free Rent (months)",      tab: "rent_charges", type: "number" },
  { key: "ti_allowance",        label: "TI Allowance",            tab: "rent_charges", type: "currency" },
  { key: "security_deposit",    label: "Security Deposit",        tab: "rent_charges", required: true, allowNA: false, type: "currency" },
  { key: "late_fee_grace_days", label: "Late Fee Grace Days",     tab: "rent_charges", type: "number" },
  { key: "late_fee_percent",    label: "Late Fee (%)",            tab: "rent_charges", type: "number" },
  { key: "default_interest_rate_formula", label: "Default Interest Rate", tab: "rent_charges", type: "text" },

  // Expenses / Recoveries
  { key: "lease_type",                 label: "Lease Type (Expense Structure)", tab: "expenses_recoveries", required: true, allowNA: false, type: "select", options: "lease_type", allowCalculatedAccept: true },
  { key: "responsibility_taxes",       label: "Taxes Responsibility",            tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "responsibility_insurance",   label: "Insurance Responsibility",        tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "responsibility_utilities",   label: "Utilities Responsibility",        tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "responsibility_repairs",     label: "Repairs & Maintenance",           tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "tenant_pro_rata_share",      label: "Tenant Pro Rata Share (%)",       tab: "expenses_recoveries", type: "number" },
  { key: "base_year",                  label: "Base Year",                       tab: "expenses_recoveries", type: "number", allowCalculatedAccept: true },
  { key: "expense_stop",               label: "Expense Stop ($)",                tab: "expenses_recoveries", type: "currency", allowCalculatedAccept: true },

  // CAM Rules
  { key: "cam_cap_type",          label: "CAM Cap Type",           tab: "cam_rules", type: "select", options: "cam_cap_type" },
  { key: "cam_cap_pct",           label: "CAM Cap (%)",            tab: "cam_rules", type: "number" },
  { key: "admin_fee_pct",         label: "Admin Fee (%)",          tab: "cam_rules", type: "number" },
  { key: "management_fee_basis",  label: "Mgmt Fee Basis",         tab: "cam_rules", type: "select", options: "management_fee_basis" },
  { key: "hvac_responsibility",   label: "HVAC Responsibility",    tab: "cam_rules", type: "select", options: "hvac_responsibility" },
  { key: "gross_up_enabled",      label: "Gross-Up Enabled",       tab: "cam_rules", type: "boolean" },
  { key: "gross_up_threshold",    label: "Gross-Up Threshold (%)", tab: "cam_rules", type: "number" },

  // Insurance
  { key: "tenant_insurance_required",         label: "Tenant Insurance Required",          tab: "insurance", type: "boolean" },
  { key: "general_liability_min",             label: "General Liability Min ($)",          tab: "insurance", type: "currency" },
  { key: "property_insurance_responsibility", label: "Property Insurance Responsibility",  tab: "insurance", type: "select", options: "hvac_responsibility" },
  { key: "waiver_of_subrogation",             label: "Waiver of Subrogation",              tab: "insurance", type: "boolean" },
  { key: "additional_insureds_required",      label: "Additional Insureds Required",       tab: "insurance", type: "boolean" },

  // Legal / Options
  { key: "renewal_type",            label: "Renewal Type",             tab: "legal_options", type: "select", options: "renewal_type" },
  { key: "renewal_options",         label: "Renewal Options",          tab: "legal_options", type: "select", options: "renewal_options" },
  { key: "renewal_option",          label: "Renewal Option",           tab: "legal_options", type: "boolean" },
  { key: "right_of_first_refusal",  label: "Right of First Refusal",   tab: "legal_options", type: "boolean" },
  { key: "early_termination_option", label: "Early Termination Option", tab: "legal_options", type: "boolean" },
  { key: "termination_option",      label: "Termination Option",       tab: "legal_options", type: "boolean" },
  { key: "assignment_provisions",   label: "Assignment Provisions",    tab: "legal_options", type: "text" },
  { key: "assignment_rights",       label: "Assignment Rights",        tab: "legal_options", type: "text" },
  { key: "sublease_rights",         label: "Sublease Rights",          tab: "legal_options", type: "text" },
  { key: "default_cure_period",     label: "Default Cure Period (days)", tab: "legal_options", type: "number" },
  { key: "holdover_rent_multiplier",label: "Holdover Rent Multiplier", tab: "legal_options", type: "number" },

  // Documents / Exhibits
  { key: "floor_plan_reference",    label: "Floor Plan Reference",    tab: "documents_exhibits", type: "text" },
  { key: "exhibit_reference",       label: "Exhibit Reference",       tab: "documents_exhibits", type: "text" },
  { key: "guaranty_reference",      label: "Guaranty Reference",      tab: "documents_exhibits", type: "text" },
];

export const FIELDS_BY_TAB = LEASE_REVIEW_TABS.reduce((acc, tab) => {
  acc[tab.key] = LEASE_REVIEW_FIELDS.filter((field) => field.tab === tab.key);
  return acc;
}, {});

export const REQUIRED_FIELD_KEYS = LEASE_REVIEW_FIELDS
  .filter((field) => field.required)
  .map((field) => field.key);

// Numeric field keys (used by leaseService.update to coerce strings â†’ numbers).
export const NUMERIC_REVIEW_FIELDS = new Set(
  LEASE_REVIEW_FIELDS
    .filter((field) => field.type === "number" || field.type === "currency")
    .map((field) => field.key),
);

// A small alias map so a single review field key (e.g. commencement_date)
// can read/write the legacy column (start_date) too. Lookups try every alias
// before falling back to extraction_data.
const FIELD_COLUMN_ALIASES = {
  commencement_date: ["commencement_date", "start_date"],
  expiration_date:   ["expiration_date", "end_date"],
  start_date:        ["commencement_date", "start_date"],
  end_date:          ["expiration_date", "end_date"],
  landlord_name:     ["landlord_name", "lessor_name", "owner_name", "landlord", "lessor", "owner"],
  property_name:     ["property_name", "premises.property_name", "building_name"],
  suite_number:      ["suite_number", "unit_number", "suite", "premises.suite"],
  floor:             ["floor", "premises.floor"],
  lease_date:        ["lease_execution_date", "lease_date", "dates.lease_execution_date"],
  lease_term:        ["lease_term", "initial_term", "term", "term_months", "lease_term_months"],
  initial_term:      ["initial_term", "term_months", "lease_term_months"],
  tenant_pro_rata_share: ["tenant_share", "pro_rata_share", "tenant_pro_rata_share"],
  general_liability_min: ["commercial_general_liability_per_occurrence", "general_liability_min"],
  general_aggregate: ["commercial_general_liability_aggregate", "general_aggregate"],
  estimated_annual_cam: ["estimated_annual_cam", "cam_estimate_annual"],
  estimated_monthly_cam: ["estimated_monthly_cam", "cam_estimate_monthly"],
  admin_fee_percent: ["admin_fee_percent"],
  gross_up_percent:  ["gross_up_percent"],
  cam_cap_percent:   ["cam_cap_percent"],
  square_footage:    ["square_footage", "total_sf", "rentable_area_sqft", "tenant_rsf"],
  total_sf:          ["total_sf", "square_footage", "rentable_area_sqft"],
  premises_address:  ["premises_address", "property_address", "premises_location"],
  premises_use:      ["premises_use", "permitted_use"],
  // Write only stable lease-table columns here. Read aliases such as
  // base_rent_monthly/base_rent_annual still live in leaseFieldResolver and
  // extraction_data; sending them as PATCH columns causes 400s on deployed
  // schemas that have not run those additive migrations.
  monthly_rent:      ["monthly_rent"],
  annual_rent:       ["annual_rent"],
  rent_per_sf:       ["rent_per_sf", "tenant_rent_per_rsf"],
  billing_frequency: ["billing_frequency", "rent_frequency"],
  escalation_type:   ["escalation_type", "rent_escalation_type"],
  escalation_rate:   ["escalation_rate", "renewal_escalation_percent"],
  escalation_timing: ["escalation_timing", "rent_escalation_timing"],
  free_rent_months:  ["free_rent_months", "rent_abatement_months", "abatement_months"],
  ti_allowance:      ["ti_allowance", "tenant_improvement_allowance", "improvement_allowance"],
  security_deposit:  ["security_deposit", "deposit_amount"],
  lease_type:        ["lease_type", "expense_structure", "lease_structure", "cam_structure"],
  expense_stop:      ["expense_stop", "expense_stop_amount"],
  cam_cap_pct:       ["cam_cap_pct", "cam_cap_percent", "cam_cap_rate"],
  gross_up_threshold:["gross_up_threshold", "gross_up_percent", "gross_up_target_occupancy_pct"],
  base_year:         ["base_year", "base_year_amount"],
  renewal_notice_months: ["renewal_notice_months", "renewal_notice_days"],
  option_exercise_deadline: ["option_exercise_deadline", "renewal_exercise_deadline"],
  responsibility_taxes: ["responsibility_taxes", "tax_responsibility"],
  responsibility_insurance: ["responsibility_insurance", "insurance_responsibility"],
  responsibility_repairs: ["responsibility_repairs", "maintenance_responsibility"],
  responsibility_utilities: ["responsibility_utilities", "utilities_responsibility"],
  property_insurance_responsibility: ["property_insurance_responsibility", "insurance_responsibility"],
  tenant_insurance_required: ["tenant_insurance_required", "tenant_insurance", "tenant_property_insurance_required", "commercial_general_liability_required", "insurance_required"],
  waiver_of_subrogation: ["waiver_of_subrogation", "waiver_subrogation_required"],
  additional_insureds_required: ["additional_insureds_required", "additional_insured_required", "additional_insured"],
  renewal_type: ["renewal_type", "renewal_option_type"],
  renewal_options: ["renewal_options", "renewal_option_count"],
  right_of_first_refusal: ["right_of_first_refusal", "rofr"],
  early_termination_option: ["early_termination_option", "termination_option"],
  assignment_provisions: ["assignment_provisions", "assignment_clause", "assignment_rights"],
  default_cure_period: ["default_cure_period", "late_fee_grace_days"],
};

const FIELD_CLAUSE_FALLBACKS = {
  premises_use: { clauseTypes: ["use_clause"], keywordPatterns: [/permitted use/i, /use of premises/i], useClauseTextAsValue: true },
  assignment_provisions: { clauseTypes: ["assignment_subletting"], keywordPatterns: [/assignment/i, /subletting/i, /sublease/i], useClauseTextAsValue: true },
  default_cure_period: { clauseTypes: ["default"], keywordPatterns: [/\b(\d{1,3})\s+days?\b/i], valueParser: "days" },
  waiver_of_subrogation: { clauseTypes: ["insurance"], keywordPatterns: [/waiver of subrogation/i], valueParser: "boolean" },
  additional_insureds_required: { clauseTypes: ["insurance"], keywordPatterns: [/additional insured/i], valueParser: "boolean" },
  early_termination_option: { clauseTypes: ["remedies", "surrender"], keywordPatterns: [/early termination/i, /\bterminate\b/i], valueParser: "boolean" },
  right_of_first_refusal: { clauseTypes: ["assignment_subletting"], keywordPatterns: [/right of first refusal/i, /\brofr\b/i], valueParser: "boolean" },
  renewal_options: { clauseTypes: ["notices"], keywordPatterns: [/\brenew(?:al)? option/i] },
  tenant_insurance_required: {
    clauseTypes: ["insurance"],
    keywordPatterns: [/tenant insurance/i, /liability insurance/i, /general liability/i, /certificate of insurance/i],
    structuredKeys: ["tenant_property_insurance_required", "commercial_general_liability_required", "certificate_required"],
    valueParser: "boolean",
  },
  general_liability_min: {
    clauseTypes: ["insurance"],
    keywordPatterns: [/\$?[\d,]+(?:\.\d{2})?\s*(?:each occurrence|per occurrence|aggregate)/i],
    structuredKeys: ["commercial_general_liability_per_occurrence", "liability_limit_each_occurrence"],
    valueParser: "currency",
  },
  general_aggregate: {
    clauseTypes: ["insurance"],
    keywordPatterns: [/\$?[\d,]+(?:\.\d{2})?\s*(?:aggregate)/i],
    structuredKeys: ["commercial_general_liability_aggregate", "liability_limit_aggregate"],
    valueParser: "currency",
  },
};

function isPresent(v) {
  return v !== undefined && v !== null && v !== "";
}

function normalizeLookupKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseStoredNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned.replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function collectEntryVariants(entry) {
  if (!entry || typeof entry !== "object") return [];

  const variants = [entry];
  const nestedKeys = ["evidence", "match", "metadata", "source"];
  const arrayKeys = ["evidence", "citations", "sources", "clauses", "supporting_clauses", "matches"];

  for (const key of nestedKeys) {
    const nested = entry[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      variants.push(nested);
    }
  }

  for (const key of arrayKeys) {
    const items = entry[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === "object") variants.push(item);
    }
  }

  return [...new Set(variants)];
}

function readFromEntry(entry, ...keys) {
  for (const variant of collectEntryVariants(entry)) {
    for (const key of keys) {
      if (variant[key] !== undefined && variant[key] !== null && variant[key] !== "") {
        return variant[key];
      }
    }
  }
  return undefined;
}

function unwrapFieldValue(entry) {
  if (!isPresent(entry)) return null;
  if (typeof entry !== "object") return entry;
  return (
    readFromEntry(entry, "value", "normalized_value", "extracted_value", "raw_value", "raw")
    ?? null
  );
}

function pickCandidateEntry(map, candidates) {
  if (!map) return null;

  if (Array.isArray(map)) {
    const normalizedCandidates = new Set(candidates.map(normalizeLookupKey));
    for (const item of map) {
      if (!item || typeof item !== "object") continue;
      const itemKey = item.field_key ?? item.key ?? item.name ?? null;
      if (itemKey && normalizedCandidates.has(normalizeLookupKey(itemKey))) return item;
    }
    return null;
  }

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(map, candidate) && isPresent(map[candidate])) {
      return map[candidate];
    }
  }

  const normalizedCandidates = new Set(candidates.map(normalizeLookupKey));
  for (const [mapKey, value] of Object.entries(map)) {
    if (normalizedCandidates.has(normalizeLookupKey(mapKey)) && isPresent(value)) {
      return value;
    }
  }

  for (const value of Object.values(map)) {
    if (!value || typeof value !== "object") continue;
    const itemKey = value.field_key ?? value.key ?? value.name ?? null;
    if (itemKey && normalizedCandidates.has(normalizeLookupKey(itemKey))) return value;
  }

  return null;
}

function getLeaseWorkflowOutput(lease) {
  const workflowOutput = lease?.extraction_data?.workflow_output ?? lease?.abstract_snapshot?.workflow_output ?? null;
  if (!workflowOutput) return null;
  if (workflowOutput.lease_fields || workflowOutput.expense_rules || workflowOutput.cam_profile) return workflowOutput;
  if (Array.isArray(workflowOutput.records)) {
    return workflowOutput.records[0] ?? null;
  }
  return workflowOutput;
}

function getWorkflowLeaseFields(lease) {
  return getLeaseWorkflowOutput(lease)?.lease_fields || {};
}

function getWorkflowExpenseRules(lease) {
  const rules = getLeaseWorkflowOutput(lease)?.expense_rules;
  return Array.isArray(rules) ? rules : [];
}

function getWorkflowCamProfile(lease) {
  return getLeaseWorkflowOutput(lease)?.cam_profile || null;
}

function getWorkflowLeaseClauses(lease) {
  const workflowOutput = getLeaseWorkflowOutput(lease);
  const workflowClauses = workflowOutput?.lease_clauses;
  if (Array.isArray(workflowClauses) && workflowClauses.length > 0) return workflowClauses;

  const extractionClauses = lease?.extraction_data?.lease_clauses;
  if (Array.isArray(extractionClauses) && extractionClauses.length > 0) return extractionClauses;

  const snapshotClauses = lease?.abstract_snapshot?.workflow_output?.lease_clauses;
  if (Array.isArray(snapshotClauses) && snapshotClauses.length > 0) return snapshotClauses;

  return [];
}

function parseClauseValueFromConfig(clause, config) {
  if (!clause || !config) return null;

  const structured = clause.structured_fields_json && typeof clause.structured_fields_json === "object"
    ? clause.structured_fields_json
    : {};

  if (Array.isArray(config.structuredKeys)) {
    for (const key of config.structuredKeys) {
      if (isPresent(structured[key])) return structured[key];
    }
  }

  const clauseText = String(clause.clause_text || "");
  if (!clauseText) return null;

  if (config.valueParser === "boolean") {
    return true;
  }

  if (config.valueParser === "days") {
    const match = config.keywordPatterns?.map((pattern) => clauseText.match(pattern)).find((result) => result?.[1]);
    if (match?.[1]) return parseStoredNumber(match[1]);
    return null;
  }

  if (config.valueParser === "currency") {
    // Some text may be "Commercial General Liability: $1,000,000 per occurrence"
    // We want to extract the first monetary amount
    const match = clauseText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    if (match?.[1]) {
      return parseStoredNumber(match[1]);
    }
    const direct = parseStoredNumber(clauseText);
    if (direct != null) return direct;
    return null;
  }

  if (config.useClauseTextAsValue) {
    return clauseText;
  }

  return null;
}

function findClauseFallbackEntry(lease, key) {
  const config = FIELD_CLAUSE_FALLBACKS[key];
  if (!config) return null;

  const clauses = getWorkflowLeaseClauses(lease);
  if (!clauses.length) return null;

  const matchingClause = clauses.find((clause) => {
    if (!clause?.clause_text) return false;
    if (config.clauseTypes?.length && !config.clauseTypes.includes(clause.clause_type)) return false;

    if (Array.isArray(config.structuredKeys)) {
      const structured = clause.structured_fields_json && typeof clause.structured_fields_json === "object"
        ? clause.structured_fields_json
        : {};
      if (config.structuredKeys.some((structuredKey) => isPresent(structured[structuredKey]))) {
        return true;
      }
    }

    if (Array.isArray(config.keywordPatterns)) {
      return config.keywordPatterns.some((pattern) => pattern.test(String(clause.clause_text || "")));
    }

    return true;
  }) || null;

  if (!matchingClause) return null;

  return {
    value: parseClauseValueFromConfig(matchingClause, config),
    raw_value: matchingClause.clause_text ?? null,
    source_page: matchingClause.source_page ?? null,
    source_text: matchingClause.clause_text ?? null,
    source_clause: matchingClause.clause_text ?? null,
    confidence_score: matchingClause.confidence_score ?? null,
    extraction_status: null,
    clause_type: matchingClause.clause_type ?? null,
  };
}

function firstMatchingExpenseRule(lease, categories = [], predicate = () => true) {
  const rules = getWorkflowExpenseRules(lease);
  return rules.find((rule) =>
    categories.includes(rule?.expense_category) &&
    predicate(rule),
  ) || null;
}

function buildDerivedWorkflowEntry(lease, key) {
  const camProfile = getWorkflowCamProfile(lease);

  const fromRule = (rule, value, extractionStatus = null) =>
    rule
      ? {
          value,
          raw_value: value,
          source_page: rule.source_page ?? null,
          source_clause: rule.source_clause ?? rule.notes ?? null,
          confidence_score: rule.confidence_score ?? null,
          extraction_status: extractionStatus ?? rule.status ?? null,
        }
      : null;

  switch (key) {
    case "responsibility_taxes": {
      const rule = firstMatchingExpenseRule(lease, ["real_estate_taxes"], (entry) => isPresent(entry?.responsibility));
      return fromRule(rule, rule?.responsibility ?? null);
    }
    case "responsibility_insurance":
    case "property_insurance_responsibility": {
      const rule = firstMatchingExpenseRule(lease, ["property_insurance"], (entry) => isPresent(entry?.responsibility));
      return fromRule(rule, rule?.responsibility ?? null);
    }
    case "responsibility_utilities": {
      const rule = firstMatchingExpenseRule(
        lease,
        ["utilities", "electricity", "water", "sewer", "gas", "hvac", "separately_metered_charges", "excess_usage", "excess_utilities"],
        (entry) => isPresent(entry?.responsibility),
      );
      return fromRule(rule, rule?.responsibility ?? null);
    }
    case "responsibility_repairs": {
      const rule = firstMatchingExpenseRule(
        lease,
        ["interior_repairs", "exterior_repairs", "roof_structure", "foundation_structure", "capital_expenditures", "hvac"],
        (entry) => isPresent(entry?.responsibility),
      );
      return fromRule(rule, rule?.responsibility ?? null);
    }
    case "base_year": {
      const rule = firstMatchingExpenseRule(lease, ["cam", "common_area_maintenance", "operating_expenses", "real_estate_taxes", "property_insurance"], (entry) => isPresent(entry?.base_year));
      return fromRule(rule, rule?.base_year ?? null, rule?.base_year != null ? "calculated" : null);
    }
    case "expense_stop": {
      const rule = firstMatchingExpenseRule(lease, ["cam", "common_area_maintenance", "operating_expenses", "real_estate_taxes", "property_insurance"], (entry) => isPresent(entry?.expense_stop_amount));
      return fromRule(rule, rule?.expense_stop_amount ?? null, rule?.expense_stop_amount != null ? "calculated" : null);
    }
    case "cam_cap_type": {
      const rule = firstMatchingExpenseRule(lease, ["cam", "common_area_maintenance", "operating_expenses", "real_estate_taxes", "property_insurance", "management_fees", "administrative_fees"], (entry) => isPresent(entry?.cap_type));
      const value = camProfile?.cam_cap_type ?? rule?.cap_type ?? null;
      return fromRule(rule, value, value != null ? "calculated" : null);
    }
    case "cam_cap_pct": {
      const rule = firstMatchingExpenseRule(lease, ["cam", "common_area_maintenance", "operating_expenses", "real_estate_taxes", "property_insurance", "management_fees", "administrative_fees"], (entry) => isPresent(entry?.cap_percent));
      const value = camProfile?.cam_cap_percent ?? rule?.cap_percent ?? null;
      return fromRule(rule, value, value != null ? "calculated" : null);
    }
    case "admin_fee_pct": {
      const rule = firstMatchingExpenseRule(lease, ["cam", "common_area_maintenance", "operating_expenses", "management_fees", "administrative_fees"], (entry) => isPresent(entry?.admin_fee_percent));
      const value = camProfile?.admin_fee_percent ?? rule?.admin_fee_percent ?? null;
      return fromRule(rule, value, value != null ? "calculated" : null);
    }
    case "gross_up_enabled": {
      const rule = firstMatchingExpenseRule(lease, ["cam", "common_area_maintenance", "operating_expenses", "management_fees", "administrative_fees"], (entry) => isPresent(entry?.gross_up_percent));
      const rawValue = camProfile?.gross_up_percent ?? rule?.gross_up_percent ?? null;
      const value = rawValue == null ? null : Number(rawValue) > 0;
      return fromRule(rule, value, rawValue != null ? "calculated" : null);
    }
    case "gross_up_threshold": {
      const rule = firstMatchingExpenseRule(lease, ["cam", "common_area_maintenance", "operating_expenses", "management_fees", "administrative_fees"], (entry) => isPresent(entry?.gross_up_percent));
      const value = camProfile?.gross_up_percent ?? rule?.gross_up_percent ?? null;
      return fromRule(rule, value, value != null ? "calculated" : null);
    }
    default:
      return null;
  }
}

// Strings that the extractor sometimes uses as a literal "I don't know"
// stand-in. These must not be treated as real values â€” they shouldn't fill
// the Normalized column and they shouldn't trigger text-matching evidence.
const SENTINEL_NOT_FOUND_VALUES = new Set([
  "unknown", "n/a", "na", "none", "null", "tbd", "not specified",
  "not applicable", "see lease", "as set forth", "per lease",
  "not found", "not available", "not stated", "not provided",
  "not mentioned", "not included", "not applicable.",
]);

export function isMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !SENTINEL_NOT_FOUND_VALUES.has(trimmed.toLowerCase());
}

// Phase 39: a value that is entirely one bare HTML/XML tag (e.g. "<figure>",
// "</figure>", "<table>") is a layout artifact leaking through from the
// document's raw markup, never a real field value. Narrow on purpose - only
// matches a string that IS a single tag, not text that merely contains one.
const MARKUP_ARTIFACT_VALUE_PATTERN = /^<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>$/i;

export function isMarkupArtifactValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return MARKUP_ARTIFACT_VALUE_PATTERN.test(trimmed);
}

export function readFieldValue(lease, key) {
  if (!lease) return null;
  const resolved = resolveLeaseField(lease, key, { mode: "canonical" });
  return resolved?.value ?? null;
}

const SOURCE_TEXT_MAX_CHARS = 320;

export function cleanSourceEvidenceText(value, { truncate = true } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^(llm extracted|extracted|manual_review|manual review|workflow placeholder|not found|unknown|n\/a|na|null|none|missing)$/i.test(text)) return null;
  if (/(^|\b)(derived from|calculated from|reassigned from|workflow placeholder|fallback|internal)(\b|$)/i.test(text)) return null;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(text)) return null;
  if (/^[a-z][a-z0-9_]{2,60}$/.test(text)) return null;
  if (!truncate || text.length <= SOURCE_TEXT_MAX_CHARS) return text;
  // Trim at the last sentence boundary within the limit so we never cut mid-word.
  const slice = text.slice(0, SOURCE_TEXT_MAX_CHARS);
  const lastPeriod = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"));
  const cutAt = lastPeriod > SOURCE_TEXT_MAX_CHARS * 0.55 ? lastPeriod + 1 : SOURCE_TEXT_MAX_CHARS;
  return slice.slice(0, cutAt).trimEnd() + "â€¦";
}

export function normalizeSourcePage(page) {
  if (page === null || page === undefined || page === "") return null;
  const numeric = Number(page);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Number.isInteger(numeric) ? numeric : null;
}

export function hasNaturalSourceBoundary(value) {
  const text = cleanSourceEvidenceText(value);
  if (!text || text.length < 4) return false;
  if (/^[,.;:)\]}]/.test(text)) return false;
  if (/^[a-z]/.test(text) && !/^(article|section|exhibit|schedule|paragraph|tenant|landlord|premises|rent|insurance|taxes|utilities|cam|common area|option|renewal|default)\b/i.test(text)) {
    return false;
  }
  return true;
}

// Exported for reuse by clause-record content-based dedup
// (leaseReviewFieldNormalizer.js) - same normalization used here to compare
// evidence text against extracted values.
export function normalizeEvidenceComparable(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[$,%]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numericEvidenceTokens(value) {
  const text = String(value ?? "");
  const tokens = new Set();
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = match[0];
    tokens.add(raw.replace(/,/g, ""));
    const asNumber = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(asNumber)) tokens.add(String(asNumber));
  }
  return tokens;
}

function isoDateSupportTokens(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  return {
    year,
    day: String(Number(day)),
    monthNumber: String(Number(month)),
    monthName: monthNames[monthIndex],
  };
}

// Phase 44A-Fix: several of these keywords are verbs whose conjugated forms
// ("consents", "waived", "renewing", "terminated") were missing entirely
// under the old exact-word \b(...)\b matching - a real boolean-topic
// sentence like "Landlord hereby consents to..." never matched "consent".
// Widened to a word-stem (\w*) match for exactly the verb-like keywords;
// the non-verb keywords (shall, must, insurance, additional insured,
// option, not required, no right, none) are left as literal words since
// they don't have the same conjugation problem and broadening them further
// would risk over-matching unrelated text.
function booleanSourceSupportsValue(sourceText) {
  const source = normalizeEvidenceComparable(sourceText);
  return /\b(shall|must|requir\w*|insurance|additional insured|waiv\w*|consent\w*|option|renew\w*|terminat\w*|not required|no right|none)\b/.test(source);
}

function sourceTextSupportsValue({ value, rawValue, sourceText, evidenceType, extractionStatus } = {}) {
  const source = cleanSourceEvidenceText(sourceText);
  if (!source) return false;
  if (!isMeaningfulValue(value ?? rawValue)) return true;
  if (
    evidenceType === EVIDENCE_TYPES.DERIVED ||
    isCalculatedExtractionStatus(extractionStatus)
  ) {
    return true;
  }
  if (
    evidenceType === EVIDENCE_TYPES.INFERRED ||
    String(extractionStatus || "").toLowerCase() === EXTRACTION_STATUSES.INFERRED
  ) {
    return Boolean(source);
  }
  const candidate = value ?? rawValue;
  if (typeof candidate === "boolean") return booleanSourceSupportsValue(source);

  // Explicit-zero money values (e.g. a waived security deposit) often have no
  // literal "0" digit in the source text at all - OCR commonly misreads a
  // handwritten zero as a stray confusable character (Latin O-stroke or
  // Cyrillic Barred-O) or the clause spells it out as "zero" / "no deposit".
  // Token/digit matching below can't find these, so check for them directly
  // before falling through to numeric matching.
  if ((candidate === 0 || candidate === "0") && /\b(zero|no\s+(?:security\s+)?deposit)\b|[ØøӨө]/i.test(source)) {
    return true;
  }

  const sourceNorm = normalizeEvidenceComparable(source);
  const valueNorm = normalizeEvidenceComparable(candidate);
  const rawNorm = normalizeEvidenceComparable(rawValue);
  if (valueNorm && sourceNorm.includes(valueNorm)) return true;
  if (rawNorm && sourceNorm.includes(rawNorm)) return true;

  const dateTokens = isoDateSupportTokens(candidate);
  if (dateTokens) {
    const hasMonth = sourceNorm.includes(dateTokens.monthName) || sourceNorm.includes(` ${dateTokens.monthNumber} `);
    if (sourceNorm.includes(dateTokens.year) && sourceNorm.includes(dateTokens.day) && hasMonth) return true;
  }

  const valueNumbers = numericEvidenceTokens(candidate);
  if (valueNumbers.size > 0) {
    const sourceNumbers = numericEvidenceTokens(source);
    if ([...valueNumbers].some((token) => sourceNumbers.has(token))) return true;
  }

  const tokens = valueNorm.split(" ").filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  if (tokens.length >= 2 && tokens.every((token) => sourceNorm.includes(token))) return true;
  return tokens.length === 1 && sourceNorm.includes(tokens[0]);
}

export function isCalculatedExtractionStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "calculated" || normalized === "derived" || normalized === "computed";
}

export function isManualExtractionStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "manual" || normalized === "manual_required" || normalized === "manually_edited";
}

const CALCULATED_ACCEPT_FIELD_KEY_PATTERNS = [
  /(^|_)initial_term($|_)/,
  /(^|_)lease_term($|_)/,
  /(^|_)term_months($|_)/,
  /(^|_)lease_term_months($|_)/,
  /(^|_)monthly_rent($|_)/,
  /(^|_)base_rent_monthly($|_)/,
  /(^|_)annual_rent($|_)/,
  /(^|_)base_rent_annual($|_)/,
  /(^|_)rent_per_sf($|_)/,
  /(^|_)rent_psf($|_)/,
  /(^|_)tenant_pro_rata_share($|_)/,
  /(^|_)pro_rata_share($|_)/,
  /(^|_)tenant_share($|_)/,
  /(^|_)renewal_notice_(?:days|months)($|_)/,
  /(^|_)termination_notice_(?:days|months)($|_)/,
  /(^|_)base_year($|_)/,
  /(^|_)expense_stop($|_)/,
];

export function canAcceptCalculatedReviewField(field) {
  if (field?.allowCalculatedAccept === true) return true;
  const key = String(
    typeof field === "string"
      ? field
      : field?.key || field?.field_key || "",
  ).trim().toLowerCase();
  if (!key) return false;
  return CALCULATED_ACCEPT_FIELD_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function hasValidSourceEvidence(evidence = {}) {
  const quality = resolveSourceTextQuality(evidence);
  return [
    SOURCE_TEXT_QUALITIES.EXACT,
    SOURCE_TEXT_QUALITIES.PARTIAL,
    SOURCE_TEXT_QUALITIES.DERIVED,
  ].includes(quality);
}

export function isSourceBackedField({ value, confidence, evidence, extractionStatus } = {}) {
  if (!isMeaningfulValue(value)) return false;
  if (isCalculatedExtractionStatus(extractionStatus)) return false;
  if (isManualExtractionStatus(extractionStatus)) return false;
  return hasValidSourceEvidence({ ...evidence, value, confidence, extractionStatus });
}

// Resolve which lease columns to write for a given review field key. Edits
// to commencement_date should also update the legacy start_date column so
// downstream code that reads either keeps working.
export function resolveFieldColumns(key) {
  return FIELD_COLUMN_ALIASES[key] || [key];
}

export function readFieldEvidence(lease, key) {
  if (!lease) {
    return {
      rawValue: null,
      sourcePage: null,
      sourceText: null,
      sourceClause: null,
      extractionStatus: null,
      evidenceType: EVIDENCE_TYPES.MISSING,
      sourceTextQuality: SOURCE_TEXT_QUALITIES.MISSING,
      sourceFieldKeys: [],
      derivationTrace: null,
      requiresReview: false,
      reviewReason: null,
      approvalBlockingReason: null,
    };
  }
  const resolved = resolveLeaseField(lease, key, { mode: "canonical" });

  // Probe richer evidence sources directly. When the value lives on a
  // lease top-level column (primitive number / string), the resolver
  // returns just the primitive with no source_page / source_text /
  // extraction_status attached. The evidence and status actually live on
  // workflow_output.lease_fields[<alias>] or extraction_data.fields[key]
  // / .field_evidence[key]. Without this probe, calculated values
  // surface as "Missing Source Evidence" and Page stays blank.
  const aliases = getFieldAliases(key);
  const richSources = [
    lease?.extraction_data?.fields,
    lease?.extraction_data?.field_evidence,
    lease?.extraction_data?.workflow_output?.lease_fields,
    lease?.extraction_data?.workflow_output?.records?.[0]?.lease_fields,
    lease?.abstract_snapshot?.field_evidence,
    // workflow_output.lease_fields is written into each ui_review_payload record
    // by normalize-pdf-output and contains source_clause already validated by
    // isSourceRelevantToField â€” probe it before the fields entry so existing
    // leases show source text without requiring re-extraction.
    lease?.uploaded_files?.ui_review_payload?.records?.[0]?.workflow_output?.lease_fields,
    lease?.uploaded_file?.ui_review_payload?.records?.[0]?.workflow_output?.lease_fields,
    lease?.uploaded_files?.ui_review_payload?.records?.[0]?.fields,
    lease?.uploaded_files?.ui_review_payload?.records?.[0]?.standard_fields,
    lease?.uploaded_files?.ui_review_payload?.records?.[0]?.custom_fields,
    lease?.uploaded_file?.ui_review_payload?.records?.[0]?.fields,
    lease?.uploaded_file?.ui_review_payload?.records?.[0]?.standard_fields,
    lease?.uploaded_file?.ui_review_payload?.records?.[0]?.custom_fields,
  ].filter((src) => src && typeof src === "object");

  let evSourcePage = resolved?.sourcePage ?? null;
  let evSourceText = cleanSourceEvidenceText(resolved?.exactSourceText);
  let evSourceClause = cleanSourceEvidenceText(resolved?.sourceClause);
  let evRawValue = resolved?.rawValue ?? null;
  let evExtractionStatus = resolved?.reviewStatus ?? null;
  let evEvidenceType = resolved?.evidenceType ?? null;
  let evSourceTextQuality = resolved?.sourceTextQuality ?? null;
  let evSourceFieldKeys = Array.isArray(resolved?.sourceFieldKeys) ? resolved.sourceFieldKeys : [];
  let evDerivationTrace = resolved?.derivationTrace ?? null;
  let evRequiresReview = Boolean(resolved?.requiresReview);
  let evReviewReason = resolved?.reviewReason ?? null;
  let evApprovalBlockingReason = resolved?.approvalBlockingReason ?? null;

  for (const source of richSources) {
    if (evSourcePage != null && evSourceText && evExtractionStatus && evSourceTextQuality) break;
    let entry = null;
    if (Array.isArray(source)) {
      entry = source.find((item) => {
        if (!item || typeof item !== "object") return false;
        const itemKey = item.field_key ?? item.key ?? item.name ?? item.item_type;
        return aliases.includes(getFieldAliases(itemKey)[0]);
      });
    } else {
      for (const alias of aliases) {
        if (source[alias]) { entry = source[alias]; break; }
      }
    }
    if (!entry || typeof entry !== "object") continue;
    if (evSourcePage == null) {
      evSourcePage = entry.source_page ?? entry.sourcePage ?? entry.page_number ?? entry.page
        ?? entry.evidence?.source_page ?? entry.evidence?.page_number ?? entry.evidence?.page
        ?? null;
    }
    if (!evSourceText) {
      evSourceText = cleanSourceEvidenceText(entry.exact_source_text ?? entry.exactSourceText ?? entry.source_clause
        ?? entry.source_text ?? entry.snippet ?? entry.evidence?.source_clause
        ?? entry.evidence?.source_text ?? entry.evidence?.exact_source_text ?? null);
    }
    if (!evSourceClause) {
      evSourceClause = cleanSourceEvidenceText(entry.source_clause ?? entry.sourceClause
        ?? entry.evidence?.source_clause ?? null);
    }
    if (!evRawValue) {
      evRawValue = entry.raw_value ?? entry.rawValue ?? null;
    }
    if (!evExtractionStatus) {
      evExtractionStatus = entry.extraction_status ?? entry.extractionStatus
        ?? entry.review_status ?? entry.reviewStatus ?? null;
    }
    if (!evEvidenceType) {
      evEvidenceType = entry.evidence_type ?? entry.evidenceType ?? entry.evidence?.evidence_type ?? null;
    }
    if (!evSourceTextQuality) {
      evSourceTextQuality = entry.source_text_quality ?? entry.sourceTextQuality ?? entry.evidence?.source_text_quality ?? null;
    }
    if (evSourceFieldKeys.length === 0) {
      const keys = entry.source_field_keys ?? entry.sourceFieldKeys ?? entry.evidence?.source_field_keys ?? null;
      evSourceFieldKeys = Array.isArray(keys) ? keys.filter(Boolean) : [];
    }
    if (!evDerivationTrace) {
      evDerivationTrace = entry.derivation_trace ?? entry.derivationTrace ?? entry.evidence?.derivation_trace ?? null;
    }
    if (!evReviewReason) {
      evReviewReason = entry.review_reason ?? entry.reviewReason
        ?? entry.requires_review_reason ?? entry.requiresReviewReason
        ?? entry.evidence?.review_reason ?? null;
    }
    if (!evApprovalBlockingReason) {
      evApprovalBlockingReason = entry.approval_blocking_reason ?? entry.approvalBlockingReason ?? null;
    }
    evRequiresReview = evRequiresReview || Boolean(entry.requires_review ?? entry.requiresReview ?? false);
  }

  const sourceTextQuality = resolveSourceTextQuality({
    value: resolved?.value ?? evRawValue,
    sourcePage: evSourcePage,
    sourceText: evSourceText,
    sourceClause: evSourceClause,
    rawValue: evRawValue,
    sourceTextQuality: evSourceTextQuality,
    extractionStatus: evExtractionStatus,
    evidenceType: evEvidenceType,
    sourceFieldKeys: evSourceFieldKeys,
    derivationTrace: evDerivationTrace,
  });
  const evidenceType = normalizeEvidenceType(evEvidenceType ?? evExtractionStatus, {
    value: resolved?.value ?? evRawValue,
    sourceText: evSourceText,
    sourceTextQuality,
    sourceFieldKeys: evSourceFieldKeys,
    derivationTrace: evDerivationTrace,
  });
  const needsReviewForQuality =
    sourceTextQuality === SOURCE_TEXT_QUALITIES.INFERRED ||
    (isMeaningfulValue(resolved?.value ?? evRawValue) &&
      (sourceTextQuality === SOURCE_TEXT_QUALITIES.MISSING || sourceTextQuality === SOURCE_TEXT_QUALITIES.INCONSISTENT));

  return {
    // Phase 44A-Fix: without this, callers that recompute
    // resolveSourceTextQuality/sourceTextSupportsValue from this returned
    // evidence object (e.g. hasValidSourceEvidence(evidence) in
    // normalizeStandardFields) only ever see `rawValue`, which
    // buildResolverOutput (leaseFieldResolver.js) stringifies via
    // String(value) whenever there's no dedicated raw-text source on the
    // entry - turning boolean `true` into the string "true". That silently
    // defeats sourceTextSupportsValue's `typeof candidate === "boolean"`
    // check, so booleanSourceSupportsValue never runs for real boolean
    // fields. Threading the properly-typed value through fixes that at the
    // source; non-boolean fields are unaffected since String(value) and
    // value stringify identically for substring matching.
    value: resolved?.value ?? null,
    rawValue: evRawValue,
    sourcePage: normalizeSourcePage(evSourcePage),
    sourceText: evSourceText ?? null,
    sourceClause: evSourceClause ?? null,
    extractionStatus: evExtractionStatus,
    evidenceType,
    sourceTextQuality,
    sourceFieldKeys: evSourceFieldKeys,
    derivationTrace: evDerivationTrace,
    requiresReview: evRequiresReview || Boolean(evReviewReason) || needsReviewForQuality,
    reviewReason: evReviewReason,
    approvalBlockingReason: evApprovalBlockingReason,
  };
}

export function readFieldConfidence(lease, key, fallback = null) {
  if (!lease) return fallback;
  const resolved = resolveLeaseField(lease, key, { mode: "canonical" });
  if (!resolved || resolved.confidence == null) return fallback;

  const hasMeaningfulValue = isMeaningfulValue(resolved.value);
  const clamp = (score) => (hasMeaningfulValue ? score : (score == null ? null : Math.min(score, 35)));
  
  return clamp(normalizeStoredConfidence(resolved.confidence));
}

// The extractor stores confidence as 0â€“1; everything else stores 0â€“100.
// Treat values <= 1 as fractions and scale them so the UI sees one shape.
function normalizeStoredConfidence(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  return score <= 1 ? Math.round(score * 100) : Math.round(score);
}

// Confidence bucket: "high" | "medium" | "low" | "unknown" â€” drives the
// summary cards. A field with extracted data but no recorded confidence is
// classified as "unknown", not lumped into low.
export function classifyConfidence(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return "unknown";
  if (score >= 90) return "high";
  if (score >= 75) return "medium";
  return "low";
}

// Canonical extraction-status values used across the review surface. The
// extractor is expected to stamp every field with one of these; when the
// backend doesn't (older deployments) the UI infers a value via
// `resolveExtractionStatus`.
export const EXTRACTION_STATUSES = {
  EXTRACTED: "extracted",
  EXTRACTED_NO_CONFIDENCE: "extracted_no_confidence",
  NOT_FOUND: "not_found",
  NEEDS_REVIEW: "needs_review",
  MANUAL_REQUIRED: "manual_required",
  MISSING: "missing",
  MISSING_SOURCE_EVIDENCE: "missing_source_evidence",
  CALCULATED: "calculated",
  DERIVED: "derived",
  INFERRED: "inferred",
  CONFLICT: "conflict_detected",
};

export const EVIDENCE_TYPES = {
  EXTRACTED: "extracted",
  DERIVED: "derived",
  INFERRED: "inferred",
  MISSING: "missing",
  CONFLICT: "conflict",
};

export const SOURCE_TEXT_QUALITIES = {
  EXACT: "exact",
  PARTIAL: "partial",
  DERIVED: "derived",
  INFERRED: "inferred",
  MISSING: "missing",
  CONFLICT: "conflict",
  // Source text exists (and a value exists) but the text does not actually
  // support the value - distinct from MISSING (no source text at all), since
  // the review UI needs to tell reviewers "no evidence" apart from "evidence
  // contradicts value". Deliberately excluded from hasValidSourceEvidence's
  // accepted list below, so it still blocks required-field approval exactly
  // like MISSING did before this value existed.
  INCONSISTENT: "inconsistent",
};

// Phase 40: user-facing extraction-mode vocabulary, distinct from
// EXTRACTION_STATUSES above. Status answers "is this row usable right now"
// (missing/needs_review/etc.); mode answers "how did this value come to
// exist" (was it read straight off the page, normalized from a direct
// quote, inferred, computed, or provided by a human). Resolved by
// resolveLeaseReviewExtractionMode() in leaseReviewFieldNormalizer.js from
// existing extraction-status/evidence-quality/review signals only - never
// fabricated.
export const EXTRACTION_MODES = {
  EXPLICIT: "explicit",
  NORMALIZED: "normalized",
  INFERRED: "inferred",
  CALCULATED: "calculated",
  REVIEWER_ENTERED: "reviewer_entered",
  MANUAL: "manual",
  UNKNOWN: "unknown",
};

export const EXTRACTION_MODE_LABELS = {
  [EXTRACTION_MODES.EXPLICIT]: "Explicit",
  [EXTRACTION_MODES.NORMALIZED]: "Normalized",
  [EXTRACTION_MODES.INFERRED]: "Inferred",
  [EXTRACTION_MODES.CALCULATED]: "Calculated",
  [EXTRACTION_MODES.REVIEWER_ENTERED]: "Reviewer Entered",
  [EXTRACTION_MODES.MANUAL]: "Manual",
  [EXTRACTION_MODES.UNKNOWN]: "Unknown",
};

export const EXTRACTION_STATUS_LABELS = {
  extracted: "Extracted",
  extracted_no_confidence: "Extracted (no confidence)",
  not_found: "Not Found",
  needs_review: "Needs Review",
  manual_required: "Manual Required",
  missing: "Missing",
  missing_source_evidence: "Missing Source Evidence",
  calculated: "Calculated",
  derived: "Derived",
  inferred: "Inferred",
  conflict_detected: "Conflict Detected",
};

export const EXTRACTION_STATUS_STYLES = {
  extracted: "bg-emerald-50 text-emerald-700",
  extracted_no_confidence: "bg-slate-100 text-slate-700",
  not_found: "bg-amber-50 text-amber-700",
  needs_review: "bg-amber-100 text-amber-800",
  manual_required: "bg-purple-50 text-purple-700",
  missing: "bg-slate-100 text-slate-600",
  missing_source_evidence: "bg-amber-100 text-amber-800",
  calculated: "bg-blue-50 text-blue-700",
  derived: "bg-blue-50 text-blue-700",
  inferred: "bg-purple-50 text-purple-700",
  conflict_detected: "bg-red-100 text-red-700",
};

export function normalizeEvidenceType(input, context = {}) {
  const normalized = String(input || context?.evidenceType || context?.extractionStatus || "")
    .trim()
    .toLowerCase();
  if (context?.conflictCandidates?.length || normalized.includes("conflict")) return EVIDENCE_TYPES.CONFLICT;
  if (normalized === EVIDENCE_TYPES.INFERRED || normalized === EXTRACTION_STATUSES.INFERRED) return EVIDENCE_TYPES.INFERRED;
  if (isCalculatedExtractionStatus(normalized) || normalized === EXTRACTION_STATUSES.DERIVED) return EVIDENCE_TYPES.DERIVED;
  if (normalized === EXTRACTION_STATUSES.NOT_FOUND || normalized === EXTRACTION_STATUSES.MISSING || normalized === EXTRACTION_STATUSES.MISSING_SOURCE_EVIDENCE) {
    return isMeaningfulValue(context?.value) ? EVIDENCE_TYPES.INFERRED : EVIDENCE_TYPES.MISSING;
  }
  if (isMeaningfulValue(context?.value)) return EVIDENCE_TYPES.EXTRACTED;
  return EVIDENCE_TYPES.MISSING;
}

export function resolveSourceTextQuality(evidence = {}) {
  const explicit = String(
    evidence?.sourceTextQuality
      ?? evidence?.source_text_quality
      ?? evidence?.evidence?.source_text_quality
      ?? "",
  ).trim().toLowerCase();
  const extractionStatus = String(evidence?.extractionStatus ?? evidence?.extraction_status ?? "").trim().toLowerCase();
  const evidenceType = normalizeEvidenceType(evidence?.evidenceType ?? evidence?.evidence_type ?? extractionStatus, evidence);
  const hasConflict = evidenceType === EVIDENCE_TYPES.CONFLICT || extractionStatus.includes("conflict") || Boolean(evidence?.conflictCandidates?.length);
  if (hasConflict) return SOURCE_TEXT_QUALITIES.CONFLICT;

  const hasValue = isMeaningfulValue(evidence?.value ?? evidence?.normalized_value ?? evidence?.rawValue ?? evidence?.raw_value);
  const rawSourceInput = evidence?.sourceText
    ?? evidence?.source_text
    ?? evidence?.exact_source_text
    ?? evidence?.exactSourceText
    ?? evidence?.source_clause
    ?? evidence?.sourceClause
    ?? evidence?.snippet;
  const sourceText = cleanSourceEvidenceText(rawSourceInput);
  // Match against the untruncated source text. Backend-quoted evidence can run
  // well past SOURCE_TEXT_MAX_CHARS (e.g. an LLM quoting an entire OCR'd page);
  // truncating before checking whether the value is actually present would cut
  // off the matching sentence and produce a false "missing evidence" verdict.
  const fullSourceText = cleanSourceEvidenceText(rawSourceInput, { truncate: false }) ?? sourceText;
  const sourceClause = cleanSourceEvidenceText(evidence?.sourceClause ?? evidence?.source_clause);
  const page = normalizeSourcePage(evidence?.sourcePage ?? evidence?.source_page ?? evidence?.page_number ?? evidence?.page);
  const hasDerivation = Boolean(
    evidence?.derivationTrace
      ?? evidence?.derivation_trace
      ?? evidence?.sourceFieldKeys?.length
      ?? evidence?.source_field_keys?.length,
  );
  const rawValue = evidence?.rawValue ?? evidence?.raw_value;

  if (
    Object.values(SOURCE_TEXT_QUALITIES).includes(explicit) &&
    ![SOURCE_TEXT_QUALITIES.EXACT, SOURCE_TEXT_QUALITIES.PARTIAL].includes(explicit)
  ) {
    return explicit;
  }

  if (evidenceType === EVIDENCE_TYPES.DERIVED || isCalculatedExtractionStatus(extractionStatus) || hasDerivation) {
    return hasValue && hasDerivation ? SOURCE_TEXT_QUALITIES.DERIVED : SOURCE_TEXT_QUALITIES.MISSING;
  }
  if (evidenceType === EVIDENCE_TYPES.INFERRED || extractionStatus === EXTRACTION_STATUSES.INFERRED) {
    return hasValue && (sourceText || sourceClause || evidence?.derivationTrace || evidence?.derivation_trace)
      ? SOURCE_TEXT_QUALITIES.INFERRED
      : SOURCE_TEXT_QUALITIES.MISSING;
  }
  if (!hasValue && !sourceText && !sourceClause) return SOURCE_TEXT_QUALITIES.MISSING;
  if (sourceText || sourceClause) {
    const evidenceText = sourceText ?? sourceClause;
    const supportsValue = sourceTextSupportsValue({
      value: evidence?.value ?? evidence?.normalized_value,
      rawValue,
      sourceText: fullSourceText ?? evidenceText,
      evidenceType,
      extractionStatus,
    });
    if (hasValue && !supportsValue) return SOURCE_TEXT_QUALITIES.INCONSISTENT;
    if (explicit === SOURCE_TEXT_QUALITIES.PARTIAL) return SOURCE_TEXT_QUALITIES.PARTIAL;
    return page && hasNaturalSourceBoundary(evidenceText)
      ? SOURCE_TEXT_QUALITIES.EXACT
      : SOURCE_TEXT_QUALITIES.PARTIAL;
  }
  return SOURCE_TEXT_QUALITIES.MISSING;
}

/**
 * Infer an extraction status from the lease + field. Honors any explicit
 * status set by the backend, otherwise uses these rules:
 *   - value present + source evidence + confidence  â†’ "extracted"
 *   - value present + source evidence + no confidence â†’ "extracted_no_confidence"
 *   - value present + NO source evidence            â†’ "missing_source_evidence"
 *   - no value + extractor was run                  â†’ "not_found"
 *   - no value + extractor didn't run               â†’ "missing"
 *
 * "manual_required" can only be set by the backend or by a user action â€” we
 * never infer it client-side because it implies a policy decision.
 */
export function resolveExtractionStatus(lease, key, { value, confidence, evidence } = {}) {
  const explicit = String(evidence?.extractionStatus || "").trim().toLowerCase();
  const present = isMeaningfulValue(value);
  const hasEvidence = hasValidSourceEvidence(evidence);
  const debug = lease?.extraction_data?.extraction_debug || {};
  const extractionIncomplete = Boolean(
    debug.partial_document_text_detected ||
    debug.mapping_failure_reason === "partial_document_text_detected",
  );

  if (explicit) {
    if (isCalculatedExtractionStatus(explicit)) return EXTRACTION_STATUSES.CALCULATED;
    if (explicit === EXTRACTION_STATUSES.INFERRED) return present ? EXTRACTION_STATUSES.INFERRED : EXTRACTION_STATUSES.NOT_FOUND;
    if (isManualExtractionStatus(explicit)) return explicit;
    if (explicit === EXTRACTION_STATUSES.EXTRACTED) {
      if (!present) return EXTRACTION_STATUSES.NOT_FOUND;
      if (!hasEvidence) return EXTRACTION_STATUSES.MISSING_SOURCE_EVIDENCE;
      return typeof confidence === "number" && !Number.isNaN(confidence)
        ? EXTRACTION_STATUSES.EXTRACTED
        : EXTRACTION_STATUSES.EXTRACTED_NO_CONFIDENCE;
    }
    if (explicit === EXTRACTION_STATUSES.EXTRACTED_NO_CONFIDENCE) {
      if (!present) return EXTRACTION_STATUSES.NOT_FOUND;
      return hasEvidence ? EXTRACTION_STATUSES.EXTRACTED_NO_CONFIDENCE : EXTRACTION_STATUSES.MISSING_SOURCE_EVIDENCE;
    }
    if (explicit === EXTRACTION_STATUSES.MISSING_SOURCE_EVIDENCE) {
      return present ? EXTRACTION_STATUSES.MISSING_SOURCE_EVIDENCE : EXTRACTION_STATUSES.NOT_FOUND;
    }
    if (explicit === EXTRACTION_STATUSES.NEEDS_REVIEW) return explicit;
    if (explicit === EXTRACTION_STATUSES.NOT_FOUND || explicit === EXTRACTION_STATUSES.MISSING) {
      return extractionIncomplete && !present ? EXTRACTION_STATUSES.NEEDS_REVIEW : explicit;
    }
    if (explicit === EXTRACTION_STATUSES.CONFLICT) return explicit;
  }

  if (present) {
    if (!hasEvidence) return EXTRACTION_STATUSES.MISSING_SOURCE_EVIDENCE;
    return typeof confidence === "number" && !Number.isNaN(confidence)
      ? EXTRACTION_STATUSES.EXTRACTED
      : EXTRACTION_STATUSES.EXTRACTED_NO_CONFIDENCE;
  }
  // The extractor "ran" if any structural extraction metadata exists on the
  // lease. This avoids labelling fresh, never-extracted leases as not_found.
  const extractorRan = Boolean(
    lease?.extraction_data?.fields
    || lease?.extraction_data?.field_evidence
    || lease?.extraction_data?.confidence_scores
    || lease?.extraction_data?.workflow_output
    || lease?.abstract_snapshot?.fields
    || lease?.extracted_fields,
  );
  if (!extractorRan) return EXTRACTION_STATUSES.MISSING;
  return extractionIncomplete ? EXTRACTION_STATUSES.NEEDS_REVIEW : EXTRACTION_STATUSES.NOT_FOUND;
}

/**
 * Did the reviewer provide an override reason for a field that has no
 * source evidence? Stored in fieldReviews[key].note as a free-text
 * justification. A non-empty note is treated as an override.
 */
export function hasEvidenceOverride(review) {
  if (!review) return false;
  if (review.evidence_override === true) return true;
  if (typeof review.note === "string" && review.note.trim().length > 0) return true;
  return false;
}

export function readFieldReview(lease, key) {
  return lease?.extraction_data?.field_reviews?.[key] || null;
}

export function isResolvedReview(review) {
  if (!review) return false;
  return RESOLVED_REVIEW_STATUSES.has(review.status);
}

export function normalizeClauseType(type) {
  const t = String(type || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    (t.includes("rent") && t.includes("escalation")) ||
    t === "rentclause" ||
    t === "rentescalation" ||
    t.includes("baserent") ||
    t.includes("monthlyrent") ||
    t.includes("annualrent") ||
    t.includes("billingfrequency") ||
    t.includes("rentpayment") ||
    t.includes("escalationrate") ||
    t.includes("escalationtype")
  ) return "rent_clause";
  if (t.includes("securitydeposit")) return "security_deposit";
  if (
    t.includes("operatingexpense") ||
    t.includes("expenserecovery") ||
    t.includes("leasestructure") ||
    t.includes("expensestructure") ||
    t.includes("leasetype") ||
    t.includes("taxresponsibility") ||
    t.includes("responsibilitytax") ||
    t === "taxes" ||
    t.includes("utility") ||
    t.includes("janitorial")
  ) return "operating_expense_recovery";
  if (t.includes("cam") || t.includes("recoveries")) return "cam_recoveries";
  if (t.includes("indemnification") || t.includes("indemnity")) return "indemnification";
  if (t.includes("insurance") || t.includes("liability") || t.includes("additionalinsured")) return "insurance_requirements";
  if (t.includes("use") || t.includes("permitted")) return "use_permitted_use";
  if (t.includes("assignment") || t.includes("subletting") || t.includes("sublease")) return "assignment_subletting";
  if (t.includes("default") || t.includes("remedies") || t === "remedies") return "defaults_remedies";
  if (t.includes("latefee") || t.includes("latecharge")) return "late_fees";
  if (t.includes("renewal") || t.includes("optiontorenew")) return "renewal_option";
  if (t.includes("termination") || t.includes("earlyout")) return "termination";
  if (t.includes("repair") || t.includes("maintenance")) return "repairs_maintenance";
  if (t.includes("alteration") || t.includes("improvement")) return "alterations";
  if (t.includes("holdover")) return "holdover";
  if (t.includes("subordination") || t.includes("snda")) return "subordination";
  if (t.includes("estoppel")) return "estoppel";
  if (t.includes("notice")) return "notices";
  if (t.includes("broker") || t.includes("commission")) return "broker_commission";
  if (t.includes("guaranty") || t.includes("guarantor") || t.includes("guarantee")) return "guaranty";
  return type; // return original if no mapping found
}

// Must match the backend's extraction_contract_version string exactly
// (supabase/functions/_shared/extraction/pipeline.ts, normalize-pdf-output).
export const CURRENT_EXTRACTION_CONTRACT_VERSION = "lease-review-evidence-v3";

/**
 * §2: is this lease/uploadedFile pair showing an extraction produced by an
 * older pipeline contract? Checks the nested metadata.extractionDebug path
 * FIRST — it's set unconditionally as soon as ANY extraction runs (even the
 * fast minimal payload, before the deferred evidence-enrichment pass ever
 * completes). The top-level metadata.extraction_contract_version is only
 * guaranteed once the minimal-payload builder stamps it directly or the
 * enrich pass finishes — checking it first previously produced false
 * "older extractor" positives for genuinely current-contract files whose
 * enrichment simply hadn't completed yet. Uses equality, not string
 * ordering (a lexicographic "<" comparison would misclassify a future
 * "...-v10" as older than "...-v3").
 */
export function isStaleExtractionPayload(uploadedFile, lease) {
  const version =
    uploadedFile?.ui_review_payload?.metadata?.extractionDebug?.extraction_contract_version ??
    uploadedFile?.ui_review_payload?.metadata?.extraction_contract_version ??
    lease?.extraction_data?.extraction_debug?.extraction_contract_version ??
    lease?.extraction_data?.extraction_debug?.extractionDebug?.extraction_contract_version;
  return !version || version !== CURRENT_EXTRACTION_CONTRACT_VERSION;
}