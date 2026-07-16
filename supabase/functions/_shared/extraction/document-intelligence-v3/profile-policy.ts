// @ts-nocheck
/**
 * Document Intelligence v3 - Profile-Aware Policy Registry.
 *
 * Profiles are policy overlays, not separate UI structures and not approval
 * gates. Readiness and planning diagnostics consume this registry; Lease
 * Review business rows and approval workflow do not.
 */

export interface DocumentIntelligenceV3ProfilePolicy {
  policy_key: string;
  profile_status: "recognized" | "needs_review" | "not_applicable";
  required_fields: string[];
  /** Required only if a projection row exists for the field. */
  required_if_present_fields: string[];
  advisory_fields: string[];
  advisory_message: string | null;
  relevance: string[];
  skipped_modules: Array<{ module_key: string; reason: string }>;
  related_documents_needed: string[];
  planner_warnings: string[];
  expected_information_profile: string[];
}

function policy(input: Partial<DocumentIntelligenceV3ProfilePolicy> & { policy_key: string }): DocumentIntelligenceV3ProfilePolicy {
  return {
    policy_key: input.policy_key,
    profile_status: input.profile_status ?? "recognized",
    required_fields: input.required_fields ?? [],
    required_if_present_fields: input.required_if_present_fields ?? [],
    advisory_fields: input.advisory_fields ?? [],
    advisory_message: input.advisory_message ?? null,
    relevance: input.relevance ?? [],
    skipped_modules: input.skipped_modules ?? [],
    related_documents_needed: input.related_documents_needed ?? [],
    planner_warnings: input.planner_warnings ?? [],
    expected_information_profile: input.expected_information_profile ?? [],
  };
}

const BASE_LEASE_REQUIRED = [
  "tenant_name",
  "landlord_name",
  "property_address",
  "square_footage",
  "commencement_date",
  "expiration_date",
  "monthly_rent",
  "lease_type",
  "expense_structure",
];

const ORIGINAL_LEASE_ADVISORY_FIELDS = [
  "monthly_rent",
  "annual_rent",
  "lease_type",
  "expense_structure",
  "cam_amount",
  "cam_cap_pct",
  "responsibility_insurance",
  "responsibility_utilities",
  "responsibility_repairs",
  "building_rsf",
];

const ORIGINAL_LEASE_MESSAGE = "Original lease required for CAM, expense recovery, and full budget setup.";

const FULL_LEASE_SKIPPED: Array<{ module_key: string; reason: string }> = [];
const ORIGINAL_LEASE_SKIPPED = [
  { module_key: "expense_recovery", reason: "original_lease_required" },
  { module_key: "cam_rules", reason: "original_lease_required" },
  { module_key: "taxes", reason: "original_lease_required" },
  { module_key: "insurance", reason: "original_lease_required" },
  { module_key: "utilities", reason: "original_lease_required" },
  { module_key: "repairs_maintenance", reason: "original_lease_required" },
  { module_key: "money_and_schedules", reason: "original_lease_required_for_full_budget" },
];

