// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { buildCanonicalReviewReadinessMetrics } from "../_shared/extraction/document-intelligence-v3/canonical-review-readiness-metrics.ts";

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
      uploadedFileId: url.searchParams.get("uploaded_file_id") || null,
      runId: url.searchParams.get("run_id") || null,
      since: url.searchParams.get("since") || null,
      limit: Math.min(Number(url.searchParams.get("limit") || 200) || 200, 1000),
    };
  }
  return req.json().catch(() => ({})).then((body: any) => ({
    uploadedFileId: body?.uploadedFileId ?? body?.uploaded_file_id ?? null,
    runId: body?.runId ?? body?.run_id ?? null,
    since: body?.since ?? null,
    limit: Math.min(Number(body?.limit ?? 200) || 200, 1000),
  }));
}

async function fetchRows(args: { supabaseAdmin: any; orgId: string; uploadedFileId?: string | null; runId?: string | null; since?: string | null; limit: number }) {
  let runsQuery = args.supabaseAdmin
    .from("document_intelligence_runs")
    .select("id, org_id, uploaded_file_id, generation_id, status, created_at")
    .eq("org_id", args.orgId)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  let payloadQuery = args.supabaseAdmin
    .from("document_enterprise_review_payloads")
    .select("id, org_id, uploaded_file_id, run_id, generation_id, payload, payload_hash, rollout_mode, rollout_source, integrity_violation_count, fallback_count, material_mismatch_count, blocking_finding_count, created_at")
    .eq("org_id", args.orgId)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  let overrideQuery = args.supabaseAdmin
    .from("document_field_review_overrides")
    .select("id, org_id, uploaded_file_id, run_id, generation_id, canonical_field_key, action, is_active, created_at")
    .eq("org_id", args.orgId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(args.limit);

  if (args.uploadedFileId) {
    runsQuery = runsQuery.eq("uploaded_file_id", args.uploadedFileId);
    payloadQuery = payloadQuery.eq("uploaded_file_id", args.uploadedFileId);
    overrideQuery = overrideQuery.eq("uploaded_file_id", args.uploadedFileId);
  }
  if (args.runId) {
    runsQuery = runsQuery.eq("id", args.runId);
    payloadQuery = payloadQuery.eq("run_id", args.runId);
    overrideQuery = overrideQuery.eq("run_id", args.runId);
  }
  if (args.since) {
    runsQuery = runsQuery.gte("created_at", args.since);
    payloadQuery = payloadQuery.gte("created_at", args.since);
    overrideQuery = overrideQuery.gte("created_at", args.since);
  }

  const [runsResult, payloadsResult, overridesResult] = await Promise.all([runsQuery, payloadQuery, overrideQuery]);
  if (runsResult.error) throw new Error(`Failed to fetch document intelligence runs: ${runsResult.error.message}`);
  if (payloadsResult.error) throw new Error(`Failed to fetch enterprise review payloads: ${payloadsResult.error.message}`);
  if (overridesResult.error) throw new Error(`Failed to fetch review overrides: ${overridesResult.error.message}`);
  return { runs: runsResult.data ?? [], payloadRows: payloadsResult.data ?? [], overrideRows: overridesResult.data ?? [] };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(req.method)) return jsonResponse({ error: true, message: "Method not allowed" }, 405);

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const parsed = await parseRequest(req);
    const rows = await fetchRows({ supabaseAdmin, orgId, ...parsed });
    const metrics = buildCanonicalReviewReadinessMetrics(rows);
    return jsonResponse({ error: false, readinessMetrics: metrics, diagnostics: { orgId, filters: parsed, rowCounts: { runs: rows.runs.length, payloads: rows.payloadRows.length, overrides: rows.overrideRows.length } } });
  } catch (error: any) {
    console.error(`[document-intelligence-v4-readiness-metrics] error: ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Failed to load canonical review readiness metrics" }, 500);
  }
});
