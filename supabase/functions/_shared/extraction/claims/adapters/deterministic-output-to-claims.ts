// @ts-nocheck
/**
 * deterministic-output-to-claims.ts — P2.4.
 *
 * Consumes the pipeline's real ExtractedField shape
 * (_shared/extraction/types.ts:24-30: {value, source, confidence,
 * sourceText?, sourcePage?}) for rule/table-sourced fields and turns every
 * one into exactly one claim -- read-only, zero prompt/model changes.
 *
 * Core invariant: every entry in the input map becomes a claim, whether or
 * not it has a value. A present-but-empty/null value becomes an explicit
 * not_present claim, never silently skipped. Fields absent from the input
 * map entirely are NOT synthesized here (that would be inventing data) --
 * "no claim for a concept" is the resolver's (P2.6) concern, not this
 * adapter's.
 */
import { buildClaimKey } from "./claim-key.ts";
import { normalizeByStrategy } from "./claim-normalization.ts";
import { buildFieldEvidence, type EvidenceBatchItem } from "./field-evidence-to-evidence.ts";
import { getClaimConcept, normalizeDynamicKey } from "../concept-registry.ts";
import { CLAIMS_REGISTRY_VERSION } from "../registry-version.ts";

export interface ExtractedFieldLike {
  value: unknown;
  source: "rule" | "table" | "llm";
  confidence: number;
  sourceText?: string | null;
  sourcePage?: number | null;
}

export interface DeterministicAdapterContext {
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  stageAttempt: number;
}

export interface ClaimBatchItem {
  local_id: string;
  producer_type: string;
  concept_key: string;
  registry_status: "registered" | "unregistered";
  claims_registry_version: string;
  scope_key: string;
  instance_key: string;
  candidate_ordinal: number;
  assertion_status: string;
  normalized_value: string | null;
  raw_value_text: string | null;
  confidence: number | null;
  claim_key: string;
  metadata: Record<string, unknown>;
}

export interface AdapterOutput {
  claims: ClaimBatchItem[];
  evidence: EvidenceBatchItem[];
  links: Array<{ claim_local_id: string; evidence_local_id: string }>;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

export async function deterministicOutputToClaims(
  fields: Record<string, ExtractedFieldLike>,
  context: DeterministicAdapterContext,
): Promise<AdapterOutput> {
  const claims: ClaimBatchItem[] = [];
  const evidence: EvidenceBatchItem[] = [];
  const links: Array<{ claim_local_id: string; evidence_local_id: string }> = [];

  let ordinal = 0;
  for (const [conceptKey, field] of Object.entries(fields)) {
    if (field.source === "llm") continue; // semantic-output-to-claims.ts owns LLM-sourced fields

    const concept = getClaimConcept(conceptKey);
    // A concept absent from the registry must still use the dynamic.*
    // namespace (the DB's registry-namespace CHECK requires it) -- this
    // adapter's inputs should always be field-contract-derived registered
    // keys in practice, but falling back to the dynamic namespace here
    // keeps a coding mismatch elsewhere from becoming a hard persistence
    // failure while still never silently dropping the field.
    const effectiveConceptKey = concept ? conceptKey : normalizeDynamicKey(conceptKey);
    const registryStatus = concept ? "registered" : "unregistered";
    const strategy = concept?.normalizationStrategy ?? "string_trim";

    const hasValue = !isEmptyValue(field.value);
    const normalizedValue = hasValue ? normalizeByStrategy(strategy, field.value) : null;
    const assertionStatus = hasValue && normalizedValue !== null ? "asserted" : "not_present";

    const localId = `det:${effectiveConceptKey}:${ordinal}`;
    const claimKey = buildClaimKey({
      generationId: context.generationId,
      stageAttempt: context.stageAttempt,
      producerType: "deterministic_mapper",
      conceptKey: effectiveConceptKey,
      scopeKey: "lease",
      instanceKey: "default",
      normalizedValue,
      candidateOrdinal: 0,
    });

    claims.push({
      local_id: localId,
      producer_type: "deterministic_mapper",
      concept_key: effectiveConceptKey,
      registry_status: registryStatus,
      claims_registry_version: CLAIMS_REGISTRY_VERSION,
      scope_key: "lease",
      instance_key: "default",
      candidate_ordinal: 0,
      assertion_status: assertionStatus,
      normalized_value: normalizedValue,
      raw_value_text: hasValue ? String(field.value) : null,
      confidence: typeof field.confidence === "number" ? field.confidence : null,
      claim_key: claimKey,
      metadata: concept ? { source: field.source } : { source: field.source, original_key: conceptKey },
    });

    if (assertionStatus === "asserted") {
      const evidenceLocalId = `${localId}:ev`;
      const evidenceItem = await buildFieldEvidence(evidenceLocalId, {
        uploadedFileId: context.uploadedFileId,
        extractionRunId: context.extractionRunId,
        sourcePage: field.sourcePage,
        sourceText: field.sourceText,
      });
      if (evidenceItem) {
        evidence.push(evidenceItem);
        links.push({ claim_local_id: localId, evidence_local_id: evidenceLocalId });
      }
    }

    ordinal += 1;
  }

  return { claims, evidence, links };
}
