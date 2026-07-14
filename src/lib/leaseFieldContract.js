/**
 * Lease Field Contract — frontend mirror of
 * supabase/functions/_shared/extraction/field-contract.ts.
 *
 * Hand-ported, not shared-imported: the Vite frontend and Deno edge functions
 * have no shared build boundary today. If the backend file changes, this one
 * needs a matching update — the entry list below should stay identical in
 * content (canonicalKey/aliases/group/required*/evidenceRequired/inLeaseSchema/
 * computed/preferredForAutomatedLogic) to the backend's LEASE_FIELD_CONTRACT.
 *
 * Two distinct relationships are modeled, and they are NOT the same thing:
 *   - `aliases`: a different vocabulary's name for the exact same LEASE_SCHEMA
 *     field (e.g. "base_rent_monthly" is what budgetFieldKeys/FIELD_SPECS call
 *     monthly_rent — same field, different name).
 *   - `alternateFieldKeys`: a DIFFERENT, independently-extracted LEASE_SCHEMA
 *     field that satisfies the same real-world fact as an OR-alternate (e.g.
 *     start_date and commencement_date are two distinct schema fields with
 *     their own labels/patterns; either one satisfies core-readiness).
 *     Do not conflate the two — resolveCanonicalFieldKey() only follows `aliases`.
 *
 * Used only for grouping/labels/display order/contract flags in this task.
 * src/lib/leaseFieldResolver.js is untouched and remains the source of truth
 * for actually resolving a field's value/evidence out of a lease payload.
 */

// 17 groups, in the display order used throughout Lease Review's new grouped
// view. "document_identity" wasn't in the illustrative Phase 4 group list but
// is a real group with real fields (lease_date, lease_type, status, notes) —
// included here so no field is homeless.
export const STANDARD_FIELD_GROUPS = [
  { key: "document_identity", label: "Document Identity", order: 1 },
  { key: "parties", label: "Parties", order: 2 },
  { key: "property_premises", label: "Property & Premises", order: 3 },
  { key: "term_dates", label: "Dates & Term", order: 4 },
  { key: "rent_charges", label: "Rent & Charges", order: 5 },
  { key: "expenses_recoveries", label: "Expenses / Recoveries", order: 6 },
  { key: "cam_rules", label: "CAM Rules", order: 7 },
  { key: "taxes", label: "Taxes", order: 8 },
  { key: "insurance", label: "Insurance", order: 9 },
  { key: "utilities", label: "Utilities", order: 10 },
  { key: "repairs_maintenance", label: "Repairs & Maintenance", order: 11 },
  { key: "legal_options", label: "Legal / Options", order: 12 },
  { key: "critical_dates", label: "Critical Dates", order: 13 },
  { key: "notices", label: "Notices", order: 14 },
  { key: "signatures", label: "Signatures", order: 15 },
  { key: "budget_inputs", label: "Budget Inputs", order: 16 },
  { key: "approval_controls", label: "Approval Controls", order: 17 },
];

