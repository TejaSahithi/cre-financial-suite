// @ts-nocheck
/**
 * Document Intelligence v3 — Side-Write (Phase 2, extended in Phase 3 to
 * also persist the classified document profile onto the run row so the
 * Phase 3 readiness evaluator has a durable source to read it from — see
 * 20260821000000_document_intelligence_v3_run_profile_columns.sql).
 *
 * Opt-in, best-effort durable write of the v3 claim/evidence scaffold
 * (Phase 1) alongside the current normalize-pdf-output flow. This module is
 * called from ONE place -- normalize-pdf-output/index.ts, right after the
 * existing minimal ui_review_payload/normalized_output persist succeeds --
 * and is gated end-to-end by ENABLE_DOCUMENT_INTELLIGENCE_V3.
 *
 * P0 guarantee (Phase 2 constraints 9-11): when the flag is off, this
 * function makes zero DB calls and returns immediately. When the flag is
 * on, every failure is caught here -- nothing thrown by this module may
 * ever propagate to normalize-pdf-output's caller. The current
 * ui_review_payload/normalized_output write already happened before this
 * runs, so a side-write failure can only ever affect v3-only tables.
 *
 * Idempotency: one document_intelligence_runs row per
 * (org_id, idempotency_key), upserted via ON CONFLICT DO UPDATE (see
 * 20260820000000_document_intelligence_v3_idempotency.sql). A retry that
 * resolves to the same idempotency key reuses the same run_id and
 * delete-and-replaces that run's claims/evidence/validation_drops/
 * canonical_field_projections rather than accumulating duplicates. A
 * genuinely different run (different content_hash/job/provider) gets a new
 * run_id, so prior completed runs are never mutated by an unrelated retry.
 */

import { isDocumentIntelligenceV3Enabled } from "./feature-flag.ts";
import { buildDocumentIntelligenceV3Skeleton } from "./adapter.ts";
import {
  extractVertexFactLedgerClaims,
  extractValidationDrops,
  extractCanonicalFieldProjections,
  type DocumentIntelligenceV3ClaimRow,
  type DocumentIntelligenceV3ClaimEvidenceRow,
} from "./fact-mapper.ts";
import { summarizeCanonicalLayout } from "./canonical-layout.ts";
import { resolveCanonicalDocumentLayout } from "./canonical-layout-resolver.ts";
import { buildDiagnosticProfileAndPlan } from "./profile-planner.ts";
import { buildStaticCoverageImportanceSummary } from "./coverage-importance.ts";
import { upsertPackageGraphForRun } from "./package-graph.ts";
import { buildTemporalSupersessionDiagnostics } from "./temporal-supersession.ts";

export interface DocumentIntelligenceV3SideWriteInput {
  supabaseAdmin: any;
  orgId: string;
  uploadedFileId: string;
  uploadedFile: Record<string, unknown>;
  leaseId?: string | null;
  pipelineJobId?: string | null;
  result: any;
  logger?: { event: (...args: any[]) => any } | null;
}

export interface DocumentIntelligenceV3SideWriteResult {
  attempted: boolean;
  status: "skipped" | "completed" | "failed";
  runId: string | null;
  claimsCount: number;
  evidenceCount: number;
  validationDropsCount: number;
  canonicalFieldProjectionCount: number;
  error: string | null;
}

function skippedResult(): DocumentIntelligenceV3SideWriteResult {
  return {
    attempted: false,
    status: "skipped",
    runId: null,
    claimsCount: 0,
    evidenceCount: 0,
    validationDropsCount: 0,
    canonicalFieldProjectionCount: 0,
    error: null,
  };
}

