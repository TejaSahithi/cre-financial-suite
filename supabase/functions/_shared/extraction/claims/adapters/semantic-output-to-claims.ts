// @ts-nocheck
/**
 * semantic-output-to-claims.ts — P2.4.
 *
 * Consumes LLM-sourced candidate observations for a concept and turns EVERY
 * candidate into its own claim -- multiple candidate values are never
 * collapsed into one claim before persistence (that's P2.5's conflict
 * detector's job, downstream, working over already-persisted claims).
 *
 * Preserves: provider_invocation_id, candidate ordinal (so genuinely
 * separate candidates are distinguishable in claim_key per P2.1 correction
 * #4), source text/page, confidence. Read-only, zero prompt/model changes.
 *
 * Input shape (SemanticCandidateGroup) is this adapter's own contract, not
 * a direct re-export of an existing pipeline type -- P2.7's pipeline-wiring
 * phase is responsible for gathering the real pre-merge LLM candidate list
 * (today's merge step collapses multiple chunks' candidates into one
 * ExtractedField via source-priority before this adapter would ever see
 * them) and shaping it into this group.
 */
import { buildClaimKey } from "./claim-key.ts";
import { normalizeByStrategy } from "./claim-normalization.ts";
import { buildFieldEvidence, type EvidenceBatchItem } from "./field-evidence-to-evidence.ts";
import { getClaimConcept, normalizeDynamicKey } from "../concept-registry.ts";
import { CLAIMS_REGISTRY_VERSION } from "../registry-version.ts";
import type { AdapterOutput, ClaimBatchItem } from "./deterministic-output-to-claims.ts";

export interface SemanticCandidate {
  value: unknown;
  confidence: number;
  sourceText?: string | null;
  sourcePage?: number | null;
}

export interface SemanticCandidateGroup {
  conceptKey: string;
  providerInvocationId: string;
  candidates: SemanticCandidate[];
}

export interface SemanticAdapterContext {
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  stageAttempt: number;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

export async function semanticOutputToClaims(
  groups: SemanticCandidateGroup[],
  context: SemanticAdapterContext,
): Promise<AdapterOutput> {
  const claims: ClaimBatchItem[] = [];
  const evidence: EvidenceBatchItem[] = [];
  const links: Array<{ claim_local_id: string; evidence_local_id: string }> = [];

  for (const group of groups) {
    const concept = getClaimConcept(group.conceptKey);
    // Same fallback as the deterministic adapter: an unrecognized concept
    // must still use the dynamic.* namespace, never an unregistered claim
    // under a non-namespaced key (the DB's registry-namespace CHECK
    // requires it).
    const effectiveConceptKey = concept ? group.conceptKey : normalizeDynamicKey(group.conceptKey);
    const registryStatus = concept ? "registered" : "unregistered";
    const strategy = concept?.normalizationStrategy ?? "string_trim";

    // No candidates at all -- still an explicit not_present claim, per the
    // "no emitted field may disappear silently" invariant (a concept that
    // was genuinely attempted and came back empty is different from a
    // concept never attempted at all, which this adapter is never called
    // for in the first place).
    const effectiveCandidates = group.candidates.length > 0 ? group.candidates : [{ value: null, confidence: 0 }];

    for (let ordinal = 0; ordinal < effectiveCandidates.length; ordinal++) {
      const candidate = effectiveCandidates[ordinal];
      const hasValue = !isEmptyValue(candidate.value);
      const normalizedValue = hasValue ? normalizeByStrategy(strategy, candidate.value) : null;
      const assertionStatus = hasValue && normalizedValue !== null ? "asserted" : "not_present";

      const localId = `sem:${effectiveConceptKey}:${ordinal}`;
      const claimKey = buildClaimKey({
        generationId: context.generationId,
        stageAttempt: context.stageAttempt,
        producerType: "semantic_extractor",
        conceptKey: effectiveConceptKey,
        scopeKey: "lease",
        instanceKey: "default",
        normalizedValue,
        candidateOrdinal: ordinal,
      });

      claims.push({
        local_id: localId,
        producer_type: "semantic_extractor",
        concept_key: effectiveConceptKey,
        registry_status: registryStatus,
        claims_registry_version: CLAIMS_REGISTRY_VERSION,
        scope_key: "lease",
        instance_key: "default",
        candidate_ordinal: ordinal,
        assertion_status: assertionStatus,
        normalized_value: normalizedValue,
        raw_value_text: hasValue ? String(candidate.value) : null,
        confidence: typeof candidate.confidence === "number" ? candidate.confidence : null,
        claim_key: claimKey,
        provider_invocation_id: group.providerInvocationId,
        metadata: concept
          ? { source: "llm", candidate_ordinal: ordinal, candidate_count: effectiveCandidates.length }
          : { source: "llm", candidate_ordinal: ordinal, candidate_count: effectiveCandidates.length, original_key: group.conceptKey },
      } as ClaimBatchItem & { provider_invocation_id: string });

      if (assertionStatus === "asserted") {
        const evidenceLocalId = `${localId}:ev`;
        const evidenceItem = await buildFieldEvidence(evidenceLocalId, {
          uploadedFileId: context.uploadedFileId,
          extractionRunId: context.extractionRunId,
          sourcePage: candidate.sourcePage,
          sourceText: candidate.sourceText,
        });
        if (evidenceItem) {
          evidence.push(evidenceItem);
          links.push({ claim_local_id: localId, evidence_local_id: evidenceLocalId });
        }
      }
    }
  }

  return { claims, evidence, links };
}
