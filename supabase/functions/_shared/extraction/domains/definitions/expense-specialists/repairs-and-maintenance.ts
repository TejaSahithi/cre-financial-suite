// @ts-nocheck
import type { ExtractionDomainDefinition } from "../../domain-definition.ts";

export const repairsAndMaintenanceDomain = {
  id: "repairs_and_maintenance",
  enabled: false,
  authorityMode: "shadow",
  domainFamily: "expense_specialist",
  executionOrder: 34,
  promptVersion: "repairs-and-maintenance-specialist-v1",
  promptConcepts:
    "Return ONE obligation per component actually named in the evidence: interior, structure, " +
    "roof, HVAC, common areas, parking, capital replacements, code compliance. Do not collapse " +
    "a sentence splitting responsibility across several components (e.g. \"tenant maintains " +
    "interior and HVAC; landlord maintains roof, structure, and common areas\") into one " +
    "generic result -- each named component gets its own obligation with its own responsibleParty.",
  schemaName: "repair_obligation_v1",
  schemaVersion: "repair-obligation-v1",
  routingThreshold: 1,
  maximumEvidenceCharacters: 24_000,
  maximumOutputTokens: 4_000,
  criticalFields: [],
  dependencies: [],
  evidenceSourceDomains: ["operating_obligations"],
  shadowRunsAfter: ["operating_obligations"],
  participatesInBoundedEnrichment: false,
  boundedEnrichStageName: null,
} as const satisfies ExtractionDomainDefinition;
