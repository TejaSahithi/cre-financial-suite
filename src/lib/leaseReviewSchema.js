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
  { key: "insurance", label: "Insurance" },
  { key: "legal_options", label: "Legal / Options" },
  { key: "clause_records", label: "Clause Records" },
  { key: "critical_dates", label: "Critical Dates" },
  { key: "documents_exhibits", label: "Documents / Exhibits" },
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
  { key: "landlord_name",      label: "Landlord Name",                tab: "parties_premises", type: "text" },
  { key: "premises_address",   label: "Premises Address",             tab: "parties_premises", type: "text" },
  { key: "square_footage",     label: "Square Footage (RSF)",         tab: "parties_premises", required: true,  allowNA: false, type: "number" },
  { key: "premises_use",       label: "Permitted Use",                tab: "parties_premises", type: "text" },

  // Dates & Term — Lease Date (signing), Commencement Date (term start),
  // and Expiration Date are explicitly distinct. Commencement/expiration are
  // stored on both the legacy start_date/end_date columns AND the dedicated
  // commencement_date/expiration_date columns so downstream queries that read
  // either pair keep working.
  { key: "lease_date",                 label: "Lease Date (signed)",                 tab: "dates_term", type: "date" },
  { key: "commencement_date",          label: "Commencement Date",                   tab: "dates_term", required: true,  allowNA: false, type: "date" },
  { key: "rent_commencement_date",     label: "Rent Commencement Date",              tab: "dates_term", type: "date" },
  { key: "expiration_date",            label: "Expiration Date",                     tab: "dates_term", required: true,  allowNA: false, type: "date" },
  { key: "renewal_notice_months",      label: "Renewal Notice (months)",             tab: "dates_term", type: "number" },
  { key: "termination_notice_months",  label: "Termination Notice (months)",         tab: "dates_term", type: "number" },
  { key: "option_exercise_deadline",   label: "Option Exercise Deadline",            tab: "dates_term", type: "date" },

  // Rent & Charges
  { key: "monthly_rent",        label: "Monthly Rent",            tab: "rent_charges", required: true, allowNA: false, type: "currency" },
  { key: "annual_rent",         label: "Annual Rent",             tab: "rent_charges", type: "currency" },
  { key: "rent_per_sf",         label: "Base Rent ($/SF/yr)",     tab: "rent_charges", type: "number" },
  { key: "billing_frequency",   label: "Billing Frequency",       tab: "rent_charges", type: "select", options: "billing_frequency" },
  { key: "escalation_type",     label: "Escalation Type",         tab: "rent_charges", type: "select", options: "escalation_type" },
  { key: "escalation_rate",     label: "Escalation Rate (%)",     tab: "rent_charges", type: "number" },
  { key: "escalation_timing",   label: "Escalation Timing",       tab: "rent_charges", type: "select", options: "escalation_timing" },
  { key: "free_rent_months",    label: "Free Rent (months)",      tab: "rent_charges", type: "number" },
  { key: "ti_allowance",        label: "TI Allowance",            tab: "rent_charges", type: "currency" },
  { key: "security_deposit",    label: "Security Deposit",        tab: "rent_charges", type: "currency" },

  // Expenses / Recoveries
  { key: "lease_type",                 label: "Lease Type (Expense Structure)", tab: "expenses_recoveries", required: true, allowNA: false, type: "select", options: "lease_type" },
  { key: "responsibility_taxes",       label: "Taxes Responsibility",            tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "responsibility_insurance",   label: "Insurance Responsibility",        tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "responsibility_utilities",   label: "Utilities Responsibility",        tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "responsibility_repairs",     label: "Repairs & Maintenance",           tab: "expenses_recoveries", type: "select", options: "hvac_responsibility" },
  { key: "base_year",                  label: "Base Year",                       tab: "expenses_recoveries", type: "number" },
  { key: "expense_stop",               label: "Expense Stop ($)",                tab: "expenses_recoveries", type: "currency" },

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
  { key: "right_of_first_refusal",  label: "Right of First Refusal",   tab: "legal_options", type: "boolean" },
  { key: "early_termination_option", label: "Early Termination Option", tab: "legal_options", type: "boolean" },
  { key: "assignment_provisions",   label: "Assignment Provisions",    tab: "legal_options", type: "text" },
  { key: "default_cure_period",     label: "Default Cure Period (days)", tab: "legal_options", type: "number" },
];

