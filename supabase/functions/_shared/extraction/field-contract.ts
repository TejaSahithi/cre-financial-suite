// @ts-nocheck
/**
 * Lease Field Contract — the machine-readable form of docs/lease-standard-field-model.md.
 *
 * This is the single source of truth for "what does this field key actually
 * mean, and what other names does it go by across the codebase's three
 * overlapping vocabularies" (LEASE_SCHEMA, lease-workflow.ts's FIELD_SPECS,
 * and buildBudgetHandoffReadiness()'s own budgetFieldKeys list).
 *
 * Two distinct relationships are modeled, and they are NOT the same thing:
 *   - `aliases`: a different vocabulary's name for the exact same LEASE_SCHEMA
 *     field (e.g. "base_rent_monthly" is what budgetFieldKeys/FIELD_SPECS call
 *     monthly_rent — same field, different name).
 *   - `alternateFieldKeys`: a DIFFERENT, independently-extracted LEASE_SCHEMA
 *     field that satisfies the same real-world fact as an OR-alternate (e.g.
 *     start_date and commencement_date are two distinct schema fields with
 *     their own labels/patterns; either one satisfies core-readiness).
 *     Do not conflate the two — resolveCanonicalKey() only follows `aliases`.
 *
 * Inert on creation: nothing imports this file yet. See
 * supabase/functions/_shared/extraction/openai-fact-ledger/fact-field-mapper.ts
 * for the first real consumer (Phase 3).
 */

export type FieldGroup =
  | "document_identity"
  | "parties"
  | "property_premises"
  | "term_dates"
  | "rent_charges"
  | "expenses_recoveries"
  | "cam_rules"
  | "taxes"
  | "insurance"
  | "utilities"
  | "repairs_maintenance"
  | "legal_options"
  | "critical_dates"
  | "notices"
  | "signatures"
  | "budget_inputs"
  | "approval_controls";

export type DocumentProfileName =
  | "full_lease"
  | "assignment"
  | "amendment"
  | "assignment_amendment"
  | "abstract"
  | "addendum"
  | "exhibit";

export interface FieldContractEntry {
  canonicalKey: string;
  /** Other vocabularies' names for this exact same field. */
  aliases: string[];
  /** Different, independently-extracted fields that satisfy the same
   *  real-world fact as an OR-alternate (core-readiness style). */
  alternateFieldKeys?: string[];
  group: FieldGroup;
  requiredForApproval: boolean;
  requiredForCam: boolean;
  requiredForBudget: boolean;
  /** [] means advisory-only in every profile today. */
  requiredByDocumentProfile: DocumentProfileName[];
  evidenceRequired: boolean;
  /** false only for the still-unhomed gap fields. */
  inLeaseSchema: boolean;
  /** true for fields that are always calculator-derived, never themselves
   *  a direct extraction target (e.g. tenant_pro_rata_share). */
  computed?: boolean;
  /** For duplicate-concept pairs (e.g. tax_responsibility vs.
   *  responsibility_taxes): which key CAM/automated logic should read first
   *  when both are populated. Naming/canonical choice is independent of
   *  this — it only affects read order for code, not display labels. */
  preferredForAutomatedLogic?: string;
}

