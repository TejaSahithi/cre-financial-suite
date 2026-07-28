// @ts-nocheck
import type { ExtractionDomainDefinition } from "../domain-definition.ts";

export const operatingObligationsDomain = {
  id: "operating_obligations",
  enabled: true,
  authorityMode: "authoritative",
  domainFamily: "core",
  executionOrder: 3,
  promptVersion: "operating-obligations-v1",
  promptConcepts:
    "repair and maintenance responsibility (structural, HVAC, interior, exterior) and utility " +
    "payment responsibility -- distinguish who PAYS for a utility/system from who merely maintains " +
    "or repairs it; a repair-only clause does not by itself establish payment responsibility",
  schemaName: null,
  schemaVersion: null,
  routingThreshold: 3,
  maximumEvidenceCharacters: 60000,
  maximumOutputTokens: 16384,
  criticalFields: ["responsibility_repairs"],
  dependencies: [],
  evidenceSourceDomains: [],
  shadowRunsAfter: [],
  boundedEnrichStageName: "enrich_evidence_operating_obligations",
  participatesInBoundedEnrichment: true,
} as const satisfies ExtractionDomainDefinition;
