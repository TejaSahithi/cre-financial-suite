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
  square_footage:    ["square_footage", "total_sf", "rentable_area_sqft", "tenant_rsf"],
  total_sf:          ["total_sf", "square_footage", "rentable_area_sqft"],
  premises_address:  ["premises_address", "property_address"],
  premises_use:      ["premises_use", "permitted_use"],
};

function isPresent(v) {
  return v !== undefined && v !== null && v !== "";
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
  for (const candidate of candidates) {
    if (isPresent(extracted[candidate])) {
      const v = extracted[candidate];
      return typeof v === "object" && "value" in v ? v.value : v;
    }
  }
  const fields = lease.extraction_data?.fields || {};
  for (const candidate of candidates) {
    const inExtraction = fields[candidate];
    if (isPresent(inExtraction)) {
      return typeof inExtraction === "object" && "value" in inExtraction ? inExtraction.value : inExtraction;
    }
  }
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
  const workflowFields = lease?.extraction_data?.workflow_output?.lease_fields || {};
  const snapshotFields = lease?.abstract_snapshot?.fields || {};

  const pick = (map) => {
    for (const candidate of candidates) {
      if (map?.[candidate]) return map[candidate];
    }
    return null;
  };

  const evidence = pick(evidenceMap);
  const fieldEntry = pick(fieldsMap);
  const workflowEntry = pick(workflowFields);
  const snapshotEntry = pick(snapshotFields);

  const readFrom = (entry, ...keys) => {
    if (!entry || typeof entry !== "object") return undefined;
    for (const k of keys) {
      if (entry[k] !== undefined && entry[k] !== null && entry[k] !== "") return entry[k];
    }
    return undefined;
  };

  const raw =
    readFrom(evidence, "raw_value", "raw")
    ?? readFrom(fieldEntry, "raw_value", "raw")
    ?? readFrom(workflowEntry, "raw_value", "source_clause")
    ?? readFrom(snapshotEntry, "raw_value", "raw");
  const sourcePage =
    readFrom(evidence, "source_page", "page")
    ?? readFrom(fieldEntry, "source_page", "page")
    ?? readFrom(workflowEntry, "source_page", "page")
    ?? readFrom(snapshotEntry, "source_page", "page");
  const sourceText =
    readFrom(evidence, "source_text", "snippet", "exact_source_text", "source_clause")
    ?? readFrom(fieldEntry, "source_text", "snippet", "exact_source_text", "source_clause")
    ?? readFrom(workflowEntry, "source_clause", "source_text", "snippet", "exact_source_text")
    ?? readFrom(snapshotEntry, "source_text", "snippet", "exact_source_text", "source_clause");
  const extractionStatus =
    readFrom(evidence, "extraction_status")
    ?? readFrom(fieldEntry, "extraction_status")
    ?? readFrom(workflowEntry, "extraction_status")
    ?? readFrom(snapshotEntry, "extraction_status");
  return {
    rawValue: raw ?? null,
    sourcePage: sourcePage ?? null,
    sourceText: sourceText ?? null,
    extractionStatus: extractionStatus ?? null,
  };
}

export function readFieldConfidence(lease, key, fallback = null) {
  const candidates = FIELD_COLUMN_ALIASES[key] || [key];
  const scores = lease?.extraction_data?.confidence_scores || {};
  for (const candidate of candidates) {
    if (typeof scores[candidate] === "number") return scores[candidate];
  }
  const extracted = lease?.extracted_fields || {};
  for (const candidate of candidates) {
    const alt = extracted[candidate]?.confidence;
    if (typeof alt === "number") return alt;
  }
  const fields = lease?.extraction_data?.fields || {};
  for (const candidate of candidates) {
    const score = fields[candidate]?.confidence ?? fields[candidate]?.confidence_score;
    if (typeof score === "number") return normalizeStoredConfidence(score);
  }
  const workflowFields = lease?.extraction_data?.workflow_output?.lease_fields || {};
  for (const candidate of candidates) {
    const score = workflowFields[candidate]?.confidence_score ?? workflowFields[candidate]?.confidence;
    if (typeof score === "number") return normalizeStoredConfidence(score);
  }
  const snapshotFields = lease?.abstract_snapshot?.fields || {};
  for (const candidate of candidates) {
    const score = snapshotFields[candidate]?.confidence ?? snapshotFields[candidate]?.confidence_score;
    if (typeof score === "number") return normalizeStoredConfidence(score);
  }
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
