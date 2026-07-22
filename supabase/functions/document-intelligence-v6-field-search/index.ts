// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isSemanticFieldSearchV6Enabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildSemanticFieldSearchResponse } from "../_shared/extraction/document-semantics/semantic-field-search.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

async function parseRequest(req: Request) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    return {
      query: url.searchParams.get("query") ?? url.searchParams.get("q") ?? "",
      uploadedFileId: url.searchParams.get("uploaded_file_id") ?? url.searchParams.get("uploadedFileId") ?? null,
      documentFamilyId: url.searchParams.get("document_family_id") ?? url.searchParams.get("documentFamilyId") ?? null,
      entityTypes: url.searchParams.getAll("entity_type").concat(url.searchParams.getAll("entityTypes")),
      statuses: url.searchParams.getAll("status").concat(url.searchParams.getAll("statuses")),
      limit: Number(url.searchParams.get("limit") ?? 20),
    };
  }

  const body = await req.json().catch(() => ({}));
  return {
    query: String(body?.query ?? body?.q ?? ""),
    uploadedFileId: body?.uploadedFileId ?? body?.uploaded_file_id ?? null,
    documentFamilyId: body?.documentFamilyId ?? body?.document_family_id ?? null,
    entityTypes: asStringArray(body?.entityTypes ?? body?.entity_types),
    statuses: asStringArray(body?.statuses),
    limit: Number(body?.limit ?? 20),
  };
}

function rowToSearchRecord(row: any) {
  return {
    entityType: row.entity_type,
    key: row.entity_key,
    label: row.label,
    matchedText: row.searchable_text,
    uploadedFileId: row.uploaded_file_id,
    documentFamilyId: row.document_family_id,
    runId: row.run_id,
    generationId: row.generation_id,
    fieldKey: row.field_key,
    sectionKey: row.section_key,
    pageNumber: row.page_number,
    status: row.status,
    source: row.source,
    score: 0,
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids : [],
    reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes : [],
  };
}
if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!["GET", "POST"].includes(req.method)) return jsonResponse({ error: true, message: "Method not allowed" }, 405);
    if (!isSemanticFieldSearchV6Enabled()) return jsonResponse({ error: true, message: "Semantic field search is disabled" }, 403);

    const parsed = await parseRequest(req);
    if (!String(parsed.query ?? "").trim()) return jsonResponse({ error: true, message: "query is required" }, 400);
    if (!parsed.uploadedFileId && !parsed.documentFamilyId) return jsonResponse({ error: true, message: "uploaded_file_id or document_family_id is required" }, 400);

    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    let query = supabaseAdmin
      .from("document_semantic_search_records")
      .select("entity_type, entity_key, label, searchable_text, uploaded_file_id, document_family_id, run_id, generation_id, field_key, section_key, page_number, status, source, evidence_ids, reason_codes")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500);

    if (parsed.uploadedFileId) query = query.eq("uploaded_file_id", parsed.uploadedFileId);
    if (parsed.documentFamilyId) query = query.eq("document_family_id", parsed.documentFamilyId);
    if (parsed.entityTypes.length) query = query.in("entity_type", parsed.entityTypes);
    if (parsed.statuses.length) query = query.in("status", parsed.statuses);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to search semantic records: ${error.message}`);

    return jsonResponse(buildSemanticFieldSearchResponse(parsed, (data ?? []).map(rowToSearchRecord)));
  } catch (error: any) {
    console.error(`[document-intelligence-v6-field-search] error: ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Failed to search semantic document records" }, 500);
  }
});