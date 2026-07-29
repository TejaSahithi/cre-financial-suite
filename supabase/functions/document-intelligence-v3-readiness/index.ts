// @ts-nocheck
/**
 * Document Intelligence v3 — Readiness Diagnostic Endpoint (Phase 3)
 *
 * Read-only. Given a run_id or an uploaded_file_id, returns a profile-aware
 * advisory readiness diagnostic computed from the durable v3 tables
 * (document_intelligence_runs / document_claims / document_claim_evidence /
 * document_validation_drops / document_canonical_field_projections). Every
 * response carries diagnostic_only: true. This endpoint performs no writes
 * and is not called by, or wired into, any approval path -- see
 * docs/lease-extraction-architecture-audit-2026-07-29.md and the Phase 1-2 baseline for
 * why that gate still lives entirely in approve_lease_workflow /
 * LeaseReview.jsx, unchanged by this phase.
 *
 * Auth follows the same pattern as pipeline-status/index.ts (the closest
 * existing read-only diagnostic endpoint): verifyUser() resolves the caller
 * and a service-role client, getUserOrgId() resolves their org. Every query
 * additionally filters by that org_id explicitly (defense in depth on top
 * of the tables' own is_member_of_org(org_id) RLS SELECT policies).
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { evaluateDocumentIntelligenceV3Readiness } from "../_shared/extraction/document-intelligence-v3/readiness.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    let runId: string | null = null;
    let uploadedFileId: string | null = null;

    if (req.method === "GET") {
      const url = new URL(req.url);
      runId = url.searchParams.get("run_id") || null;
      uploadedFileId = url.searchParams.get("uploaded_file_id") || null;
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      runId = typeof body?.run_id === "string" ? body.run_id : null;
      uploadedFileId = typeof body?.uploaded_file_id === "string" ? body.uploaded_file_id : null;
    } else {
      return jsonResponse({ error: true, message: "Method not allowed" }, 405);
    }

    if (!runId && !uploadedFileId) {
      return jsonResponse(
        { error: true, message: "One of run_id or uploaded_file_id is required", diagnostic_only: true },
        400,
      );
    }

    const readiness = await evaluateDocumentIntelligenceV3Readiness({
      supabaseAdmin,
      orgId,
      runId,
      uploadedFileId,
    });

    return jsonResponse({
      error: false,
      diagnostic_only: true,
      readiness,
    });
  } catch (error: any) {
    console.error(`[document-intelligence-v3-readiness] error: ${error?.message ?? error}`);
    return jsonResponse(
      {
        error: true,
        diagnostic_only: true,
        message: error?.message ?? "Failed to compute Document Intelligence v3 readiness diagnostic",
      },
      500,
    );
  }
});
