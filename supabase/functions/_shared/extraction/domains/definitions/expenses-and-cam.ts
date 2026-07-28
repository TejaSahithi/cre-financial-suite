// @ts-nocheck
import type { ExtractionDomainDefinition } from "../domain-definition.ts";

export const expensesAndCamDomain = {
  id: "expenses_and_cam",
  enabled: true,
  authorityMode: "authoritative",
  domainFamily: "core",
  executionOrder: 2,
  promptVersion: "expenses-and-cam-v1",
  // This domain carries the widest concept spread of the five (4 distinct
  // sub-areas -- expense recovery, CAM, taxes, insurance -- covering 23
  // schema fields, more than any domain except core_terms). Listed as 4
  // explicit, separately-labeled checklists rather than one paragraph
  // specifically so the model cannot silently satisfy "CAM" and stop
  // reading before reaching taxes/insurance later in the excerpt -- the
  // flat single-paragraph version of this concept list was the confirmed
  // cause of expense/CAM/tax fields under-recalling relative to other
  // domains.
  promptConcepts:
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
  schemaName: "expenses_and_cam_v1",
  schemaVersion: "expenses-and-cam-v1",
  // Lower than the other domains -- CAM/expense/tax/insurance/utility
  // clauses are often indirect (see routeSectionsMultiLabel's own
  // DOMAIN_THRESHOLDS comment, section-router.ts).
  routingThreshold: 2,
  maximumEvidenceCharacters: 60000,
  maximumOutputTokens: 16384,
  criticalFields: [],
  dependencies: [],
  evidenceSourceDomains: [],
  shadowRunsAfter: [],
  boundedEnrichStageName: "enrich_evidence_expenses_and_cam",
  participatesInBoundedEnrichment: true,
} as const satisfies ExtractionDomainDefinition;
