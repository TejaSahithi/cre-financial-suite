// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { resolveRun, fetchClaimEvidence, fetchRunCanonicalFieldProjections } from "../_shared/extraction/document-intelligence-v3/projection-reader.ts";
import { buildCanonicalReviewFieldRegistry } from "../_shared/extraction/document-intelligence-v3/canonical-review-field-registry.ts";
import { buildEnterpriseReviewPayload } from "../_shared/extraction/document-intelligence-v3/enterprise-review-payload.ts";
import { persistEnterpriseReviewPayload } from "../_shared/extraction/document-intelligence-v3/enterprise-review-persistence.ts";
import { resolveCanonicalReviewRolloutForOrg } from "../_shared/extraction/document-intelligence-v3/canonical-review-rollout.ts";
import { isCanonicalApprovalGatingEnabled, isCanonicalHybridEmergencyFallbackEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseRequest(req: Request) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return {
      runId: url.searchParams.get("run_id") || null,
      uploadedFileId: url.searchParams.get("uploaded_file_id") || null,
      generationId: url.searchParams.get("generation_id") || null,
    };
  }
  return req.json().catch(() => ({})).then((body: any) => ({
    runId: typeof body?.runId === "string" ? body.runId : typeof body?.run_id === "string" ? body.run_id : null,
    uploadedFileId: typeof body?.uploadedFileId === "string" ? body.uploadedFileId : typeof body?.uploaded_file_id === "string" ? body.uploaded_file_id : null,
    generationId: typeof body?.generationId === "string" ? body.generationId : typeof body?.generation_id === "string" ? body.generation_id : null,
  }));
}

async function fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId }: { supabaseAdmin: any; orgId: string; uploadedFileId: string }) {
  const { data, error } = await supabaseAdmin
    .from("uploaded_files")
    .select("id, org_id, module_type, ui_review_payload, active_generation_id, canonical_layout_v3, canonical_layout_v3_hash, canonical_layout_v3_schema_version, canonical_layout_v3_adapter_version")
    .eq("id", uploadedFileId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch uploaded_files row: ${error.message}`);
  return data ?? null;
}

async function fetchCurrentEnterprisePayload(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string; sourceMode: string; generationId?: string | null }) {
  const { data, error } = await args.supabaseAdmin
    .from("document_enterprise_review_payloads")
    .select("id, payload, payload_hash, source_mode, generation_id, rollout_mode, rollout_source, created_at")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("schema_version", "enterprise-review-payload-v1")
    .eq("source_mode", args.sourceMode)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data?.payload) return { row: null, error: null };
  if (args.generationId && data.generation_id && data.generation_id !== args.generationId) return { row: null, error: null };
  return { row: data, error: null };
}

async function fetchActiveReviewOverrides(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string; generationId?: string | null }) {
  let query = args.supabaseAdmin
    .from("document_field_review_overrides")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("is_active", true);
  if (args.generationId) query = query.eq("generation_id", args.generationId);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch active review overrides: ${error.message}`);
  return data ?? [];
}

function canonicalDocumentFromUploadedFile(uploadedFile: any) {
  const layout = uploadedFile?.canonical_layout_v3 ?? null;
  const provider = layout?.provider ?? null;
  return {
    layoutHash: uploadedFile?.canonical_layout_v3_hash ?? layout?.metadata?.canonical_layout_v3?.canonicalLayoutHash ?? null,
    layoutSchemaVersion: uploadedFile?.canonical_layout_v3_schema_version ?? layout?.schema_version ?? null,
    layoutSource: provider === "azure_document_intelligence" ? "azure_native" : layout ? "legacy_lossy" : null,
    geometryAvailable: Array.isArray(layout?.pages) && layout.pages.some((page: any) => Array.isArray(page?.blocks) && page.blocks.some((block: any) => Array.isArray(block?.polygon) && block.polygon.length >= 8)),
  };
}

function staleGenerationResponse(args: { currentRunId: string | null; currentGenerationId: string | null }) {
  return jsonResponse({
    error: true,
    errorCode: "stale_review_generation",
    message: "The review payload is stale for this document generation.",
    currentRunId: args.currentRunId,
    currentGenerationId: args.currentGenerationId,
  }, 409);
}

