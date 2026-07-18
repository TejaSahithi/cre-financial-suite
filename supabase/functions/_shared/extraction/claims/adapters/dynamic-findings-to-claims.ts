// @ts-nocheck
/**
 * dynamic-findings-to-claims.ts — P2.4.
 *
 * Consumes the pipeline's real unmappedLlmFields shape (the exact
 * parameter type at lease-workflow.ts:2396/4291:
 * {key, value, sourceText?, sourcePage?, confidence?}) -- the same input
 * that already produces synthetic field_group:"discovered" rows in
 * buildLeaseWorkflowAbstraction() today (lease-workflow.ts:3086-3107) --
 * and turns every one into a dynamic.* claim. This is the P2 formalization
 * of a discovery the pipeline already makes; it does not change what gets
 * discovered, only how it's preserved.
 *
 * registry_status is always 'unregistered' and concept_key always uses the
 * dynamic.<normalized_key> namespace (normalizeDynamicKey, already built in
 * concept-registry.ts, P2.1) -- reused here, not reimplemented. The
 * original key/label is preserved in metadata so nothing about the finding
 * is lost in the namespace normalization.
 */
import { buildClaimKey } from "./claim-key.ts";
import { normalizeString } from "./claim-normalization.ts";
import { buildFieldEvidence, type EvidenceBatchItem } from "./field-evidence-to-evidence.ts";
import { normalizeDynamicKey } from "../concept-registry.ts";
import { CLAIMS_REGISTRY_VERSION } from "../registry-version.ts";
import type { AdapterOutput, ClaimBatchItem } from "./deterministic-output-to-claims.ts";

export interface UnmappedLlmField {
  key: string;
  value: unknown;
  sourceText?: string | null;
  sourcePage?: number | null;
  confidence?: number | null;
}

export interface DynamicFindingsAdapterContext {
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  stageAttempt: number;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

export async function dynamicFindingsToClaims(
  unmappedLlmFields: UnmappedLlmField[],
  context: DynamicFindingsAdapterContext,
): Promise<AdapterOutput> {
  const claims: ClaimBatchItem[] = [];
  const evidence: EvidenceBatchItem[] = [];
  const links: Array<{ claim_local_id: string; evidence_local_id: string }> = [];

  let ordinal = 0;
  for (const finding of unmappedLlmFields) {
    // Mirrors buildLeaseWorkflowAbstraction's own scoping (lease-workflow.ts:3087):
    // only fields with a real, non-empty value create a row -- this is the
    // pipeline's existing, already-accepted noise filter, not a new one
    // introduced by this adapter.
    if (isBlank(finding.value)) continue;

    const conceptKey = normalizeDynamicKey(finding.key);
    const normalizedValue = normalizeString(finding.value);
    const localId = `dyn:${conceptKey}:${ordinal}`;

    const claimKey = buildClaimKey({
      generationId: context.generationId,
      stageAttempt: context.stageAttempt,
      producerType: "legacy_adapter",
      conceptKey,
      scopeKey: "lease",
      instanceKey: "default",
      normalizedValue,
      candidateOrdinal: 0,
    });

    claims.push({
      local_id: localId,
      producer_type: "legacy_adapter",
      concept_key: conceptKey,
      registry_status: "unregistered",
      claims_registry_version: CLAIMS_REGISTRY_VERSION,
      scope_key: "lease",
      instance_key: "default",
      candidate_ordinal: 0,
      assertion_status: "asserted",
      normalized_value: normalizedValue,
      raw_value_text: String(finding.value),
      confidence: typeof finding.confidence === "number" ? finding.confidence : null,
      claim_key: claimKey,
      metadata: { original_key: finding.key, source: "llm_unmapped" },
    });

    const evidenceLocalId = `${localId}:ev`;
    const evidenceItem = await buildFieldEvidence(evidenceLocalId, {
      uploadedFileId: context.uploadedFileId,
      extractionRunId: context.extractionRunId,
      sourcePage: finding.sourcePage,
      sourceText: finding.sourceText,
    });
    if (evidenceItem) {
      evidence.push(evidenceItem);
      links.push({ claim_local_id: localId, evidence_local_id: evidenceLocalId });
    }

    ordinal += 1;
  }

  return { claims, evidence, links };
}
