// @ts-nocheck
import type { ExtractionDomainDefinition } from "../domain-definition.ts";

export const rentAndChargesDomain = {
  id: "rent_and_charges",
  enabled: true,
  authorityMode: "authoritative",
  domainFamily: "core",
  executionOrder: 1,
  promptVersion: "rent-and-charges-v1",
  promptConcepts:
    "monthly base rent amount, annual base rent amount, security deposit amount, late fee amount, " +
    "rent escalation rate/type, billing frequency -- NEVER additional rent, CAM, reimbursements, or " +
    "amortized charges as if they were base rent",
  schemaName: null,
  schemaVersion: null,
  routingThreshold: 3,
  maximumEvidenceCharacters: 60000,
  maximumOutputTokens: 16384,
  criticalFields: ["monthly_rent"],
  dependencies: [],
  evidenceSourceDomains: [],
  shadowRunsAfter: [],
  boundedEnrichStageName: "enrich_evidence_rent_and_charges",
  participatesInBoundedEnrichment: true,
} as const satisfies ExtractionDomainDefinition;
