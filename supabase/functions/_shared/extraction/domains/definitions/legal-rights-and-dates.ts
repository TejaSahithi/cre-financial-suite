// @ts-nocheck
import type { ExtractionDomainDefinition } from "../domain-definition.ts";

export const legalRightsAndDatesDomain = {
  id: "legal_rights_and_dates",
  enabled: true,
  authorityMode: "authoritative",
  domainFamily: "core",
  executionOrder: 4,
  promptVersion: "legal-rights-and-dates-v1",
  promptConcepts:
    "renewal/extension options, right of first refusal or offer, early termination rights, " +
    "termination or renewal notice periods -- only an actual GRANT of a right, never a heading, " +
    "defined term, guaranty recital, or surrender/holdover/default clause",
  schemaName: null,
  schemaVersion: null,
  routingThreshold: 3,
  maximumEvidenceCharacters: 60000,
  maximumOutputTokens: 16384,
  criticalFields: [],
  dependencies: [],
  evidenceSourceDomains: [],
  shadowRunsAfter: [],
  boundedEnrichStageName: "enrich_evidence_legal_rights_and_dates",
  participatesInBoundedEnrichment: true,
} as const satisfies ExtractionDomainDefinition;
