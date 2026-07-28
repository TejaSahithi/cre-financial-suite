// @ts-nocheck
/**
 * Frozen compatibility contract for the domain registry refactor (Phase 4).
 *
 * Every value below is a VERBATIM copy of what existed in the real source
 * files (adaptive-extractor.ts's DOMAIN_CONCEPTS, domain-readiness.ts's
 * CRITICAL_FIELDS_BY_DOMAIN, section-router.ts's DOMAIN_THRESHOLDS,
 * enrich-bounded-stage/stage-sequence.ts's ENRICH_STAGE_SEQUENCE /
 * ENRICH_EVIDENCE_DOMAIN_STAGES, normalize-pdf-output/index.ts's
 * STAGE_TO_LLM_CALL_DOMAIN) BEFORE the registry refactor touched them,
 * copied here on the same day the refactor happened. This is a TEST-ONLY
 * compatibility snapshot, not a second runtime configuration -- nothing in
 * the actual pipeline reads this file. Its only purpose is to give
 * domain-registry-byte-compatibility.test.ts something real and independent
 * to diff the new registry against, since the originals are gone once the
 * refactor deletes them. Do not "clean up" or normalize anything here to
 * match the new registry -- if the registry and this file disagree, the
 * registry is wrong, not this file.
 */

export const LEGACY_DOMAIN_IDS = [
  "core_terms",
  "rent_and_charges",
  "expenses_and_cam",
  "operating_obligations",
  "legal_rights_and_dates",
] as const;

export const LEGACY_CRITICAL_FIELDS: Record<string, string[]> = {
  core_terms: ["tenant_name", "landlord_name", "commencement_date", "expiration_date", "square_footage"],
  rent_and_charges: ["monthly_rent"],
  expenses_and_cam: [],
  operating_obligations: ["responsibility_repairs"],
  legal_rights_and_dates: [],
};

export const LEGACY_PROMPT_CONCEPTS: Record<string, string> = {
  core_terms:
    "tenant legal name, landlord legal name, property/premises address, unit or suite number, " +
    "rentable square footage, lease commencement date, lease expiration date, lease term length",
  rent_and_charges:
    "monthly base rent amount, annual base rent amount, security deposit amount, late fee amount, " +
    "rent escalation rate/type, billing frequency -- NEVER additional rent, CAM, reimbursements, or " +
    "amortized charges as if they were base rent",
  expenses_and_cam:
    "FOUR separate sub-areas -- treat each as its own checklist, do not stop after finding one:\n" +
    "  (1) EXPENSE RECOVERY / CAM: recovery structure (net/gross/modified gross), CAM amount, " +
    "base year, expense stop, cap type and percentage, admin/management fee basis and percentage, " +
    "gross-up provisions and threshold.\n" +
    "  (2) TAXES: who is responsible for real-estate/property tax (tenant/landlord/shared), any " +
    "tax-specific cap or base year distinct from the general CAM one.\n" +
    "  (3) INSURANCE: who is responsible for the insurance premium/cost (distinct from who is " +
    "required to CARRY a policy), minimum general liability coverage amount, whether tenant " +
    "insurance is required, additional-insured requirements, waiver of subrogation.\n" +
    "  (4) UTILITY/REIMBURSEMENT CHARGES: electric, water/sewer, and other utility responsibility " +
    "and reimbursement amounts.\n" +
    "Report the NORMALIZED responsibility answer (tenant/landlord/shared) for each responsibility " +
    "field, with the supporting clause as evidence. A lease's expense/CAM/tax/insurance terms are " +
    "very often stated across SEVERAL separate paragraphs or an exhibit, not one -- read the ENTIRE " +
    "excerpt for each of the four sub-areas above, not just the first paragraph that matches one.",
  operating_obligations:
    "repair and maintenance responsibility (structural, HVAC, interior, exterior) and utility " +
    "payment responsibility -- distinguish who PAYS for a utility/system from who merely maintains " +
    "or repairs it; a repair-only clause does not by itself establish payment responsibility",
  legal_rights_and_dates:
    "renewal/extension options, right of first refusal or offer, early termination rights, " +
    "termination or renewal notice periods -- only an actual GRANT of a right, never a heading, " +
    "defined term, guaranty recital, or surrender/holdover/default clause",
};

export const LEGACY_ROUTING_THRESHOLDS: Record<string, number> = {
  core_terms: 3,
  rent_and_charges: 3,
  expenses_and_cam: 2,
  operating_obligations: 3,
  legal_rights_and_dates: 3,
};

export const LEGACY_STAGE_TO_LLM_CALL_DOMAIN: Record<string, string> = {
  enrich_evidence_core_terms: "core_terms",
  enrich_evidence_rent_and_charges: "rent_and_charges",
  enrich_evidence_expenses_and_cam: "expenses_and_cam",
  enrich_evidence_operating_obligations: "operating_obligations",
  enrich_evidence_legal_rights_and_dates: "legal_rights_and_dates",
};

export const LEGACY_ENRICH_EVIDENCE_DOMAIN_STAGES = [
  "enrich_evidence_core_terms",
  "enrich_evidence_rent_and_charges",
  "enrich_evidence_expenses_and_cam",
  "enrich_evidence_operating_obligations",
  "enrich_evidence_legal_rights_and_dates",
] as const;

export const LEGACY_ENRICH_STAGE_SEQUENCE = [
  "enrich_clauses",
  "enrich_fields",
  "enrich_items",
  "enrich_derivation",
  "enrich_evidence_core_terms",
  "enrich_evidence_rent_and_charges",
  "enrich_evidence_expenses_and_cam",
  "enrich_evidence_operating_obligations",
  "enrich_evidence_legal_rights_and_dates",
  "enrich_truth_assembly",
] as const;
