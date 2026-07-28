// @ts-nocheck
import type { ExtractionDomainDefinition } from "../../domain-definition.ts";

export const utilitiesDomain = {
  id: "utilities",
  enabled: false,
  authorityMode: "shadow",
  domainFamily: "expense_specialist",
  executionOrder: 33,
  promptVersion: "utilities-specialist-v1",
  promptConcepts:
    "Return ONE obligation per utility type actually named in the evidence: electricity, " +
    "water, sewer, gas, HVAC, telecommunications, other. Do not collapse a sentence covering " +
    "several utilities (e.g. \"electricity, water, sewer, and HVAC\") into one generic result " +
    "-- each named utility gets its own obligation with its own billingMethod.",
  schemaName: "utility_obligation_v1",
  schemaVersion: "utility-obligation-v1",
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