const PROFILE_POLICIES: Record<string, DocumentIntelligenceV3ProfilePolicy> = {
  base_lease: policy({
    policy_key: "base_lease",
    required_fields: BASE_LEASE_REQUIRED,
    relevance: ["lease_abstract", "budget", "cam", "expense_rules", "revenue"],
    skipped_modules: FULL_LEASE_SKIPPED,
    expected_information_profile: ["full lease economics", "premises", "term", "rent", "recoveries", "clauses"],
  }),

  lease_amendment: policy({
    policy_key: "lease_amendment",
    required_fields: ["document_type", "landlord_name", "tenant_name", "original_lease_date", "amendment_effective_date"],
    required_if_present_fields: ["all_other_terms_remain_same", "tenant_signature_date", "landlord_signature_date"],
    advisory_fields: ORIGINAL_LEASE_ADVISORY_FIELDS,
    advisory_message: ORIGINAL_LEASE_MESSAGE,
    relevance: ["amendment_terms", "dates", "parties", "references"],
    skipped_modules: ORIGINAL_LEASE_SKIPPED,
    related_documents_needed: ["original_lease"],
    planner_warnings: ["Original lease may be required to interpret unchanged economics and obligations."],
    expected_information_profile: ["changed lease terms", "effective dates", "references", "signatures"],
  }),

  lease_assignment: policy({
    policy_key: "lease_assignment",
    required_fields: ["document_type", "assignment_effective_date", "assignor_name", "assignee_name", "original_lease_date", "property_address"],
    required_if_present_fields: ["landlord_consent", "tenant_signature_date", "landlord_signature_date"],
    advisory_fields: ORIGINAL_LEASE_ADVISORY_FIELDS,
    advisory_message: ORIGINAL_LEASE_MESSAGE,
    relevance: ["assignment_terms", "consent", "parties", "references"],
    skipped_modules: ORIGINAL_LEASE_SKIPPED,
    related_documents_needed: ["original_lease"],
    planner_warnings: ["Assignment-only document should not be treated as a base lease."],
    expected_information_profile: ["assignor", "assignee", "assignment effective date", "assumed obligations"],
  }),

  assignment_assumption: policy({
    policy_key: "assignment_assumption",
    required_fields: [
      "document_type",
      "assignment_effective_date",
      "landlord_name",
      "assignor_name",
      "assignee_name",
      "original_lease_date",
      "property_address",
      "landlord_consent",
      "assumption_scope",
      "assignee_notice_address",
    ],
    required_if_present_fields: ["tenant_signature_date", "landlord_signature_date"],
    advisory_fields: ORIGINAL_LEASE_ADVISORY_FIELDS,
    advisory_message: ORIGINAL_LEASE_MESSAGE,
    relevance: ["assignment_terms", "consent", "parties", "references"],
    skipped_modules: ORIGINAL_LEASE_SKIPPED,
    related_documents_needed: ["original_lease"],
    planner_warnings: ["CAM and full budget modules are advisory until original lease is available."],
    expected_information_profile: ["assignment terms", "assumption scope", "consent", "notice addresses"],
  }),

  assignment_assumption_amendment: policy({
    policy_key: "assignment_assumption_amendment",
    required_fields: [
      "document_type",
      "assignment_effective_date",
      "landlord_name",
      "assignor_name",
      "assignee_name",
      "original_lease_date",
      "property_address",
      "square_footage",
      "landlord_consent",
      "assumption_scope",
      "all_other_terms_remain_same",
      "assignee_notice_address",
    ],
    required_if_present_fields: ["tenant_signature_date", "landlord_signature_date"],
    advisory_fields: ORIGINAL_LEASE_ADVISORY_FIELDS,
    advisory_message: ORIGINAL_LEASE_MESSAGE,
    relevance: ["assignment_terms", "amendment_terms", "consent", "parties", "references"],
    skipped_modules: ORIGINAL_LEASE_SKIPPED,
    related_documents_needed: ["original_lease"],
    planner_warnings: ["Document combines assignment and amendment terms; unchanged economics require original lease."],
    expected_information_profile: ["assignment terms", "amendment terms", "assumption scope", "consent", "notice addresses"],
  }),

  renewal_amendment: policy({
    policy_key: "renewal_amendment",
    required_fields: ["document_type", "landlord_name", "tenant_name", "renewal_term", "renewal_effective_date"],
    required_if_present_fields: ["monthly_rent", "expiration_date", "tenant_signature_date", "landlord_signature_date"],
    advisory_fields: ORIGINAL_LEASE_ADVISORY_FIELDS,
    advisory_message: "Original lease may be required to validate renewal rights and economic changes.",
    relevance: ["renewal_terms", "dates", "rent"],
    skipped_modules: [{ module_key: "cam_rules", reason: "original_lease_required" }],
    related_documents_needed: ["original_lease"],
    expected_information_profile: ["renewal term", "renewal dates", "rent changes", "option references"],
  }),

  termination_agreement: policy({
    policy_key: "termination_agreement",
    required_fields: ["document_type", "landlord_name", "tenant_name", "termination_date"],
    required_if_present_fields: ["surrender_date", "termination_fee", "tenant_signature_date", "landlord_signature_date"],
    advisory_fields: ["original_lease_date", "property_address"],
    advisory_message: "Original lease may be required to validate termination obligations.",
    relevance: ["termination_terms", "dates", "risk"],
    related_documents_needed: ["original_lease"],
    expected_information_profile: ["termination date", "surrender obligations", "fees", "releases"],
  }),

  guaranty: policy({
    policy_key: "guaranty",
    required_fields: ["document_type", "guarantor_name", "tenant_name", "landlord_name"],
    required_if_present_fields: ["guaranty_scope", "tenant_signature_date"],
    advisory_fields: ["original_lease_date", "property_address"],
    relevance: ["parties", "risk", "references"],
    related_documents_needed: ["original_lease"],
    expected_information_profile: ["guarantor", "guaranteed obligations", "limitations", "signatures"],
  }),

  snda: policy({
    policy_key: "snda",
    required_fields: ["document_type", "tenant_name", "landlord_name"],
    required_if_present_fields: ["lender_name", "original_lease_date", "tenant_signature_date"],
    advisory_fields: ["property_address"],
    relevance: ["parties", "subordination", "non_disturbance", "attornment"],
    expected_information_profile: ["lender", "tenant", "attornment", "notice requirements"],
  }),

  estoppel: policy({
    policy_key: "estoppel",
    required_fields: ["document_type", "tenant_name", "landlord_name", "property_address"],
    required_if_present_fields: ["monthly_rent", "commencement_date", "expiration_date", "tenant_signature_date"],
    advisory_fields: ["security_deposit", "defaults", "options"],
    relevance: ["certifications", "dates", "rent", "defaults"],
    expected_information_profile: ["certified lease facts", "defaults", "rent", "term", "options"],
  }),

  commencement_letter: policy({
    policy_key: "commencement_letter",
    required_fields: ["document_type", "tenant_name", "landlord_name", "commencement_date"],
    required_if_present_fields: ["expiration_date", "rent_commencement_date", "tenant_signature_date"],
    advisory_fields: ["property_address", "square_footage"],
    relevance: ["dates", "events", "signatures"],
    expected_information_profile: ["confirmed commencement", "rent commencement", "expiration"],
  }),

  side_letter: policy({
    policy_key: "side_letter",
    required_fields: ["document_type", "landlord_name", "tenant_name"],
    required_if_present_fields: ["effective_date", "tenant_signature_date", "landlord_signature_date"],
    advisory_fields: ["original_lease_date", "property_address"],
    relevance: ["clauses", "risk", "references"],
    related_documents_needed: ["original_lease"],
    expected_information_profile: ["side agreement terms", "effective date", "referenced lease"],
  }),

  notice: policy({
    policy_key: "notice",
    required_fields: ["document_type", "notice_date"],
    required_if_present_fields: ["sender_name", "recipient_name", "property_address"],
    advisory_fields: ["original_lease_date"],
    relevance: ["notices", "dates", "risk"],
    expected_information_profile: ["notice date", "sender", "recipient", "required action"],
  }),

  exhibit: policy({
    policy_key: "exhibit",
    required_fields: ["document_type"],
    required_if_present_fields: ["property_address", "square_footage"],
    advisory_fields: ["original_lease_date"],
    relevance: ["references", "clauses", "premises"],
    related_documents_needed: ["parent_document"],
    expected_information_profile: ["exhibit label", "referenced lease", "attached terms or plans"],
  }),

  work_letter: policy({
    policy_key: "work_letter",
    required_fields: ["document_type", "tenant_name", "landlord_name"],
    required_if_present_fields: ["allowance_amount", "substantial_completion_date", "tenant_signature_date"],
    advisory_fields: ["property_address", "original_lease_date"],
    relevance: ["repairs_maintenance", "money", "dates", "risk"],
    related_documents_needed: ["original_lease"],
    expected_information_profile: ["tenant improvements", "allowance", "completion dates", "work obligations"],
  }),

  rules_regulations: policy({
    policy_key: "rules_regulations",
    required_fields: ["document_type"],
    required_if_present_fields: ["property_address"],
    advisory_fields: ["original_lease_date"],
    relevance: ["clauses", "risk", "operational_rules"],
    related_documents_needed: ["original_lease"],
    expected_information_profile: ["rules", "restrictions", "building operations"],
  }),

  unknown_cre_document: policy({
    policy_key: "unknown_cre_document",
    profile_status: "needs_review",
    advisory_message: "Document type needs review before final approval rules can be applied.",
    relevance: ["discovery"],
    planner_warnings: ["Document profile is unknown; discovery modules only."],
    expected_information_profile: ["document identity", "profile discovery", "risk signals"],
  }),

  non_cre_document: policy({
    policy_key: "non_cre_document",
    profile_status: "not_applicable",
    advisory_message: "Document does not appear to be a CRE lease document.",
    relevance: ["not_applicable"],
    planner_warnings: ["Non-CRE document; extraction plan is not applicable."],
    expected_information_profile: ["not applicable"],
  }),
};

const PROFILE_ALIASES: Record<string, string> = {
  full_lease: "base_lease",
  lease: "base_lease",
  base: "base_lease",
  assignment: "assignment_assumption",
  assignment_amendment: "assignment_assumption_amendment",
  amendment: "lease_amendment",
  addendum: "side_letter",
  consent: "assignment_assumption",
  abstract: "unknown_cre_document",
};

export function normalizeProfileKey(rawProfileKey: string | null | undefined): string {
  if (!rawProfileKey) return "unknown_cre_document";
  const normalized = String(rawProfileKey).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return "unknown_cre_document";
  if (PROFILE_POLICIES[normalized]) return normalized;
  return PROFILE_ALIASES[normalized] ?? "unknown_cre_document";
}

export function resolvePolicyKey(rawProfileKey: string | null | undefined): string {
  return normalizeProfileKey(rawProfileKey);
}

export function getProfilePolicy(rawProfileKey: string | null | undefined): DocumentIntelligenceV3ProfilePolicy {
  const key = resolvePolicyKey(rawProfileKey);
  return PROFILE_POLICIES[key] ?? PROFILE_POLICIES.unknown_cre_document;
}

export function listProfilePolicyKeys(): string[] {
  return Object.keys(PROFILE_POLICIES);
}
