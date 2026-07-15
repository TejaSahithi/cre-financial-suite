// @ts-nocheck
/**
 * Document Intelligence v3 - Batch Advisory Audit Endpoint (Phase 15)
 *
 * Read-only diagnostic batch report comparing v3 approval advisory behavior
 * against current persisted Lease Review readiness behavior. This endpoint
 * performs no writes, does not call approval RPCs, and does not make v3 a gate.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { evaluateDocumentIntelligenceV3Readiness } from "../_shared/extraction/document-intelligence-v3/readiness.ts";
import { buildAdvisoryAudit } from "../_shared/extraction/document-intelligence-v3/advisory-audit.ts";
import {
  buildBatchAdvisoryAuditReport,
  normalizeBatchAdvisoryAuditInput,
} from "../_shared/extraction/document-intelligence-v3/advisory-audit-batch.ts";

const MAX_BATCH_LIMIT = 25;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function splitIds(value: string | null) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function parseRequest(req: Request) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return normalizeBatchAdvisoryAuditInput({
      uploaded_file_ids: splitIds(url.searchParams.get("uploaded_file_ids") || url.searchParams.get("uploaded_file_id")),
      run_ids: splitIds(url.searchParams.get("run_ids") || url.searchParams.get("run_id")),
      lease_ids: splitIds(url.searchParams.get("lease_ids") || url.searchParams.get("lease_id")),
      limit: url.searchParams.get("limit"),
    });
  }
  const body = await req.json().catch(() => ({}));
  return normalizeBatchAdvisoryAuditInput(body);
}

function capLimit(limit: number | null) {
  if (limit == null || limit <= 0) return MAX_BATCH_LIMIT;
  return Math.min(limit, MAX_BATCH_LIMIT);
}

function uniqueWorkItems(input: any, limit: number) {
  const seen = new Set<string>();
  const items = [];
  const add = (kind: string, id: string) => {
    const key = `${kind}:${id}`;
    if (seen.has(key) || items.length >= limit) return;
    seen.add(key);
    items.push({ kind, id });
  };
  for (const id of input.uploaded_file_ids) add("uploaded_file_id", id);
  for (const id of input.run_ids) add("run_id", id);
  for (const id of input.lease_ids) add("lease_id", id);
  return items;
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

async function buildAuditForWorkItem({ supabaseAdmin, orgId, workItem }: { supabaseAdmin: any; orgId: string; workItem: any }) {
  let runId = workItem.kind === "run_id" ? workItem.id : null;
  let uploadedFileId = workItem.kind === "uploaded_file_id" ? workItem.id : null;
  let leaseId = workItem.kind === "lease_id" ? workItem.id : null;

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

  return buildAdvisoryAudit({
    readiness,
    v3Advisory: readiness?.approval_advisory ?? null,
    uploadedFile,
    lease,
  });
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

    const input = await parseRequest(req);
    const limit = capLimit(input.limit);
    const workItems = uniqueWorkItems(input, limit);

    if (workItems.length === 0) {
      return jsonResponse({
        error: false,
        diagnostic_only: true,
        batch_audit: buildBatchAdvisoryAuditReport({ audits: [], input: { ...input, limit } }),
      });
    }

    const audits = [];
    for (const workItem of workItems) {
      audits.push(await buildAuditForWorkItem({ supabaseAdmin, orgId, workItem }));
    }

    return jsonResponse({
      error: false,
      diagnostic_only: true,
      batch_audit: buildBatchAdvisoryAuditReport({ audits, input: { ...input, limit } }),
    });
  } catch (error: any) {
    console.error(`[document-intelligence-v3-advisory-audit-batch] error: ${error?.message ?? error}`);
    return jsonResponse(
      {
        error: true,
        diagnostic_only: true,
        message: error?.message ?? "Failed to compute Document Intelligence v3 batch advisory audit",
      },
      500,
    );
  }
});