function buildIdempotencyKey(parts: {
  orgId: string;
  uploadedFileId: string;
  leaseId: string | null;
  contractVersion: string;
  extractionProvider: string | null;
  pipelineJobId: string | null;
  contentHash?: string | null;
  extractionModel?: string | null;
  pipelineVersion?: string | null;
  promptBundleVersion?: string | null;
}): string {
  // Base key, unchanged since Phase 2 (Task D there) -- this exact 6-part
  // array/join is preserved byte-for-byte so a caller with none of the
  // Phase 6 enrichment fields available produces the identical key it
  // always has (Phase 6 Task F: "missing content_hash preserves prior
  // fallback behavior").
  const base = [
    parts.orgId,
    parts.uploadedFileId,
    parts.leaseId ?? "no-lease",
    parts.contractVersion,
    parts.extractionProvider ?? "unknown-provider",
    parts.pipelineJobId ?? "no-job",
  ];

  // Phase 6 Task F: appended only when present, each behind its own label
  // so a future null-to-value transition for any one of these can't be
  // confused with another (e.g. a content_hash accidentally colliding with
  // a pipeline_version string). content_hash is the one Phase 5 actually
  // computes today; the other three remain prepared-but-unpopulated until
  // a later phase starts setting them on the v3 contract.
  const enrichment: string[] = [];
  if (parts.contentHash) enrichment.push(`content_hash:${parts.contentHash}`);
  if (parts.extractionModel) enrichment.push(`extraction_model:${parts.extractionModel}`);
  if (parts.pipelineVersion) enrichment.push(`pipeline_version:${parts.pipelineVersion}`);
  if (parts.promptBundleVersion) enrichment.push(`prompt_bundle_version:${parts.promptBundleVersion}`);

  return [...base, ...enrichment].join("|");
}

function readVertexFactLedgerProfile(result: any): {
  profileKey: string | null;
  profileConfidence: number | null;
  profileStatus: "unclassified" | "auto_detected";
} {
  const vfl = result?.metadata?.extractionDebug?.vertex_fact_ledger;
  if (!vfl || typeof vfl !== "object") {
    return { profileKey: null, profileConfidence: null, profileStatus: "unclassified" };
  }
  return {
    profileKey: typeof vfl.document_profile === "string" ? vfl.document_profile : null,
    profileConfidence: typeof vfl.document_profile_confidence === "number" ? vfl.document_profile_confidence : null,
    profileStatus: vfl.document_profile ? "auto_detected" : "unclassified",
  };
}

/**
 * Phase 7 Task E: which document index (Phase 6) produced whatever evidence
 * anchors ended up attached to this run's evidence rows -- "unavailable"
 * covers both legacy_hybrid (no vertex_fact_ledger debug object at all) and
 * a pre-Phase-6 vertex_fact_ledger run that never computed this field.
 */
function readEvidenceAnchorSource(result: any): "canonical_layout" | "legacy_evidence_index" | "unavailable" {
  const vfl = result?.metadata?.extractionDebug?.vertex_fact_ledger;
  if (!vfl || typeof vfl !== "object") return "unavailable";
  return vfl.document_index_source === "canonical_layout" ? "canonical_layout" : "legacy_evidence_index";
}

/**
 * Phase 7 Task E: counts describing how well-evidenced this run's claims
 * are, independent of the coarser source_backed_claims/claims_missing_evidence
 * pair Phase 2 already computes (those count CLAIMS; these count the
 * EVIDENCE ROWS themselves, specifically how many carry the richer
 * block_ids/polygon detail Phase 6/7 can now attach).
 */
function computeEvidenceDiagnosticCounts(
  claims: DocumentIntelligenceV3ClaimRow[],
  evidence: DocumentIntelligenceV3ClaimEvidenceRow[],
  result: any,
): Record<string, unknown> {
  return {
    evidence_rows_with_block_ids: evidence.filter((e) => Array.isArray(e.block_ids) && e.block_ids.length > 0).length,
    evidence_rows_with_polygon: evidence.filter((e) => Array.isArray(e.polygon) && e.polygon.length > 0).length,
    // Every row in `evidence` was only ever pushed when source_text was
    // truthy (fact-mapper.ts never fabricates evidence) -- this count is
    // evidence.length by construction, kept explicit here rather than
    // inlined so the shape matches Task E's requested field names exactly.
    evidence_rows_with_source_text: evidence.length,
    evidence_rows_without_source_text: Math.max(0, claims.length - evidence.length),
    evidence_anchor_source: readEvidenceAnchorSource(result),
  };
}

