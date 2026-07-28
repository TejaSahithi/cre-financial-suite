// @ts-nocheck
import type { ExtractionDomainDefinition } from "../domain-definition.ts";

export const coreTermsDomain = {
  id: "core_terms",
  enabled: true,
  authorityMode: "authoritative",
  domainFamily: "core",
  executionOrder: 0,
  promptVersion: "core-terms-v1",
  promptConcepts:
    "tenant legal name, landlord legal name, property/premises address, unit or suite number, " +
    "rentable square footage, lease commencement date, lease expiration date, lease term length",
  schemaName: null,
  schemaVersion: null,
  routingThreshold: 3,
  // Not yet enforced by any consumer in this phase -- present for future use
  // (see the plan's Phase 4 scope note). Matches _shared/llm.ts's own
  // OPENAI_MAX_OUTPUT_TOKENS default and an observed-in-practice evidence
  // size for this domain (~60K chars on a real canary trace).
  maximumEvidenceCharacters: 60000,
  maximumOutputTokens: 16384,
  criticalFields: ["tenant_name", "landlord_name", "commencement_date", "expiration_date", "square_footage"],
  dependencies: [],
  evidenceSourceDomains: [],
  shadowRunsAfter: [],
  boundedEnrichStageName: "enrich_evidence_core_terms",
  participatesInBoundedEnrichment: true,
} as const satisfies ExtractionDomainDefinition;
