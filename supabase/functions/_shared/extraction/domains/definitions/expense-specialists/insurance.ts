// @ts-nocheck
import type { ExtractionDomainDefinition } from "../../domain-definition.ts";

export const insuranceDomain = {
  id: "insurance",
  enabled: false,
  authorityMode: "shadow",
  domainFamily: "expense_specialist",
  executionOrder: 32,
  promptVersion: "insurance-specialist-v1",
  promptConcepts:
    "Coverage type (building / tenant_property / leasehold_improvements / commercial_general_liability " +
    "/ business_interruption / workers_compensation / other), obligated party, obligation type " +
    "(must_insure / may_insure / must_reimburse / included_service / waiver), and economic " +
    "treatment (direct_cost / included_in_rent / operating_expense_pass_through / reimbursement). " +
    "CRITICAL RULE: \"Rent includes property insurance\" establishes included_in_rent economic " +
    "treatment. It does NOT, by itself, establish that the landlord is the sole legally " +
    "responsible party -- if the clause does not separately state who is responsible, " +
    "obligatedParty must be not_stated or conditional, never guessed as landlord.",
  schemaName: "insurance_obligation_v1",
  schemaVersion: "insurance-obligation-v1",
  routingThreshold: 1,
  maximumEvidenceCharacters: 24_000,
  maximumOutputTokens: 4_000,
  criticalFields: [],
  dependencies: [],
  evidenceSourceDomains: ["expenses_and_cam"],
  shadowRunsAfter: ["expenses_and_cam"],
  participatesInBoundedEnrichment: false,
  boundedEnrichStageName: null,
} as const satisfies ExtractionDomainDefinition;
