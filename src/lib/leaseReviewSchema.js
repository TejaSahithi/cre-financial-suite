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
  { key: "documents_exhibits", label: "Documents / Exhibits" },
  { key: "budget_preview", label: "Budget Preview" },
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

  // Dates & Term
  { key: "lease_date",                 label: "Lease Date",                          tab: "dates_term", type: "date" },
  { key: "start_date",                 label: "Commencement Date",                   tab: "dates_term", required: true,  allowNA: false, type: "date" },
  { key: "rent_commencement_date",     label: "Rent Commencement Date",              tab: "dates_term", type: "date" },
  { key: "end_date",                   label: "Expiration Date",                     tab: "dates_term", required: true,  allowNA: false, type: "date" },
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

// Pull a stored normalized value for a field, regardless of whether it lives
// on the lease row directly or inside extraction_data.
export function readFieldValue(lease, key) {
  if (!lease) return null;
  if (lease[key] !== undefined && lease[key] !== null && lease[key] !== "") return lease[key];
  const extracted = lease.extracted_fields || {};
  if (extracted[key] !== undefined && extracted[key] !== null && extracted[key] !== "") return extracted[key];
  const inExtraction = lease.extraction_data?.fields?.[key];
  if (inExtraction !== undefined && inExtraction !== null && inExtraction !== "") {
    return typeof inExtraction === "object" && "value" in inExtraction ? inExtraction.value : inExtraction;
  }
  return null;
}

// Best-effort lookup for the raw extraction value, source page and source text.
// Falls back to nulls if the extraction pipeline did not provide evidence.
export function readFieldEvidence(lease, key) {
  const evidence = lease?.extraction_data?.field_evidence?.[key]
    || lease?.extraction_data?.evidence?.[key]
    || null;
  const fieldEntry = lease?.extraction_data?.fields?.[key];
  const raw =
    evidence?.raw_value
    ?? evidence?.raw
    ?? (fieldEntry && typeof fieldEntry === "object" ? fieldEntry.raw_value ?? fieldEntry.raw : undefined);
  const sourcePage =
    evidence?.source_page
    ?? evidence?.page
    ?? (fieldEntry && typeof fieldEntry === "object" ? fieldEntry.source_page ?? fieldEntry.page : undefined);
  const sourceText =
    evidence?.source_text
    ?? evidence?.snippet
    ?? (fieldEntry && typeof fieldEntry === "object" ? fieldEntry.source_text ?? fieldEntry.snippet : undefined);
  return {
    rawValue: raw ?? null,
    sourcePage: sourcePage ?? null,
    sourceText: sourceText ?? null,
  };
}

export function readFieldConfidence(lease, key, fallback = null) {
  const explicit = lease?.extraction_data?.confidence_scores?.[key];
  if (typeof explicit === "number") return explicit;
  const alt = lease?.extracted_fields?.[key]?.confidence;
  if (typeof alt === "number") return alt;
  return fallback;
}

export function readFieldReview(lease, key) {
  return lease?.extraction_data?.field_reviews?.[key] || null;
}

export function isResolvedReview(review) {
  if (!review) return false;
  return RESOLVED_REVIEW_STATUSES.has(review.status);
}
