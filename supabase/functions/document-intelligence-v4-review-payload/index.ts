// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { resolveRun, fetchRunClaims, fetchClaimEvidence, fetchRunCanonicalFieldProjections } from "../_shared/extraction/document-intelligence-v3/projection-reader.ts";
import { buildCanonicalReviewFieldRegistry } from "../_shared/extraction/document-intelligence-v3/canonical-review-field-registry.ts";
import { buildEnterpriseReviewPayload } from "../_shared/extraction/document-intelligence-v3/enterprise-review-payload.ts";
import { persistEnterpriseReviewPayload } from "../_shared/extraction/document-intelligence-v3/enterprise-review-persistence.ts";
import { isCanonicalReviewPayloadEnabled, isCanonicalReviewPayloadStrictEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";

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
    };
  }
  return req.json().catch(() => ({})).then((body: any) => ({
    runId: typeof body?.runId === "string" ? body.runId : typeof body?.run_id === "string" ? body.run_id : null,
    uploadedFileId: typeof body?.uploadedFileId === "string" ? body.uploadedFileId : typeof body?.uploaded_file_id === "string" ? body.uploaded_file_id : null,
  }));
}

function sourceModeFromFlags(): "legacy" | "canonical_hybrid" | "canonical_strict" {
  if (!isCanonicalReviewPayloadEnabled()) return "legacy";
  return isCanonicalReviewPayloadStrictEnabled() ? "canonical_strict" : "canonical_hybrid";
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

async function fetchCurrentEnterprisePayload(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string }) {
  const { data, error } = await args.supabaseAdmin
    .from("document_enterprise_review_payloads")
    .select("payload, payload_hash, source_mode, created_at")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("schema_version", "enterprise-review-payload-v1")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { payload: null, error: error.message };
  return { payload: data?.payload ?? null, error: null };
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

    const run = await resolveRun({ supabaseAdmin, orgId, runId: parsed.runId, uploadedFileId: parsed.uploadedFileId });
    if (!run) {
      return jsonResponse({
        mode: "legacy",
        enterpriseReviewPayload: null,
        legacyReviewPayload: null,
        authorityReadiness: { ready: false, materialMismatchCount: 0, approvalCriticalMismatchCount: 0, canonicalMissingCount: 0, unsupportedFieldCount: 0, reasons: ["no_completed_document_intelligence_run"] },
      });
    }

    const uploadedFileId = parsed.uploadedFileId ?? run.uploaded_file_id;
    const uploadedFile = await fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId });
    if (!uploadedFile) return jsonResponse({ error: true, message: "Uploaded file not found for organization" }, 404);

    const sourceMode = sourceModeFromFlags();
    const current = await fetchCurrentEnterprisePayload({ supabaseAdmin, orgId, uploadedFileId, runId: run.id });
    if (current.payload && current.payload.sourceMode === sourceMode) {
      return jsonResponse({
        mode: sourceMode,
        enterpriseReviewPayload: current.payload,
        legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
        authorityReadiness: current.payload.compatibility?.paritySummary?.readiness ?? { ready: false, reasons: ["missing_parity_summary"] },
      });
    }

    const projectionRows = await fetchRunCanonicalFieldProjections({ supabaseAdmin, orgId, runId: run.id });
    const claimIds = [...new Set(projectionRows.flatMap((row: any) => Array.isArray(row?.source_claim_ids) ? row.source_claim_ids : []))];
    const evidenceRows = await fetchClaimEvidence({ supabaseAdmin, orgId, claimIds });
    const registry = buildCanonicalReviewFieldRegistry(uploadedFile.module_type ?? "lease");
    const built = await buildEnterpriseReviewPayload({
      orgId,
      uploadedFileId,
      leaseId: run.lease_id ?? null,
      run,
      generationId: run.generation_id ?? uploadedFile.active_generation_id ?? null,
      sourceMode,
      registry,
      projectionRows,
      evidenceRows,
      legacyPayload: uploadedFile.ui_review_payload ?? null,
      canonicalDocument: canonicalDocumentFromUploadedFile(uploadedFile),
    });
    const persisted = await persistEnterpriseReviewPayload({ supabaseAdmin, payload: built.payload });

    return jsonResponse({
      mode: sourceMode,
      enterpriseReviewPayload: built.payload,
      legacyReviewPayload: uploadedFile.ui_review_payload ?? null,
      authorityReadiness: built.authorityReadiness,
      diagnostics: {
        persistedPayloadId: persisted.id,
        persistenceError: persisted.error,
        rejectedProjectionCount: built.rejectedProjectionCount,
        rejectedProjectionReasons: built.rejectedProjectionReasons,
      },
    });
  } catch (error: any) {
    console.error(`[document-intelligence-v4-review-payload] error: ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Failed to build Release 4 review payload" }, 500);
  }
});