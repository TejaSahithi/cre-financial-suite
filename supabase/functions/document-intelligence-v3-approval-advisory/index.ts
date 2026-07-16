// @ts-nocheck
/**
 * Document Intelligence v3 - Approval Advisory Endpoint (Phase 13)
 *
 * Read-only, diagnostic-only simulation of a future server-side approval
 * gate. This endpoint performs no approval side effects and does not call
 * approve_lease_workflow or review-approve.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { evaluateDocumentIntelligenceV3Readiness } from "../_shared/extraction/document-intelligence-v3/readiness.ts";
import { buildApprovalAdvisoryFromReadiness } from "../_shared/extraction/document-intelligence-v3/approval-advisory.ts";

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
    let leaseId: string | null = null;

    if (req.method === "GET") {
      const url = new URL(req.url);
      runId = url.searchParams.get("run_id") || null;
      uploadedFileId = url.searchParams.get("uploaded_file_id") || null;
      leaseId = url.searchParams.get("lease_id") || null;
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      runId = typeof body?.run_id === "string" ? body.run_id : null;
      uploadedFileId = typeof body?.uploaded_file_id === "string" ? body.uploaded_file_id : null;
      leaseId = typeof body?.lease_id === "string" ? body.lease_id : null;
    } else {
      return jsonResponse({ error: true, message: "Method not allowed", diagnostic_only: true }, 405);
    }

    if (!runId && !uploadedFileId && !leaseId) {
      return jsonResponse(
        { error: true, message: "One of run_id, uploaded_file_id, or lease_id is required", diagnostic_only: true },
        400,
      );
    }

    if (!runId && !uploadedFileId && leaseId) {
      const { data: run, error } = await supabaseAdmin
        .from("document_intelligence_runs")
        .select("id")
        .eq("lease_id", leaseId)
        .eq("org_id", orgId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to resolve v3 run by lease_id: ${error.message}`);
      runId = run?.id ?? null;
    }

    const readiness = await evaluateDocumentIntelligenceV3Readiness({
      supabaseAdmin,
      orgId,
      runId,
      uploadedFileId,
    });
    const approvalAdvisory = readiness?.approval_advisory ?? buildApprovalAdvisoryFromReadiness(readiness);

    return jsonResponse({
      error: false,
      diagnostic_only: true,
      approval_advisory: approvalAdvisory,
    });
  } catch (error: any) {
    console.error(`[document-intelligence-v3-approval-advisory] error: ${error?.message ?? error}`);
    return jsonResponse(
      {
        error: true,
        diagnostic_only: true,
        message: error?.message ?? "Failed to compute Document Intelligence v3 approval advisory",
      },
      500,
    );
  }
});
