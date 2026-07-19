// @ts-nocheck
/**
 * claims-pipeline-orchestrator.ts — P2.7.
 *
 * The single glue point between the pipeline and the P2.2-P2.6 modules --
 * everything it calls (adapters, persist_lease_claim_ledger_batch,
 * detect_and_persist_claim_conflicts, the resolver/projector, the
 * compatibility builder, persist_lease_claim_projection) is already built
 * and independently tested; this module's own job is narrow: read the mode
 * (P2.2), no-op entirely when 'off', and otherwise run the pipeline in the
 * right order and persist/diff/return according to 'shadow' vs 'active'.
 *
 *   off:    no P2 writes, no output change -- returns immediately.
 *   shadow: persist claims -> detect conflicts -> build claim projection
 *           -> persist_lease_claim_projection -> diff against the legacy
 *           payload the caller already built -- runtime output is still
 *           the legacy payload; the diff is returned for logging/analysis
 *           only, never applied.
 *   active: same pipeline, but the claim-projected compatibility slice is
 *           what the caller should use as the actual extraction_data
 *           fields/field_evidence/confidence_scores going forward.
 *
 * Deliberately does NOT touch workflow_output/expense_rules/cam_profile/
 * budget_preview, and never accepts a caller-supplied ledger mode override
 * from anywhere other than the server-resolved feature-mode module.
 */
import { getLeaseClaimsLedgerMode, type LeaseClaimsLedgerMode } from "./feature-mode.ts";
import { deterministicOutputToClaims, type ExtractedFieldLike } from "./adapters/deterministic-output-to-claims.ts";
import { semanticOutputToClaims, type SemanticCandidateGroup } from "./adapters/semantic-output-to-claims.ts";
import { dynamicFindingsToClaims, type UnmappedLlmField } from "./adapters/dynamic-findings-to-claims.ts";
import { buildFieldProjection, type ClaimForProjection } from "./adapters/claims-to-field-projection.ts";
import { buildCompatibilityExtractionDataSlice, type CompatibilityExtractionData } from "./adapters/compatibility-payload-builder.ts";
import { diffCompatibilityFields, summarizeDiff, type FieldDiffResult } from "./adapters/compatibility-diff.ts";
import { CLAIM_CONCEPTS } from "./concept-registry.ts";
import { CLAIMS_REGISTRY_VERSION } from "./registry-version.ts";

export interface OrchestratorContext {
  orgId: string;
  uploadedFileId: string;
  leaseId: string | null;
  extractionRunId: string;
  extractionStageRunId: string | null;
  generationId: string;
  stageAttempt: number;
}

export interface OrchestratorInput {
  deterministicFields: Record<string, ExtractedFieldLike>;
  semanticCandidateGroups: SemanticCandidateGroup[];
  unmappedLlmFields: UnmappedLlmField[];
  /** The legacy compatibility payload already built by the existing
   *  pipeline this call -- required in shadow mode for the diff, ignored
   *  entirely in off/active mode. */
  legacyExtractionData?: { fields: Record<string, unknown> } | null;
}

export interface OrchestratorResult {
  mode: LeaseClaimsLedgerMode;
  ranClaimsLedger: boolean;
  batchResult?: unknown;
  conflictResult?: unknown;
  projectionResult?: unknown;
  compatibilitySlice?: CompatibilityExtractionData;
  diff?: { results: FieldDiffResult[]; summary: Record<string, number> };
}

const NOOP_RESULT: OrchestratorResult = { mode: "off", ranClaimsLedger: false };

function fieldGroupMap(): Map<string, string> {
  return new Map(CLAIM_CONCEPTS.map((c) => [c.conceptKey, c.domain]));
}

/**
 * supabaseAdmin: the service-role client -- every RPC this orchestrator
 * calls (persist_lease_claim_ledger_batch, detect_and_persist_claim_conflicts,
 * persist_lease_claim_projection) is service_role-only, matching the P1
 * recorder module's own client-injection pattern.
 */