export const LEASE_FIELD_CONTRACT = [
  // ── document_identity ──────────────────────────────────────────────────
  { canonicalKey: "lease_date", aliases: ["effective_date", "date_of_lease"], group: "document_identity", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "lease_type", aliases: [], group: "document_identity", requiredForApproval: false, requiredForCam: true, requiredForBudget: true, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "status", aliases: [], group: "document_identity", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: false, inLeaseSchema: true },
  { canonicalKey: "notes", aliases: [], group: "document_identity", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: false, inLeaseSchema: true },

  // ── parties ─────────────────────────────────────────────────────────────
  { canonicalKey: "tenant_name", aliases: ["tenant", "lessee", "occupant"], group: "parties", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["full_lease", "amendment"], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_name", aliases: ["landlord", "lessor", "owner_landlord"], group: "parties", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["full_lease"], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_signatory_name", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_signatory_name", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "broker_name", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "assignor_name", aliases: ["original_tenant", "transferor"], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["assignment", "assignment_amendment"], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "assignee_name", aliases: ["new_tenant", "transferee"], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["assignment", "assignment_amendment"], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_address", aliases: ["landlord_notice_address", "lessor_address"], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_address", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_contact_name", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_contact_phone", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── property_premises ──────────────────────────────────────────────────
  { canonicalKey: "property_address", aliases: [], group: "property_premises", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["full_lease", "amendment"], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["property_name"] },
  { canonicalKey: "property_name", aliases: [], group: "property_premises", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["property_address"] },
  { canonicalKey: "unit_number", aliases: ["unit", "suite", "space"], group: "property_premises", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "square_footage", aliases: ["tenant_rsf", "rentable_area_sqft"], group: "property_premises", requiredForApproval: true, requiredForCam: true, requiredForBudget: true, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "permitted_use", aliases: [], group: "property_premises", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── term_dates ──────────────────────────────────────────────────────────
  { canonicalKey: "start_date", aliases: [], group: "term_dates", requiredForApproval: true, requiredForCam: true, requiredForBudget: true, requiredByDocumentProfile: ["full_lease"], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["commencement_date"] },
  { canonicalKey: "end_date", aliases: [], group: "term_dates", requiredForApproval: true, requiredForCam: true, requiredForBudget: true, requiredByDocumentProfile: ["full_lease"], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["expiration_date"] },
  { canonicalKey: "commencement_date", aliases: [], group: "term_dates", requiredForApproval: true, requiredForCam: true, requiredForBudget: true, requiredByDocumentProfile: ["full_lease"], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["start_date"] },
  { canonicalKey: "expiration_date", aliases: [], group: "term_dates", requiredForApproval: true, requiredForCam: true, requiredForBudget: true, requiredByDocumentProfile: ["full_lease"], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["end_date"] },
  { canonicalKey: "rent_commencement_date", aliases: [], group: "term_dates", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "lease_term_months", aliases: [], group: "term_dates", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: false, inLeaseSchema: true },
  { canonicalKey: "assignment_effective_date", aliases: ["assignment_date"], group: "term_dates", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["assignment", "assignment_amendment"], evidenceRequired: true, inLeaseSchema: true },

  // ── rent_charges ────────────────────────────────────────────────────────
  { canonicalKey: "monthly_rent", aliases: ["base_rent_monthly", "base_rent"], group: "rent_charges", requiredForApproval: true, requiredForCam: false, requiredForBudget: true, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["annual_rent"] },
  { canonicalKey: "annual_rent", aliases: [], group: "rent_charges", requiredForApproval: true, requiredForCam: false, requiredForBudget: true, requiredByDocumentProfile: [], evidenceRequired: false, inLeaseSchema: true, alternateFieldKeys: ["monthly_rent"] },
  { canonicalKey: "rent_per_sf", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: true, requiredByDocumentProfile: [], evidenceRequired: false, inLeaseSchema: true },
  { canonicalKey: "billing_frequency", aliases: ["rent_frequency"], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: true, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "escalation_rate", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "escalation_type", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "escalation_timing", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "security_deposit", aliases: ["security_deposit_amount"], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "late_fee_amount", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "returned_payment_fee_amount", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "application_fee_amount", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "administrative_fee_amount", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "pet_fee_amount", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "pet_rent_amount", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "parking_fee_amount", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "ti_allowance", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "free_rent_months", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "assignment_consideration", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "amended_base_rent_for_additional_year", aliases: [], group: "rent_charges", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── expenses_recoveries ─────────────────────────────────────────────────
  { canonicalKey: "base_year", aliases: [], group: "expenses_recoveries", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "expense_stop", aliases: [], group: "expenses_recoveries", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── cam_rules ───────────────────────────────────────────────────────────
  { canonicalKey: "cam_amount", aliases: [], group: "cam_rules", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "cam_cap_type", aliases: [], group: "cam_rules", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "cam_cap_pct", aliases: [], group: "cam_rules", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "admin_fee_pct", aliases: [], group: "cam_rules", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "management_fee_basis", aliases: [], group: "cam_rules", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "gross_up_enabled", aliases: [], group: "cam_rules", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "gross_up_threshold", aliases: [], group: "cam_rules", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── taxes ───────────────────────────────────────────────────────────────
  { canonicalKey: "tax_responsibility", aliases: [], group: "taxes", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["responsibility_taxes"], preferredForAutomatedLogic: "responsibility_taxes" },
  { canonicalKey: "responsibility_taxes", aliases: ["responsibility_taxes"], group: "taxes", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["tax_responsibility"] },

  // ── insurance ───────────────────────────────────────────────────────────
  { canonicalKey: "insurance_responsibility", aliases: [], group: "insurance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["responsibility_insurance"], preferredForAutomatedLogic: "responsibility_insurance" },
  { canonicalKey: "responsibility_insurance", aliases: ["responsibility_insurance"], group: "insurance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["insurance_responsibility"] },
  { canonicalKey: "property_insurance_responsibility", aliases: [], group: "insurance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_insurance_required", aliases: [], group: "insurance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "general_liability_min", aliases: [], group: "insurance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "waiver_of_subrogation", aliases: [], group: "insurance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "additional_insureds_required", aliases: [], group: "insurance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── utilities ───────────────────────────────────────────────────────────
  { canonicalKey: "responsibility_utilities", aliases: [], group: "utilities", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "electric_responsibility", aliases: [], group: "utilities", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "water_sewer_responsibility", aliases: [], group: "utilities", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "utility_reimbursement_amount", aliases: [], group: "utilities", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "water_sewer_reimbursement_amount", aliases: [], group: "utilities", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── repairs_maintenance ─────────────────────────────────────────────────
  { canonicalKey: "responsibility_repairs", aliases: [], group: "repairs_maintenance", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "hvac_responsibility", aliases: [], group: "repairs_maintenance", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── legal_options ───────────────────────────────────────────────────────
  { canonicalKey: "renewal_options", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "renewal_type", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "right_of_first_refusal", aliases: ["rofr"], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "early_termination_option", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "assignment_provisions", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "default_cure_period", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_consent", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["assignment", "assignment_amendment"], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "assumption_scope", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "all_other_terms_remain_same", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["amendment", "assignment_amendment"], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_consent_for_transfer", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["assignment", "assignment_amendment"], evidenceRequired: true, inLeaseSchema: true },

  // ── critical_dates ──────────────────────────────────────────────────────
  { canonicalKey: "option_exercise_deadline", aliases: [], group: "critical_dates", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── notices ─────────────────────────────────────────────────────────────
  { canonicalKey: "renewal_notice_months", aliases: [], group: "notices", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "termination_notice_months", aliases: [], group: "notices", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "assignee_notice_address", aliases: [], group: "notices", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── signatures ──────────────────────────────────────────────────────────
  { canonicalKey: "tenant_signature_date", aliases: [], group: "signatures", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_signature_date", aliases: [], group: "signatures", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── budget_inputs (gap fields) ────────────────────────────────────────
  { canonicalKey: "building_rsf", aliases: ["building_square_footage"], group: "budget_inputs", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_pro_rata_share", aliases: [], group: "budget_inputs", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: false, inLeaseSchema: false, computed: true },

  // ── approval_controls (row-level, not LEASE_SCHEMA fields) ───────────────
  { canonicalKey: "document_profile", aliases: [], group: "approval_controls", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["full_lease", "assignment", "amendment", "assignment_amendment", "abstract", "addendum", "exhibit"], evidenceRequired: false, inLeaseSchema: false },
  { canonicalKey: "approval_status", aliases: ["review_status", "abstract_status"], group: "approval_controls", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["full_lease", "assignment", "amendment", "assignment_amendment", "abstract", "addendum", "exhibit"], evidenceRequired: false, inLeaseSchema: false },
];

function titleizeCanonicalKey(key) {
  return String(key || "")
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

const _aliasIndex = new Map();
const _contractIndex = new Map();
for (const entry of LEASE_FIELD_CONTRACT) {
  _aliasIndex.set(entry.canonicalKey, entry.canonicalKey);
  for (const alias of entry.aliases) {
    _aliasIndex.set(alias, entry.canonicalKey);
  }
  _contractIndex.set(entry.canonicalKey, { ...entry, label: titleizeCanonicalKey(entry.canonicalKey) });
}

/** Resolve an alias (or the canonical key itself) to its canonical LEASE_SCHEMA
 *  key. Returns the input unchanged if it isn't a known alias or canonical
 *  key — callers should treat that as "not in the contract yet", not an error. */
export function resolveCanonicalFieldKey(aliasOrKey) {
  return _aliasIndex.get(aliasOrKey) ?? aliasOrKey;
}

export function getFieldContract(aliasOrKey) {
  return _contractIndex.get(resolveCanonicalFieldKey(aliasOrKey));
}

export function getFieldsForGroup(group) {
  return LEASE_FIELD_CONTRACT
    .filter((entry) => entry.group === group)
    .map((entry) => _contractIndex.get(entry.canonicalKey));
}

/** Convenience: the group a field key (or its alias) belongs to, or null if
 *  the key isn't in the contract. */
export function getFieldGroup(aliasOrKey) {
  return getFieldContract(aliasOrKey)?.group ?? null;
}