function approvalReadiness(payload: any, approvalGatingEnabled: boolean) {
  return {
    approvalEligible: payload?.validationSummary?.approvalEligible ?? false,
    approvalGatingEnabled,
    blockingIssueCount: payload?.validationSummary?.blockingIssueCount ?? 0,
    warningCount: payload?.validationSummary?.warningCount ?? 0,
    fallbackCount: payload?.coverage?.totals?.legacyFallbacks ?? 0,
    conflictCount: payload?.coverage?.totals?.conflicts ?? 0,
    missingRequiredCount: payload?.validationSummary?.missingRequiredCount ?? 0,
    missingEvidenceCount: payload?.validationSummary?.missingEvidenceCount ?? 0,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!["GET", "POST"].includes(req.method)) return jsonResponse({ error: true, message: "Method not allowed" }, 405);

    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const parsed = await parseRequest(req);
    if (!parsed.runId && !parsed.uploadedFileId) {
      return jsonResponse({ error: true, message: "One of run_id or uploaded_file_id is required" }, 400);
    }

    const rollout = await resolveCanonicalReviewRolloutForOrg({ supabaseAdmin, orgId, documentFamily: "lease" });
    const run = await resolveRun({ supabaseAdmin, orgId, runId: parsed.runId, uploadedFileId: parsed.uploadedFileId });
    if (!run) {
      return jsonResponse({
        mode: rollout.mode,
        uiAuthority: "legacy",
        enterpriseReviewPayload: null,
        legacyReviewPayload: null,
        authorityReadiness: { ready: false, materialMismatchCount: 0, approvalCriticalMismatchCount: 0, canonicalMissingCount: 0, unsupportedFieldCount: 0, reasons: ["no_completed_document_intelligence_run"] },
        diagnostics: { rollout },
      });
    }

    const uploadedFileId = parsed.uploadedFileId ?? run.uploaded_file_id;
    const uploadedFile = await fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId });
    if (!uploadedFile) return jsonResponse({ error: true, message: "Uploaded file not found for organization" }, 404);

    const currentGenerationId = uploadedFile.active_generation_id ?? run.generation_id ?? null;
    if (parsed.generationId && currentGenerationId && parsed.generationId !== currentGenerationId) {
      return staleGenerationResponse({ currentRunId: run.id ?? null, currentGenerationId });
    }
    if (run.generation_id && uploadedFile.active_generation_id && run.generation_id !== uploadedFile.active_generation_id) {
      return staleGenerationResponse({ currentRunId: run.id ?? null, currentGenerationId });
    }

    const sourceMode = rollout.builderSourceMode;
    const current = await fetchCurrentEnterprisePayload({ supabaseAdmin, orgId, uploadedFileId, runId: run.id, sourceMode, generationId: currentGenerationId });
    if (current.row?.payload) {
      return jsonResponse({
        mode: rollout.mode,
        sourceMode,
        uiAuthority: rollout.uiAuthority,
        enterpriseReviewPayload: current.row.payload,
        legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
        authorityReadiness: current.row.payload.compatibility?.paritySummary?.readiness ?? { ready: false, reasons: ["missing_parity_summary"] },
        approvalReadiness: approvalReadiness(current.row.payload, isCanonicalApprovalGatingEnabled()),
        diagnostics: {
          rollout,
          persistedPayloadId: current.row.id,
          persistedPayloadHash: current.row.payload_hash,
          persistedPayloadReused: true,
          persistenceError: current.error,
        },
      });
    }

    const buildStartedAt = Date.now();
    try {
      const projectionRows = await fetchRunCanonicalFieldProjections({ supabaseAdmin, orgId, runId: run.id });
      const claimIds = [...new Set(projectionRows.flatMap((row: any) => Array.isArray(row?.source_claim_ids) ? row.source_claim_ids : []))];
      const evidenceRows = await fetchClaimEvidence({ supabaseAdmin, orgId, claimIds });
      const activeOverrides = await fetchActiveReviewOverrides({ supabaseAdmin, orgId, uploadedFileId, runId: run.id, generationId: currentGenerationId });
      const registry = buildCanonicalReviewFieldRegistry(uploadedFile.module_type ?? "lease");
      const built = await buildEnterpriseReviewPayload({
        orgId,
        uploadedFileId,
        leaseId: run.lease_id ?? null,
        run,
        generationId: currentGenerationId,
        sourceMode,
        registry,
        projectionRows,
        evidenceRows,
        legacyPayload: uploadedFile.ui_review_payload ?? null,
        canonicalDocument: canonicalDocumentFromUploadedFile(uploadedFile),
        activeOverrides,
      });
      const persisted = await persistEnterpriseReviewPayload({
        supabaseAdmin,
        payload: built.payload,
        diagnostics: {
          rolloutMode: rollout.mode,
          rolloutSource: rollout.source,
          payloadBuildDurationMs: Date.now() - buildStartedAt,
          registryVersion: registry[0]?.schemaVersion ?? null,
          projectionAlgorithmVersion: projectionRows.find((row: any) => row?.projection_algorithm_version)?.projection_algorithm_version ?? "projection-resolution-v1",
          integrityViolationCount: built.rejectedProjectionCount,
        },
      });

      return jsonResponse({
        mode: rollout.mode,
        sourceMode,
        uiAuthority: rollout.uiAuthority,
        enterpriseReviewPayload: built.payload,
        legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
        authorityReadiness: built.authorityReadiness,
        approvalReadiness: approvalReadiness(built.payload, isCanonicalApprovalGatingEnabled()),
        diagnostics: {
          rollout,
          persistedPayloadId: persisted.id,
          persistenceError: persisted.error,
          rejectedProjectionCount: built.rejectedProjectionCount,
          rejectedProjectionReasons: built.rejectedProjectionReasons,
          activeOverrideCount: activeOverrides.length,
        },
      });
    } catch (buildError: any) {
      if ((rollout.mode === "shadow" || rollout.mode === "canonical_hybrid") && isCanonicalHybridEmergencyFallbackEnabled()) {
        return jsonResponse({
          mode: "legacy",
          sourceMode: "legacy",
          uiAuthority: "legacy",
          enterpriseReviewPayload: null,
          legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
          authorityReadiness: { ready: false, reasons: ["canonical_review_payload_build_failed"] },
          diagnostics: { rollout, emergencyFallback: true, error: buildError?.message ?? String(buildError) },
        });
      }
      throw buildError;
    }
  } catch (error: any) {
    console.error(`[document-intelligence-v4-review-payload] error: ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Failed to build Release 4 review payload" }, 500);
  }
});