export const FIELDS_BY_TAB = LEASE_REVIEW_TABS.reduce((acc, tab) => {
  acc[tab.key] = LEASE_REVIEW_FIELDS.filter((field) => field.tab === tab.key);
  return acc;
}, {});

export const REQUIRED_FIELD_KEYS = LEASE_REVIEW_FIELDS
  .filter((field) => field.required)
  .map((field) => field.key);

// Numeric field keys (used by leaseService.update to coerce strings → numbers).
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
  square_footage:    ["square_footage", "total_sf", "rentable_area_sqft", "tenant_rsf"],
  total_sf:          ["total_sf", "square_footage", "rentable_area_sqft"],
  premises_address:  ["premises_address", "property_address", "premises_location"],
  premises_use:      ["premises_use", "permitted_use"],
  monthly_rent:      ["monthly_rent", "base_rent_monthly", "base_rent"],
  annual_rent:       ["annual_rent", "base_rent_annual"],
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
  general_liability_min: ["general_liability_min", "general_liability_amount", "commercial_general_liability_amount", "commercial_general_liability_limit", "liability_insurance_amount"],
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
    structuredKeys: ["liability_limit_each_occurrence", "liability_limit_aggregate"],
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
    const direct = parseStoredNumber(clauseText);
    if (direct != null) return direct;
    const match = clauseText.match(/\$?\s*([\d,]+(?:\.\d{2})?)/);
    return match?.[1] ? parseStoredNumber(match[1]) : null;
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

// Pull a stored normalized value for a field, regardless of whether it lives
// on the lease row directly or inside extraction_data.
export function readFieldValue(lease, key) {
  if (!lease) return null;
  const candidates = FIELD_COLUMN_ALIASES[key] || [key];
  for (const candidate of candidates) {
    if (isPresent(lease[candidate])) return lease[candidate];
  }
  const extracted = lease.extracted_fields || {};
  const extractedEntry = pickCandidateEntry(extracted, candidates);
  if (isPresent(extractedEntry)) return unwrapFieldValue(extractedEntry);
  const fields = lease.extraction_data?.fields || {};
  const extractionEntry = pickCandidateEntry(fields, candidates);
  if (isPresent(extractionEntry)) return unwrapFieldValue(extractionEntry);
  const workflowFields = getWorkflowLeaseFields(lease);
  const workflowEntry = pickCandidateEntry(workflowFields, candidates);
  if (isPresent(workflowEntry)) return unwrapFieldValue(workflowEntry);
  for (const candidate of candidates) {
    const derived = buildDerivedWorkflowEntry(lease, candidate);
    if (isPresent(derived?.value)) return derived.value;
  }
  const clauseFallback = findClauseFallbackEntry(lease, key);
  if (isPresent(clauseFallback?.value)) return clauseFallback.value;
  const snapshotFields = lease?.abstract_snapshot?.fields || {};
  const snapshotEntry = pickCandidateEntry(snapshotFields, candidates);
  if (isPresent(snapshotEntry)) return unwrapFieldValue(snapshotEntry);
  return null;
}

// Resolve which lease columns to write for a given review field key. Edits
// to commencement_date should also update the legacy start_date column so
// downstream code that reads either keeps working.
export function resolveFieldColumns(key) {
  return FIELD_COLUMN_ALIASES[key] || [key];
}