/**
 * Task E (Phase 5), extended in Phase 6 Task F: when docling_raw is
 * available on the side-write's uploadedFile context, compute the
 * canonical layout ONCE and return both its audit summary (for the run
 * row's layout_summary column) and its content_hash (for the idempotency
 * key, below) -- computing it once rather than twice. Never throws -- a
 * computation failure degrades to an empty summary/null hash with a
 * warning rather than failing the whole side-write (the claim/evidence/
 * projection writes are the load-bearing part of this function;
 * layout_summary/content_hash are diagnostic/idempotency inputs only).
 *
 * Phase 4b: the canonical layout is now obtained via
 * `resolveCanonicalDocumentLayout({ doclingRaw })` (../document-intelligence-v3/canonical-layout-resolver.ts)
 * rather than calling the legacy builder directly -- no direct import of
 * `buildCanonicalLayoutFromAzureLikeOutput`/`legacyDoclingToCanonicalLayout`
 * or the Azure adapter remains in this file. Unlike Phase 4a's
 * document-index-v3.ts (which has an alternate legacy_evidence_index path
 * to fall back to), there is no alternate "summary" here -- a null layout
 * or a fatally-invalid resolved layout is turned into the exact same
 * degrade-in-place outcome this function already produced for any other
 * failure (thrown into the existing catch below, same message prefix),
 * never a load-bearing failure of the side-write as a whole. Current
 * runtime input here is always `docling_raw` (Phase 2's durable-input
 * finding), so the resolver call below always resolves
 * `source: "legacy_docling_raw"` / `fidelity: "legacy_lossy"` in practice
 * -- both accepted implicitly by proceeding whenever a layout is present
 * and valid. `resolution.warnings` are never consulted for control flow.
 */
async function computeCanonicalLayoutAndSummary(
  uploadedFile: Record<string, unknown>,
  context: { uploadedFileId: string; orgId: string },
): Promise<{ summary: Record<string, unknown>; contentHash: string | null }> {
  const doclingRaw = uploadedFile?.docling_raw as Record<string, unknown> | null | undefined;
  if (!doclingRaw) return { summary: {}, contentHash: null };
  try {
    const resolution = await resolveCanonicalDocumentLayout({ doclingRaw });

    if (!resolution.layout) {
      throw new Error(`layout resolution returned no layout (source: ${resolution.source})`);
    }
    if (resolution.validation && !resolution.validation.valid) {
      const fatalCodes = resolution.validation.errors.map((e) => e.code).join(", ") || "unspecified";
      throw new Error(`layout failed validation (fatal: ${fatalCodes})`);
    }

    return {
      summary: summarizeCanonicalLayout(resolution.layout) as unknown as Record<string, unknown>,
      contentHash: resolution.layout.content_hash,
    };
  } catch (error: any) {
    return { summary: { warnings: [`layout_summary_computation_failed: ${error?.message ?? error}`] }, contentHash: null };
  }
}

async function safeLog(logger: DocumentIntelligenceV3SideWriteInput["logger"], stage: string, status: string, metadata: Record<string, unknown>) {
  if (!logger || typeof logger.event !== "function") return;
  try {
    await logger.event("document_intelligence_v3", `${stage}:${status}`, metadata);
  } catch {
    // Logging must never be the reason the side-write (or its caller) fails.
  }
}

