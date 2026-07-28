// @ts-nocheck
import type { ExtractionDomainDefinition } from "../../domain-definition.ts";

export const taxesDomain = {
  id: "taxes",
  enabled: false,
  authorityMode: "shadow",
  domainFamily: "expense_specialist",
  executionOrder: 31,
  promptVersion: "taxes-specialist-v1",
  promptConcepts:
    "Represent separately: real-estate taxes, tenant personal-property taxes, special " +
    "assessments, tax increases, tax reimbursements, tax appeal rights, and any " +
    "included-in-rent treatment for taxes. A clause stating taxes are included in rent " +
    "describes ECONOMIC TREATMENT only -- it does not by itself establish the complete " +
    "legal responsibility for who must pay if the included amount is exceeded.",
  schemaName: "tax_obligation_v1",
  schemaVersion: "tax-obligation-v1",
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
