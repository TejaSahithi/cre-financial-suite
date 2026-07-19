// @ts-nocheck
/**
 * P3.4 relationship detection service.
 *
 * No pipeline call site invokes this in P3.4. Direct callers can compute
 * candidates in mode=off; isolated shadow-mode tests may persist them through
 * the bounded RPC. No compatibility projection or P2 claim mutation occurs.
 */

import { getLeaseDocumentPackageMode } from "../feature-mode.ts";
import { detectDocumentRelationships } from "./relationship-detector.ts";
import { validateRelationshipCandidates } from "./relationship-validator.ts";
import type { RelationshipCandidate, RelationshipDetectionInput } from "./relationship-types.ts";

export interface DetectRelationshipsOptions {
  allowActiveWrites?: boolean;
}

export interface DetectRelationshipsResult {
  candidates: RelationshipCandidate[];
  persisted: boolean;
  persistResult?: unknown;
}

export async function detectRelationshipsForPackage(
  supabaseAdmin: any,
  input: RelationshipDetectionInput,
  opts: DetectRelationshipsOptions = {},
): Promise<DetectRelationshipsResult> {
  const candidates = validateRelationshipCandidates(input, detectDocumentRelationships(input));
  const mode = getLeaseDocumentPackageMode();
  if (mode === "off" || (mode === "active" && opts.allowActiveWrites !== true)) {
    return { candidates, persisted: false };
  }
  const persistResult = await persistRelationshipCandidates(supabaseAdmin, input, candidates);
  return { candidates, persisted: true, persistResult };
}

export async function persistRelationshipCandidates(
  supabaseAdmin: any,
  input: RelationshipDetectionInput,
  candidates: RelationshipCandidate[],
): Promise<unknown> {
  const { data, error } = await supabaseAdmin.rpc("persist_lease_document_relationship_candidates", {
    p_org_id: input.orgId,
    p_package_id: input.packageId,
    p_detector_contract_version: input.detectorContractVersion ?? "lease-document-relationships-v1",
    p_candidates: candidates.map((candidate) => ({
      relationship_type: candidate.relationshipType,
      source_package_document_id: candidate.sourcePackageDocumentId,
      target_package_document_id: candidate.targetPackageDocumentId ?? null,
      source_segment_id: candidate.sourceSegmentId ?? null,
      target_segment_id: candidate.targetSegmentId ?? null,
      relationship_status: candidate.proposedStatus,
      validation_status: candidate.validationStatus,
      confidence: candidate.confidence ?? null,
      relationship_key: candidate.relationshipKey,
      reason_codes: candidate.reasonCodes,
      evidence_claim_ids: candidate.evidenceClaimIds,
      dynamic_evidence_claim_ids: candidate.dynamicEvidenceClaimIds ?? [],
      candidate_target_document_ids: candidate.candidateTargetDocumentIds ?? [],
      explicit_reference: candidate.explicitReference,
      reviewer_confirmation_required: candidate.reviewerConfirmationRequired,
      requires_related_document: candidate.requiresRelatedDocument ?? null,
    })),
  });
  if (error || !data?.success) {
    throw new Error(`persist_lease_document_relationship_candidates failed: ${error?.message ?? data?.error_code ?? "unknown"}`);
  }
  return data;
}
