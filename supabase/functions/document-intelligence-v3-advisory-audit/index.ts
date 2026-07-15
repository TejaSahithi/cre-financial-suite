// @ts-nocheck
/**
 * Document Intelligence v3 - Advisory Audit Endpoint (Phase 14)
 *
 * Read-only diagnostic comparison between the v3 approval advisory and the
 * current persisted Lease Review readiness payload. It does not call
 * approve_lease_workflow, does not call review-approve, and does not mutate
 * leases or uploaded_files. Durable audit storage is intentionally deferred:
 * persist_snapshot=true returns an explicit deferred marker.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { evaluateDocumentIntelligenceV3Readiness } from "../_shared/extraction/document-intelligence-v3/readiness.ts";
import { buildAdvisoryAudit } from "../_shared/extraction/document-intelligence-v3/advisory-audit.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveLatestRunIdByLease({ supabaseAdmin, orgId, leaseId }: { supabaseAdmin: any; orgId: string; leaseId: string | null }) {
  if (!leaseId) return null;
  const { data, error } = await supabaseAdmin
    .from("document_intelligence_runs")
    .select("id, uploaded_file_id")
    .eq("lease_id", leaseId)
    .eq("org_id", orgId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve v3 run by lease_id: ${error.message}`);
  return data ?? null;
}

async function fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId }: { supabaseAdmin: any; orgId: string; uploadedFileId: string | null }) {
  if (!uploadedFileId) return null;
  const { data, error } = await supabaseAdmin
    .from("uploaded_files")
    .select("id, org_id, lease_id, status, processing_status, review_status, ui_review_payload, normalized_output, parsed_data, module_type, updated_at")
    .eq("id", uploadedFileId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch uploaded_files snapshot: ${error.message}`);
  return data ?? null;
}

async function fetchLease({ supabaseAdmin, orgId, leaseId, uploadedFileId }: { supabaseAdmin: any; orgId: string; leaseId: string | null; uploadedFileId: string | null }) {
  if (leaseId) {
    const { data, error } = await supabaseAdmin
      .from("leases")
      .select("id, org_id, source_file_id, review_status, approval_status, extraction_data, updated_at")
      .eq("id", leaseId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Failed to fetch leases snapshot by id: ${error.message}`);
    if (data) return data;
  }

  if (uploadedFileId) {
    const { data, error } = await supabaseAdmin
      .from("leases")
      .select("id, org_id, source_file_id, review_status, approval_status, extraction_data, updated_at")
      .eq("source_file_id", uploadedFileId)
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to fetch leases snapshot by source_file_id: ${error.message}`);
    return data ?? null;
  }

  return null;
}

function parseRequest(req: Request) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return {
      runId: url.searchParams.get("run_id") || null,
      uploadedFileId: url.searchParams.get("uploaded_file_id") || null,
      leaseId: url.searchParams.get("lease_id") || null,
      persistSnapshot: url.searchParams.get("persist_snapshot") === "true",
    };
  }
  return req.json().catch(() => ({})).then((body: any) => ({
    runId: typeof body?.run_id === "string" ? body.run_id : null,
    uploadedFileId: typeof body?.uploaded_file_id === "string" ? body.uploaded_file_id : null,
    leaseId: typeof body?.lease_id === "string" ? body.lease_id : null,
    persistSnapshot: body?.persist_snapshot === true,
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
    let runId = parsed.runId;
    let uploadedFileId = parsed.uploadedFileId;
    let leaseId = parsed.leaseId;

    if (!runId && !uploadedFileId && !leaseId) {
      return jsonResponse(
        { error: true, message: "One of run_id, uploaded_file_id, or lease_id is required", diagnostic_only: true },
        400,
      );
    }

    if (!runId && !uploadedFileId && leaseId) {
      const run = await resolveLatestRunIdByLease({ supabaseAdmin, orgId, leaseId });
      runId = run?.id ?? null;
      uploadedFileId = run?.uploaded_file_id ?? null;
    }

    const readiness = await evaluateDocumentIntelligenceV3Readiness({
      supabaseAdmin,
      orgId,
      runId,
      uploadedFileId,
    });

    uploadedFileId = uploadedFileId ?? readiness?.uploaded_file_id ?? null;
    leaseId = leaseId ?? readiness?.lease_id ?? null;

    const [uploadedFile, lease] = await Promise.all([
      fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId }),
      fetchLease({ supabaseAdmin, orgId, leaseId, uploadedFileId }),
    ]);

    const advisoryAudit = buildAdvisoryAudit({
      readiness,
      v3Advisory: readiness?.approval_advisory ?? null,
      uploadedFile,
      lease,
    });

    return jsonResponse({
      error: false,
      diagnostic_only: true,
      advisory_audit: {
        ...advisoryAudit,
        snapshot_persistence: parsed.persistSnapshot
          ? {
              requested: true,
              persisted: false,
              reason: "document_intelligence_advisory_audits durable storage deferred in Phase 14",
            }
          : { requested: false, persisted: false, reason: "read_only_default" },
      },
    });
  } catch (error: any) {
    console.error(`[document-intelligence-v3-advisory-audit] error: ${error?.message ?? error}`);
    return jsonResponse(
      {
        error: true,
        diagnostic_only: true,
        message: error?.message ?? "Failed to compute Document Intelligence v3 advisory audit",
      },
      500,
    );
  }
});
