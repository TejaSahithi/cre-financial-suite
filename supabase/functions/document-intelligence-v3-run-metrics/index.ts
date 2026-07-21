// @ts-nocheck
/**
 * Document Intelligence v3 — Run Operational Metrics Endpoint (Release 2)
 *
 * Read-only diagnostic: per-run pages/blocks/claims/evidence/projection
 * counts, stage durations/failures, provider-aware table-write health, and
 * a version/context metadata block. Mirrors the other four v3 edge
 * functions' structure. Never mutates leases or uploaded_files.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { evaluateDocumentIntelligenceV3Readiness } from "../_shared/extraction/document-intelligence-v3/readiness.ts";
import {
  resolveRun,
  fetchRunClaims,
  fetchClaimEvidence,
  fetchRunValidationDrops,
  fetchRunCanonicalFieldProjections,
} from "../_shared/extraction/document-intelligence-v3/projection-reader.ts";
import {
  buildRunOperationalMetrics,
  buildDiagnosticsContext,
  evaluateTableExpectations,
} from "../_shared/extraction/document-intelligence-v3/run-metrics.ts";
import { evaluateTransportWrapperReadiness } from "../_shared/extraction/document-intelligence-v3/transport-readiness.ts";
import { normalizeBusinessExtractionMode } from "../_shared/extraction/business-extraction-provenance.ts";
import { isExtractionProvenanceEnabled } from "../_shared/extraction/provenance/feature-flag.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function currentBusinessExtractionProvider(): string {
  return normalizeBusinessExtractionMode(Deno.env.get("BUSINESS_EXTRACTION_PROVIDER"), { source: "persisted_row" });
}

async function fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId }: { supabaseAdmin: any; orgId: string; uploadedFileId: string | null }) {
  if (!uploadedFileId) return null;
  const { data, error } = await supabaseAdmin
    .from("uploaded_files")
    .select("id, org_id, module_type, ui_review_payload")
    .eq("id", uploadedFileId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch uploaded_files snapshot: ${error.message}`);
  return data ?? null;
}

async function fetchStageRuns({ supabaseAdmin, orgId, extractionRunId }: { supabaseAdmin: any; orgId: string; extractionRunId: string | null }) {
  if (!extractionRunId) return [];
  const { data, error } = await supabaseAdmin
    .from("extraction_stage_runs")
    .select("stage, attempt, status, error_code, error_message, started_at, finished_at")
    .eq("run_id", extractionRunId)
    .eq("org_id", orgId);
  if (error) throw new Error(`Failed to fetch extraction_stage_runs: ${error.message}`);
  return data ?? [];
}

async function fetchLatestExtractionRun({ supabaseAdmin, orgId, uploadedFileId }: { supabaseAdmin: any; orgId: string; uploadedFileId: string | null }) {
  if (!uploadedFileId) return null;
  const { data, error } = await supabaseAdmin
    .from("extraction_runs")
    .select("id, status, run_type")
    .eq("uploaded_file_id", uploadedFileId)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch extraction_runs: ${error.message}`);
  return data ?? null;
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
    runId: typeof body?.run_id === "string" ? body.run_id : null,
    uploadedFileId: typeof body?.uploaded_file_id === "string" ? body.uploaded_file_id : null,
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    if (!["GET", "POST"].includes(req.method)) {
      return jsonResponse({ error: true, message: "Method not allowed", diagnostic_only: true }, 405);
    }

    const parsed = await parseRequest(req);
    if (!parsed.runId && !parsed.uploadedFileId) {
      return jsonResponse(
        { error: true, message: "One of run_id or uploaded_file_id is required", diagnostic_only: true },
        400,
      );
    }

    const run = await resolveRun({ supabaseAdmin, orgId, runId: parsed.runId, uploadedFileId: parsed.uploadedFileId });
    const uploadedFileId = parsed.uploadedFileId ?? (run?.uploaded_file_id as string | undefined) ?? null;

    const [uploadedFile, claims, projections, extractionRun, readiness] = await Promise.all([
      fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId }),
      run ? fetchRunClaims({ supabaseAdmin, orgId, runId: run.id as string }) : Promise.resolve([]),
      run ? fetchRunCanonicalFieldProjections({ supabaseAdmin, orgId, runId: run.id as string }) : Promise.resolve([]),
      fetchLatestExtractionRun({ supabaseAdmin, orgId, uploadedFileId }),
      run ? evaluateDocumentIntelligenceV3Readiness({ supabaseAdmin, orgId, runId: run.id as string }) : Promise.resolve(null),
    ]);

    const [evidence, validationDrops, stageRuns] = await Promise.all([
      claims.length > 0
        ? fetchClaimEvidence({ supabaseAdmin, orgId, claimIds: claims.map((c: any) => c.id) })
        : Promise.resolve([]),
      run ? fetchRunValidationDrops({ supabaseAdmin, orgId, runId: run.id as string }) : Promise.resolve([]),
      fetchStageRuns({ supabaseAdmin, orgId, extractionRunId: extractionRun?.id ?? null }),
    ]);

    const legacyFields = uploadedFile?.ui_review_payload?.records?.[0]?.standard_fields ?? [];
    const legacyFieldCount = legacyFields.filter((f: any) => f?.value !== null && f?.value !== undefined && f?.value !== "").length;

    const metrics = buildRunOperationalMetrics({
      run,
      claims,
      evidence,
      validationDrops,
      projections,
      stageRuns,
      legacyFieldCount,
      readiness,
    });

    const businessExtractionProvider = currentBusinessExtractionProvider();
    const provenanceEnabled = isExtractionProvenanceEnabled();
    const actualCounts = {
      document_intelligence_runs: run ? 1 : 0,
      document_claims: claims.length,
      document_claim_evidence: evidence.length,
      document_validation_drops: validationDrops.length,
      document_canonical_field_projections: projections.length,
      extraction_runs: extractionRun ? 1 : 0,
      extraction_stage_runs: stageRuns.length,
    };
    const tableHealth = evaluateTableExpectations(businessExtractionProvider, actualCounts, provenanceEnabled);

    return jsonResponse({
      error: false,
      diagnostic_only: true,
      run_metrics: {
        run_id: run?.id ?? null,
        uploaded_file_id: uploadedFileId,
        metrics,
        table_health: tableHealth,
        transport_wrapper_readiness: evaluateTransportWrapperReadiness(),
      },
      diagnostics_context: buildDiagnosticsContext({ run, businessExtractionProvider }),
    });
  } catch (error: any) {
    console.error(`[document-intelligence-v3-run-metrics] error: ${error?.message ?? error}`);
    return jsonResponse(
      {
        error: true,
        diagnostic_only: true,
        message: error?.message ?? "Failed to compute Document Intelligence v3 run metrics",
      },
      500,
    );
  }
});