// Best-effort lookup for the raw extraction value, source page and source text.
// Walks multiple shapes the backend may produce, in priority order:
//   1. extraction_data.field_evidence[key] (current shape from review-approve)
//   2. extraction_data.evidence[key]       (legacy shape)
//   3. extraction_data.fields[key]         (current shape)
//   4. extraction_data.workflow_output.lease_fields[key] (raw workflow output)
//   5. abstract_snapshot.fields[key]       (post-approval frozen snapshot)
export function readFieldEvidence(lease, key) {
  const candidates = FIELD_COLUMN_ALIASES[key] || [key];
  const evidenceMap = lease?.extraction_data?.field_evidence || lease?.extraction_data?.evidence || {};
  const fieldsMap = lease?.extraction_data?.fields || {};
  const workflowFields = getWorkflowLeaseFields(lease);
  const snapshotFields = lease?.abstract_snapshot?.fields || {};
  const evidence = pickCandidateEntry(evidenceMap, candidates);
  const fieldEntry = pickCandidateEntry(fieldsMap, candidates);
  const workflowEntry = pickCandidateEntry(workflowFields, candidates);
  const derivedEntry = candidates.map((candidate) => buildDerivedWorkflowEntry(lease, candidate)).find(Boolean) || null;
  const clauseFallbackEntry = findClauseFallbackEntry(lease, key);
  const snapshotEntry = pickCandidateEntry(snapshotFields, candidates);

  const raw =
    readFromEntry(evidence, "raw_value", "raw", "original_value", "extracted_value")
    ?? readFromEntry(fieldEntry, "raw_value", "raw", "original_value", "extracted_value")
    ?? readFromEntry(workflowEntry, "raw_value", "source_clause", "clause_text", "evidence_text")
    ?? readFromEntry(derivedEntry, "raw_value", "source_clause", "clause_text", "evidence_text")
    ?? readFromEntry(clauseFallbackEntry, "raw_value", "source_clause", "clause_text", "source_text")
    ?? readFromEntry(snapshotEntry, "raw_value", "raw", "original_value", "extracted_value");
  const sourcePage =
    readFromEntry(evidence, "source_page", "page", "page_number", "evidence_page_number", "sourcePage")
    ?? readFromEntry(fieldEntry, "source_page", "page", "page_number", "evidence_page_number", "sourcePage")
    ?? readFromEntry(workflowEntry, "source_page", "page", "page_number", "evidence_page_number", "sourcePage")
    ?? readFromEntry(derivedEntry, "source_page", "page", "page_number", "evidence_page_number", "sourcePage")
    ?? readFromEntry(clauseFallbackEntry, "source_page", "page", "page_number", "evidence_page_number", "sourcePage")
    ?? readFromEntry(snapshotEntry, "source_page", "page", "page_number", "evidence_page_number", "sourcePage");
  const sourceText =
    readFromEntry(evidence, "source_text", "snippet", "exact_source_text", "source_clause", "evidence_text", "clause_text", "matched_text", "text", "value_excerpt")
    ?? readFromEntry(fieldEntry, "source_text", "snippet", "exact_source_text", "source_clause", "evidence_text", "clause_text", "matched_text", "text", "value_excerpt")
    ?? readFromEntry(workflowEntry, "source_clause", "source_text", "snippet", "exact_source_text", "evidence_text", "clause_text", "matched_text", "text", "value_excerpt")
    ?? readFromEntry(derivedEntry, "source_clause", "source_text", "snippet", "exact_source_text", "evidence_text", "clause_text", "matched_text", "text", "value_excerpt")
    ?? readFromEntry(clauseFallbackEntry, "source_clause", "source_text", "snippet", "exact_source_text", "evidence_text", "clause_text", "matched_text", "text", "value_excerpt")
    ?? readFromEntry(snapshotEntry, "source_text", "snippet", "exact_source_text", "source_clause", "evidence_text", "clause_text", "matched_text", "text", "value_excerpt");
  const extractionStatus =
    readFromEntry(evidence, "extraction_status")
    ?? readFromEntry(fieldEntry, "extraction_status")
    ?? readFromEntry(workflowEntry, "extraction_status")
    ?? readFromEntry(derivedEntry, "extraction_status")
    ?? readFromEntry(clauseFallbackEntry, "extraction_status")
    ?? readFromEntry(snapshotEntry, "extraction_status");
  return {
    rawValue: raw ?? unwrapFieldValue(fieldEntry) ?? unwrapFieldValue(workflowEntry) ?? unwrapFieldValue(clauseFallbackEntry) ?? null,
    sourcePage: parseStoredNumber(sourcePage) ?? sourcePage ?? null,
    sourceText: sourceText ?? null,
    extractionStatus: extractionStatus ?? null,
  };
}

