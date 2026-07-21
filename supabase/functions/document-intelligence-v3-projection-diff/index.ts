// @ts-nocheck
/**
 * Document Intelligence v3 — Projection Diff Endpoint (Release 2)
 *
 * Read-only diagnostic comparison between the live ui_review_payload
 * ("legacy") and a v3 run's document_canonical_field_projections
 * ("canonical"), per field, with type-aware normalization. Mirrors
 * document-intelligence-v3-advisory-audit/index.ts's structure exactly.
 * Never mutates leases or uploaded_files. No new persistent table -- this
 * stays a diagnostic endpoint like the other four v3 edge functions.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { resolveRun, fetchRunClaims, fetchRunCanonicalFieldProjections } from "../_shared/extraction/document-intelligence-v3/projection-reader.ts";
import { buildProjectionDiff, summarizeProjectionDiff } from "../_shared/extraction/document-intelligence-v3/projection-diff.ts";
import { buildDiagnosticsContext } from "../_shared/extraction/document-intelligence-v3/run-metrics.ts";
import { normalizeBusinessExtractionMode } from "../_shared/extraction/business-extraction-provenance.ts";

// Diagnostic display only -- never throws (source: "persisted_row" defaults
// any unrecognized/unset value to "legacy_hybrid" instead of failing
// closed, which is the right behavior for provider SELECTION but not for
// a read-only diagnostic reporting what's currently configured).
function currentBusinessExtractionProvider(): string {
  return normalizeBusinessExtractionMode(Deno.env.get("BUSINESS_EXTRACTION_PROVIDER"), { source: "persisted_row" });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    if (!run) {
      return jsonResponse({
        error: false,
        diagnostic_only: true,
        projection_diff: {
          comparison_status: "unavailable_no_fact_ledger",
          summary: null,
          diffs: [],
          reason: "No completed Document Intelligence v3 run found for this document.",
        },
      });
    }

    const uploadedFileId = parsed.uploadedFileId ?? (run.uploaded_file_id as string);
    const [uploadedFile, claims, projections] = await Promise.all([
      fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId }),
      fetchRunClaims({ supabaseAdmin, orgId, runId: run.id as string }),
      fetchRunCanonicalFieldProjections({ supabaseAdmin, orgId, runId: run.id as string }),
    ]);

    const legacyFields = uploadedFile?.ui_review_payload?.records?.[0]?.standard_fields ?? [];
    const moduleType = uploadedFile?.module_type ?? "lease";
    const businessExtractionProvider = currentBusinessExtractionProvider();

    const { diffs, comparisonStatus } = buildProjectionDiff({
      documentId: uploadedFileId,
      legacyFields,
      canonicalProjections: projections,
      hasClaims: claims.length > 0,
      moduleType,
    });
    const summary = summarizeProjectionDiff(diffs, comparisonStatus);

    return jsonResponse({
      error: false,
      diagnostic_only: true,
      projection_diff: {
        run_id: run.id,
        uploaded_file_id: uploadedFileId,
        comparison_status: comparisonStatus,
        summary,
        diffs,
      },
      diagnostics_context: buildDiagnosticsContext({ run, businessExtractionProvider }),
    });
  } catch (error: any) {
    console.error(`[document-intelligence-v3-projection-diff] error: ${error?.message ?? error}`);
    return jsonResponse(
      {
        error: true,
        diagnostic_only: true,
        message: error?.message ?? "Failed to compute Document Intelligence v3 projection diff",
      },
      500,
    );
  }
});