export async function runDocumentIntelligenceV3SideWrite(
  input: DocumentIntelligenceV3SideWriteInput,
): Promise<DocumentIntelligenceV3SideWriteResult> {
  if (!isDocumentIntelligenceV3Enabled()) {
    return skippedResult();
  }

  const { supabaseAdmin, orgId, uploadedFileId, uploadedFile, result, logger } = input;
  const leaseId = input.leaseId ?? null;
  const pipelineJobId = input.pipelineJobId ?? null;

  let runId: string | null = null;

  try {
    const skeleton = buildDocumentIntelligenceV3Skeleton({
      uploadedFile: { ...uploadedFile, normalized_output: result },
      lease: leaseId ? { id: leaseId, org_id: orgId } : null,
    });

    const legacyProfile = readVertexFactLedgerProfile(result);
    const { summary: layoutSummary, contentHash } = await computeCanonicalLayoutAndSummary(uploadedFile, {
      uploadedFileId,
      orgId,
    });
    const { profileEnsemble, extractionPlan } = buildDiagnosticProfileAndPlan({
      uploadedFile,
      result,
      layoutSummary,
    });
    const profile = {
      profileKey: profileEnsemble.selected_profile_key ?? legacyProfile.profileKey,
      profileConfidence: profileEnsemble.confidence ?? legacyProfile.profileConfidence,
      profileStatus: profileEnsemble.profile_source === "manual_override"
        ? "manual_override"
        : profileEnsemble.selected_policy_key === "unknown_cre_document"
          ? "unclassified"
          : "auto_detected",
    };

    const idempotencyKey = buildIdempotencyKey({
      orgId,
      uploadedFileId,
      leaseId,
      contractVersion: skeleton.contract_version,
      extractionProvider: skeleton.processing.version.extraction_provider,
      pipelineJobId,
      contentHash,
      extractionModel: skeleton.processing.version.extraction_model,
      pipelineVersion: skeleton.processing.version.pipeline_version,
      promptBundleVersion: skeleton.processing.version.prompt_bundle_version,
    });

    const nowIso = new Date().toISOString();

    const { data: runRow, error: upsertError } = await supabaseAdmin
      .from("document_intelligence_runs")
      .upsert(
        {
          org_id: orgId,
          uploaded_file_id: uploadedFileId,
          lease_id: leaseId,
          pipeline_job_id: pipelineJobId,
          contract_version: skeleton.contract_version,
          idempotency_key: idempotencyKey,
          layout_summary: layoutSummary,
          status: "running",
          version_metadata: skeleton.processing.version,
          profile_key: profile.profileKey,
          profile_confidence: profile.profileConfidence,
          profile_status: profile.profileStatus,
          profile_signals: profileEnsemble.signals ?? [],
          started_at: nowIso,
          finished_at: null,
          error_message: null,
        },
        { onConflict: "org_id,idempotency_key" },
      )
      .select("id")
      .single();

    if (upsertError || !runRow?.id) {
      throw new Error(`Failed to upsert document_intelligence_runs: ${upsertError?.message ?? "no row returned"}`);
    }
    runId = runRow.id;

    // Delete-and-replace: safe for a retry of the SAME idempotency key
    // (same run_id). document_claim_evidence rows cascade automatically
    // via document_claims' ON DELETE CASCADE.
    const { error: deleteClaimsError } = await supabaseAdmin.from("document_claims").delete().eq("run_id", runId);
    if (deleteClaimsError) throw new Error(`Failed to clear prior claims for retry: ${deleteClaimsError.message}`);

    const { error: deleteDropsError } = await supabaseAdmin
      .from("document_validation_drops")
      .delete()
      .eq("run_id", runId);
    if (deleteDropsError) throw new Error(`Failed to clear prior validation drops for retry: ${deleteDropsError.message}`);

    const { error: deleteProjectionsError } = await supabaseAdmin
      .from("document_canonical_field_projections")
      .delete()
      .eq("run_id", runId);
    if (deleteProjectionsError) {
      throw new Error(`Failed to clear prior canonical field projections for retry: ${deleteProjectionsError.message}`);
    }

    const { claims, evidence } = extractVertexFactLedgerClaims({
      result,
      orgId,
      uploadedFileId,
      leaseId,
    });
    const validationDrops = extractValidationDrops({ result, orgId, uploadedFileId });
    const canonicalFieldProjections = extractCanonicalFieldProjections({
      result,
      orgId,
      uploadedFileId,
      leaseId,
      claims,
    });

    if (claims.length > 0) {
      const claimsWithRunId = claims.map((claim) => ({ ...claim, run_id: runId }));
      const { error: insertClaimsError } = await supabaseAdmin.from("document_claims").insert(claimsWithRunId);
      if (insertClaimsError) throw new Error(`Failed to insert document_claims: ${insertClaimsError.message}`);
    }

    if (evidence.length > 0) {
      const { error: insertEvidenceError } = await supabaseAdmin.from("document_claim_evidence").insert(evidence);
      if (insertEvidenceError) throw new Error(`Failed to insert document_claim_evidence: ${insertEvidenceError.message}`);
    }

    if (validationDrops.length > 0) {
      const dropsWithRunId = validationDrops.map((drop) => ({ ...drop, run_id: runId }));
      const { error: insertDropsError } = await supabaseAdmin.from("document_validation_drops").insert(dropsWithRunId);
      if (insertDropsError) throw new Error(`Failed to insert document_validation_drops: ${insertDropsError.message}`);
    }

    if (canonicalFieldProjections.length > 0) {
      const projectionsWithRunId = canonicalFieldProjections.map((row) => ({ ...row, run_id: runId }));
      const { error: insertProjectionsError } = await supabaseAdmin
        .from("document_canonical_field_projections")
        .insert(projectionsWithRunId);
      if (insertProjectionsError) {
        throw new Error(`Failed to insert document_canonical_field_projections: ${insertProjectionsError.message}`);
      }
    }

    const staticCoverageImportance = buildStaticCoverageImportanceSummary({
      claims,
      evidence,
      validationDrops,
      layoutSummary,
      extractionPlan,
      profileKey: profile.profileKey,
    });

    let packageGraph: Record<string, unknown> | null = null;
    let packageGraphError: string | null = null;
    try {
      packageGraph = await upsertPackageGraphForRun({
        supabaseAdmin,
        orgId,
        uploadedFileId,
        uploadedFile,
        leaseId,
        runId,
        profileKey: profile.profileKey,
        profileConfidence: profile.profileConfidence,
        contentHash,
        extractionPlan,
        claims,
        layoutSummary,
      });
    } catch (error: any) {
      packageGraphError = error?.message ?? String(error);
      await safeLog(logger, "package_graph", "failed", {
        run_id: runId,
        uploaded_file_id: uploadedFileId,
        error: packageGraphError,
      });
    }

    const temporalSupersession = buildTemporalSupersessionDiagnostics({
      run: { id: runId, uploaded_file_id: uploadedFileId, lease_id: leaseId, profile_key: profile.profileKey, profile_confidence: profile.profileConfidence },
      claims,
      projections: canonicalFieldProjections.map((row) => ({ ...row, run_id: runId })),
      packageGraph,
      profileKey: profile.profileKey,
      extractionPlan,
    });

    const summary: DocumentIntelligenceV3SideWriteResult = {
      attempted: true,
      status: "completed",
      runId,
      claimsCount: claims.length,
      evidenceCount: evidence.length,
      validationDropsCount: validationDrops.length,
      canonicalFieldProjectionCount: canonicalFieldProjections.length,
      error: null,
    };

    const { error: completeError } = await supabaseAdmin
      .from("document_intelligence_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        coverage: {
          source_backed_claims: evidence.length,
          claims_missing_evidence: Math.max(0, claims.length - evidence.length),
          // Phase 7 Task E.
          ...computeEvidenceDiagnosticCounts(claims, evidence, result),
          // Phase 9: diagnostic-only profile ensemble and planner output.
          profile_ensemble: profileEnsemble,
          extraction_plan: extractionPlan,
          modules_to_run_count: extractionPlan.modules_to_run.length,
          modules_skipped_count: extractionPlan.modules_skipped.length,
          related_documents_needed: extractionPlan.related_documents_needed,
          planner_warnings: extractionPlan.planner_warnings,
          phase10_static_coverage_importance: staticCoverageImportance,
          static_unmapped_claims_count: staticCoverageImportance.unmapped_claims_count,
          static_unmapped_high_importance_claims_count: staticCoverageImportance.unmapped_high_importance_claims.length,
          package_graph: packageGraph,
          package_graph_status: packageGraph?.graph_status ?? (packageGraphError ? "unavailable" : "not_available"),
          package_graph_error: packageGraphError,
          temporal_supersession: temporalSupersession,
          temporal_status: temporalSupersession.temporal_status,
        },
        error_message: null,
      })
      .eq("id", runId);
    if (completeError) {
      // The v3 rows themselves are already durable at this point; a failed
      // status-column update is logged, not escalated.
      await safeLog(logger, "run_status_update", "failed", { run_id: runId, error: completeError.message });
    }

    await safeLog(logger, "side_write", "completed", {
      run_id: runId,
      uploaded_file_id: uploadedFileId,
      claims_count: summary.claimsCount,
      evidence_count: summary.evidenceCount,
      validation_drops_count: summary.validationDropsCount,
      canonical_field_projection_count: summary.canonicalFieldProjectionCount,
    });

    return summary;
  } catch (error: any) {
    const message = error?.message ?? String(error);

    if (runId) {
      try {
        await supabaseAdmin
          .from("document_intelligence_runs")
          .update({ status: "failed", finished_at: new Date().toISOString(), error_message: message })
          .eq("id", runId);
      } catch {
        // Best-effort only -- the outer catch below still returns a
        // failed-but-non-throwing result either way.
      }
    }

    await safeLog(logger, "side_write", "failed", {
      run_id: runId,
      uploaded_file_id: uploadedFileId,
      error: message,
    });

    return {
      attempted: true,
      status: "failed",
      runId,
      claimsCount: 0,
      evidenceCount: 0,
      validationDropsCount: 0,
      canonicalFieldProjectionCount: 0,
      error: message,
    };
  }
}