export function readFieldConfidence(lease, key, fallback = null) {
  const candidates = FIELD_COLUMN_ALIASES[key] || [key];
  const scores = lease?.extraction_data?.confidence_scores || {};
  for (const candidate of candidates) {
    const score = parseStoredNumber(scores[candidate]);
    if (score != null) return normalizeStoredConfidence(score);
  }
  const extracted = lease?.extracted_fields || {};
  const extractedEntry = pickCandidateEntry(extracted, candidates);
  const extractedConfidence = parseStoredNumber(
    readFromEntry(extractedEntry, "confidence", "confidence_score", "score"),
  );
  if (extractedConfidence != null) return normalizeStoredConfidence(extractedConfidence);
  const fields = lease?.extraction_data?.fields || {};
  const fieldEntry = pickCandidateEntry(fields, candidates);
  const fieldConfidence = parseStoredNumber(
    readFromEntry(fieldEntry, "confidence", "confidence_score", "score"),
  );
  if (fieldConfidence != null) return normalizeStoredConfidence(fieldConfidence);
  const workflowFields = getWorkflowLeaseFields(lease);
  const workflowEntry = pickCandidateEntry(workflowFields, candidates);
  const workflowConfidence = parseStoredNumber(
    readFromEntry(workflowEntry, "confidence_score", "confidence", "score"),
  );
  if (workflowConfidence != null) return normalizeStoredConfidence(workflowConfidence);
  for (const candidate of candidates) {
    const score = parseStoredNumber(
      readFromEntry(buildDerivedWorkflowEntry(lease, candidate), "confidence_score", "confidence", "score"),
    );
    if (score != null) return normalizeStoredConfidence(score);
  }
  const clauseFallbackEntry = findClauseFallbackEntry(lease, key);
  const clauseFallbackConfidence = parseStoredNumber(
    readFromEntry(clauseFallbackEntry, "confidence", "confidence_score", "score"),
  );
  if (clauseFallbackConfidence != null) return normalizeStoredConfidence(clauseFallbackConfidence);
  const snapshotFields = lease?.abstract_snapshot?.fields || {};
  const snapshotEntry = pickCandidateEntry(snapshotFields, candidates);
  const snapshotConfidence = parseStoredNumber(
    readFromEntry(snapshotEntry, "confidence", "confidence_score", "score"),
  );
  if (snapshotConfidence != null) return normalizeStoredConfidence(snapshotConfidence);
  return fallback;
}

// The extractor stores confidence as 0–1; everything else stores 0–100.
// Treat values <= 1 as fractions and scale them so the UI sees one shape.
function normalizeStoredConfidence(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  return score <= 1 ? Math.round(score * 100) : Math.round(score);
}

// Confidence bucket: "high" | "medium" | "low" | "unknown" — drives the
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
  MANUAL_REQUIRED: "manual_required",
  MISSING: "missing",
  MISSING_SOURCE_EVIDENCE: "missing_source_evidence",
  CALCULATED: "calculated",
  CONFLICT: "conflict_detected",
};

export const EXTRACTION_STATUS_LABELS = {
  extracted: "Extracted",
  extracted_no_confidence: "Extracted (no confidence)",
  not_found: "Not Found",
  manual_required: "Manual Required",
  missing: "Missing",
  missing_source_evidence: "Missing Source Evidence",
  calculated: "Calculated",
  conflict_detected: "Conflict Detected",
};

export const EXTRACTION_STATUS_STYLES = {
  extracted: "bg-emerald-50 text-emerald-700",
  extracted_no_confidence: "bg-slate-100 text-slate-700",
  not_found: "bg-amber-50 text-amber-700",
  manual_required: "bg-purple-50 text-purple-700",
  missing: "bg-slate-100 text-slate-600",
  missing_source_evidence: "bg-amber-100 text-amber-800",
  calculated: "bg-blue-50 text-blue-700",
  conflict_detected: "bg-red-100 text-red-700",
};

/**
 * Infer an extraction status from the lease + field. Honors any explicit
 * status set by the backend, otherwise uses these rules:
 *   - value present + confidence       → "extracted"
 *   - value present + no confidence    → "extracted_no_confidence"
 *   - no value + extractor was run     → "not_found"
 *   - no value + extractor didn't run  → "missing"
 *
 * "manual_required" can only be set by the backend or by a user action — we
 * never infer it client-side because it implies a policy decision.
 */
export function resolveExtractionStatus(lease, key, { value, confidence, evidence } = {}) {
  const explicit = evidence?.extractionStatus;
  if (explicit) return explicit;
  const present = value !== null && value !== undefined && value !== "";
  if (present) {
    return typeof confidence === "number"
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
  return extractorRan ? EXTRACTION_STATUSES.NOT_FOUND : EXTRACTION_STATUSES.MISSING;
}

export function readFieldReview(lease, key) {
  return lease?.extraction_data?.field_reviews?.[key] || null;
}

export function isResolvedReview(review) {
  if (!review) return false;
  return RESOLVED_REVIEW_STATUSES.has(review.status);
}