export const LEASE_FIELD_CONTRACT: FieldContractEntry[] = [
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
  // responsibility_taxes' LEASE_SCHEMA labels ("real estate taxes", "property
  // taxes", "taxes") are a strict subset of tax_responsibility's own labels
  // (which also include "tax responsibility"), so without a distinguishing
  // alias here, fact-field-mapper.ts's per-fact best-field scoring could
  // never let responsibility_taxes win a tie — tax_responsibility, defined
  // earlier in LEASE_SCHEMA, always wins ties on equal score. The
  // self-referential alias below (normalized to "responsibility taxes" by
  // scoreFactAgainstField) gives structured/tabular-style source text
  // ("Responsibility Taxes: ...") a real path to the enum field specifically.
  { canonicalKey: "tax_responsibility", aliases: [], group: "taxes", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["responsibility_taxes"], preferredForAutomatedLogic: "responsibility_taxes" },
  { canonicalKey: "responsibility_taxes", aliases: ["responsibility_taxes"], group: "taxes", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true, alternateFieldKeys: ["tax_responsibility"] },

  // ── insurance ───────────────────────────────────────────────────────────
  // Same overlapping-labels issue as tax_responsibility/responsibility_taxes
  // above — see that comment.
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

  // ── critical_dates ──────────────────────────────────────────────────────
  { canonicalKey: "option_exercise_deadline", aliases: [], group: "critical_dates", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── notices ─────────────────────────────────────────────────────────────
  { canonicalKey: "renewal_notice_months", aliases: [], group: "notices", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "termination_notice_months", aliases: [], group: "notices", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "assignee_notice_address", aliases: [], group: "notices", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── signatures ──────────────────────────────────────────────────────────
  { canonicalKey: "tenant_signature_date", aliases: [], group: "signatures", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_signature_date", aliases: [], group: "signatures", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },

  // ── budget_inputs (gap fields — added to LEASE_SCHEMA in Phase 2) ────────
  { canonicalKey: "building_rsf", aliases: ["building_square_footage"], group: "budget_inputs", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_pro_rata_share", aliases: [], group: "budget_inputs", requiredForApproval: false, requiredForCam: true, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: false, inLeaseSchema: false, computed: true },

  // ── approval_controls (row-level, not LEASE_SCHEMA fields) ───────────────
  { canonicalKey: "document_profile", aliases: [], group: "approval_controls", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["full_lease", "assignment", "amendment", "assignment_amendment", "abstract", "addendum", "exhibit"], evidenceRequired: false, inLeaseSchema: false },
  { canonicalKey: "approval_status", aliases: ["review_status", "abstract_status"], group: "approval_controls", requiredForApproval: true, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["full_lease", "assignment", "amendment", "assignment_amendment", "abstract", "addendum", "exhibit"], evidenceRequired: false, inLeaseSchema: false },

  // ── gap fields added to LEASE_SCHEMA in Phase 2 (contact/address/consent) ─
  { canonicalKey: "landlord_address", aliases: ["landlord_notice_address", "lessor_address"], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_address", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_contact_name", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "tenant_contact_phone", aliases: [], group: "parties", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: [], evidenceRequired: true, inLeaseSchema: true },
  { canonicalKey: "landlord_consent_for_transfer", aliases: [], group: "legal_options", requiredForApproval: false, requiredForCam: false, requiredForBudget: false, requiredByDocumentProfile: ["assignment", "assignment_amendment"], evidenceRequired: true, inLeaseSchema: true },
];

const _aliasIndex = new Map<string, string>();
for (const entry of LEASE_FIELD_CONTRACT) {
  _aliasIndex.set(entry.canonicalKey, entry.canonicalKey);
  for (const alias of entry.aliases) {
    _aliasIndex.set(alias, entry.canonicalKey);
  }
}

/** Resolve an alias (or the canonical key itself) to its canonical LEASE_SCHEMA key.
 *  Returns the input unchanged if it isn't a known alias or canonical key —
 *  callers should treat that as "not in the contract yet", not an error. */
export function resolveCanonicalKey(aliasOrKey: string): string {
  return _aliasIndex.get(aliasOrKey) ?? aliasOrKey;
}

const _contractIndex = new Map<string, FieldContractEntry>();
for (const entry of LEASE_FIELD_CONTRACT) {
  _contractIndex.set(entry.canonicalKey, entry);
}

export function getFieldContract(aliasOrKey: string): FieldContractEntry | undefined {
  return _contractIndex.get(resolveCanonicalKey(aliasOrKey));
}

export function getFieldsForGroup(group: FieldGroup): FieldContractEntry[] {
  return LEASE_FIELD_CONTRACT.filter((entry) => entry.group === group);
}