export async function runClaimsLedgerForStage(
  supabaseAdmin: any,
  context: OrchestratorContext,
  input: OrchestratorInput,
  envLike?: { get(key: string): string | undefined },
): Promise<OrchestratorResult> {
  const mode = getLeaseClaimsLedgerMode(envLike);
  if (mode === "off") return NOOP_RESULT;

  const adapterContext = {
    uploadedFileId: context.uploadedFileId,
    extractionRunId: context.extractionRunId,
    generationId: context.generationId,
    stageAttempt: context.stageAttempt,
  };

  const [deterministic, semantic, dynamic] = await Promise.all([
    deterministicOutputToClaims(input.deterministicFields, adapterContext),
    semanticOutputToClaims(input.semanticCandidateGroups, adapterContext),
    dynamicFindingsToClaims(input.unmappedLlmFields, adapterContext),
  ]);

  const allClaims = [...deterministic.claims, ...semantic.claims, ...dynamic.claims];
  const allEvidence = [...deterministic.evidence, ...semantic.evidence, ...dynamic.evidence];
  const allLinks = [...deterministic.links, ...semantic.links, ...dynamic.links];

  const { data: batchResult, error: batchError } = await supabaseAdmin.rpc("persist_lease_claim_ledger_batch", {
    p_org_id: context.orgId,
    p_uploaded_file_id: context.uploadedFileId,
    p_lease_id: context.leaseId,
    p_extraction_run_id: context.extractionRunId,
    p_extraction_stage_run_id: context.extractionStageRunId,
    p_generation_id: context.generationId,
    p_claims: allClaims,
    p_evidence: allEvidence,
    p_links: allLinks,
  });
  if (batchError || !batchResult?.success) {
    throw new Error(`persist_lease_claim_ledger_batch failed: ${batchError?.message ?? batchResult?.error_code ?? "unknown"}`);
  }

  const { data: conflictResult, error: conflictError } = await supabaseAdmin.rpc("detect_and_persist_claim_conflicts", {
    p_org_id: context.orgId,
    p_uploaded_file_id: context.uploadedFileId,
    p_lease_id: context.leaseId,
    p_generation_id: context.generationId,
  });
  if (conflictError || !conflictResult?.success) {
    throw new Error(`detect_and_persist_claim_conflicts failed: ${conflictError?.message ?? conflictResult?.error_code ?? "unknown"}`);
  }

  // Fetch back this generation's current-state claims/conflicts to build
  // the projection -- the adapters only know about the batch they just
  // submitted, not prior batches/reviewer edits already in the ledger.
  const { data: claimRows, error: claimsFetchError } = await supabaseAdmin
    .from("lease_claims")
    .select("id, concept_key, scope_key, instance_key, producer_type, assertion_status, normalized_value, raw_value_text, confidence, created_at")
    .eq("org_id", context.orgId)
    .eq("generation_id", context.generationId);
  if (claimsFetchError) throw new Error(`failed to fetch claims for projection: ${claimsFetchError.message}`);

  const supersededIds = new Set(
    (claimRows ?? []).map((c: any) => c.supersedes_claim_id).filter(Boolean),
  );
  const { data: evidenceLinkRows } = await supabaseAdmin
    .from("lease_claim_evidence_links")
    .select("claim_id")
    .eq("extraction_run_id", context.extractionRunId);
  const claimIdsWithEvidence = new Set((evidenceLinkRows ?? []).map((r: any) => r.claim_id));

  const { data: openConflictRows } = await supabaseAdmin
    .from("lease_claim_conflict_groups")
    .select("concept_key, scope_key, instance_key")
    .eq("org_id", context.orgId)
    .eq("generation_id", context.generationId)
    .in("status", ["open", "reopened"]);
  const openConflictFactSlots = new Set(
    (openConflictRows ?? []).map((r: any) => `${r.concept_key}|${r.scope_key}|${r.instance_key}`),
  );

  const claimsForProjection: ClaimForProjection[] = (claimRows ?? []).map((c: any) => ({
    claimId: c.id,
    conceptKey: c.concept_key,
    scopeKey: c.scope_key,
    instanceKey: c.instance_key,
    producerType: c.producer_type,
    assertionStatus: c.assertion_status,
    normalizedValue: c.normalized_value,
    hasEvidence: claimIdsWithEvidence.has(c.id),
    supersededByClaimId: supersededIds.has(c.id) ? "superseded" : null,
    createdAt: c.created_at,
    rawValueText: c.raw_value_text,
    confidence: c.confidence,
  }));

  const fieldProjection = buildFieldProjection({
    claims: claimsForProjection,
    reviewDecisionsByFactSlot: new Map(),
    openConflictFactSlots,
  });

  const compatibilitySlice = buildCompatibilityExtractionDataSlice(fieldProjection, fieldGroupMap());

  const result: OrchestratorResult = {
    mode,
    ranClaimsLedger: true,
    batchResult,
    conflictResult,
    compatibilitySlice,
  };

  if (mode === "shadow" || mode === "active") {
    const { data: projectionResult, error: projectionError } = await supabaseAdmin.rpc("persist_lease_claim_projection", {
      p_org_id: context.orgId,
      p_uploaded_file_id: context.uploadedFileId,
      p_lease_id: context.leaseId,
      p_generation_id: context.generationId,
      p_extraction_run_id: context.extractionRunId,
      p_ledger_mode: mode,
      p_projection_version: "projection-v1",
      p_compatibility_contract_version: CLAIMS_REGISTRY_VERSION,
      p_field_projections: fieldProjection.map((e) => ({
        field_key: e.fieldKey, claim_id: e.claimId, assertion_status: e.outcome, value: e.value,
      })),
    });
    if (projectionError || !projectionResult?.success) {
      throw new Error(`persist_lease_claim_projection failed: ${projectionError?.message ?? projectionResult?.error_code ?? "unknown"}`);
    }
    result.projectionResult = projectionResult;
  }

  if (mode === "shadow" && input.legacyExtractionData?.fields) {
    const diffResults = diffCompatibilityFields(
      input.legacyExtractionData.fields as any,
      compatibilitySlice.fields as any,
    );
    result.diff = { results: diffResults, summary: summarizeDiff(diffResults) };
  }

  return result;
}

/**
 * Resilient call-site wrapper: never throws. The claims ledger is
 * additive/parallel infrastructure in shadow mode and gate-enforced-later
 * (via the finalizer's active-mode checks, P2.7a) in active mode -- a
 * failure here must never break the primary extraction pipeline, which is
 * exactly what "shadow mode changes no runtime output" and "off mode
 * unchanged" require in practice at the real call site. Active-mode
 * correctness is still enforced -- just later, by
 * finalize_lease_extraction_for_review's own checks, not by crashing the
 * stage that populates the ledger.
 */
export async function maybeRunClaimsLedgerForStage(
  supabaseAdmin: any,
  context: OrchestratorContext,
  input: OrchestratorInput,
  envLike?: { get(key: string): string | undefined },
): Promise<OrchestratorResult | null> {
  try {
    return await runClaimsLedgerForStage(supabaseAdmin, context, input, envLike);
  } catch (error) {
    console.error("[claims-ledger] runClaimsLedgerForStage failed, primary extraction pipeline unaffected:", error?.message ?? error);
    return null;
  }
}
