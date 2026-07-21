// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { buildCanonicalReviewFieldRegistry } from "../_shared/extraction/document-intelligence-v3/canonical-review-field-registry.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ACTION_MAP: Record<string, string> = {
  accept: "accepted",
  accepted: "accepted",
  override: "overridden",
  overridden: "overridden",
  clear: "cleared",
  cleared: "cleared",
  "not applicable": "marked_not_applicable",
  not_applicable: "marked_not_applicable",
  marked_not_applicable: "marked_not_applicable",
  needs_followup: "needs_followup",
  "needs follow-up": "needs_followup",
};

function normalizeAction(action: unknown): string | null {
  if (typeof action !== "string") return null;
  return ACTION_MAP[action.trim().toLowerCase()] ?? null;
}

function validateOverrideValue(valueType: string, value: unknown): string | null {
  if (value == null) return null;
  if (["number", "currency", "percentage"].includes(valueType) && typeof value !== "number") return "Override value must be numeric.";
  if (valueType === "boolean" && typeof value !== "boolean") return "Override value must be boolean.";
  if (valueType === "array" && !Array.isArray(value)) return "Override value must be an array.";
  if (valueType === "object" && (typeof value !== "object" || Array.isArray(value))) return "Override value must be an object.";
  return null;
}

async function fetchUploadedFile(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string }) {
  const { data, error } = await args.supabaseAdmin
    .from("uploaded_files")
    .select("id, org_id, module_type, active_generation_id")
    .eq("org_id", args.orgId)
    .eq("id", args.uploadedFileId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch uploaded file: ${error.message}`);
  return data ?? null;
}

async function fetchRun(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string }) {
  const { data, error } = await args.supabaseAdmin
    .from("document_intelligence_runs")
    .select("id, org_id, uploaded_file_id, generation_id")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("id", args.runId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch document intelligence run: ${error.message}`);
  return data ?? null;
}

async function fetchProjection(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string; fieldKey: string; generationId?: string | null }) {
  let query = args.supabaseAdmin
    .from("document_canonical_field_projections")
    .select("id, value, normalized_value, uploaded_file_id, generation_id")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("field_key", args.fieldKey);
  if (args.generationId) query = query.eq("generation_id", args.generationId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to fetch original projection: ${error.message}`);
  return data ?? null;
}

async function fetchCurrentPayload(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string }) {
  const { data, error } = await args.supabaseAdmin
    .from("document_enterprise_review_payloads")
    .select("id, generation_id, is_current")
    .eq("org_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("schema_version", "enterprise-review-payload-v1")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch current enterprise payload: ${error.message}`);
  return data ?? null;
}

function staleGenerationResponse(args: { currentRunId: string | null; currentGenerationId: string | null }) {
  return jsonResponse({
    error: true,
    errorCode: "stale_review_generation",
    message: "The review action targets a stale document generation.",
    currentRunId: args.currentRunId,
    currentGenerationId: args.currentGenerationId,
  }, 409);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: true, message: "Method not allowed" }, 405);

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const body = await req.json().catch(() => ({}));
    const uploadedFileId = body.uploadedFileId ?? body.uploaded_file_id;
    const runId = body.runId ?? body.run_id;
    const requestedGenerationId = body.generationId ?? body.generation_id ?? null;
    const canonicalFieldKey = body.canonicalFieldKey ?? body.canonical_field_key;
    const action = normalizeAction(body.action);
    const reason = typeof body.reason === "string" ? body.reason.trim() : null;

    if (!uploadedFileId || !runId || !canonicalFieldKey || !action) {
      return jsonResponse({ error: true, message: "uploadedFileId, runId, canonicalFieldKey, and a valid action are required" }, 400);
    }

    const uploadedFile = await fetchUploadedFile({ supabaseAdmin, orgId, uploadedFileId });
    if (!uploadedFile) return jsonResponse({ error: true, message: "Uploaded file not found for organization" }, 404);
    const run = await fetchRun({ supabaseAdmin, orgId, uploadedFileId, runId });
    if (!run) return jsonResponse({ error: true, message: "Document intelligence run not found for uploaded file" }, 404);

    const currentGenerationId = uploadedFile.active_generation_id ?? run.generation_id ?? null;
    if (requestedGenerationId && currentGenerationId && requestedGenerationId !== currentGenerationId) {
      return staleGenerationResponse({ currentRunId: run.id, currentGenerationId });
    }
    if (run.generation_id && uploadedFile.active_generation_id && run.generation_id !== uploadedFile.active_generation_id) {
      return staleGenerationResponse({ currentRunId: run.id, currentGenerationId });
    }

    const field = buildCanonicalReviewFieldRegistry(uploadedFile.module_type ?? "lease").find((entry) => entry.canonicalFieldKey === canonicalFieldKey);
    if (!field) return jsonResponse({ error: true, message: `Field ${canonicalFieldKey} is not registered for canonical review` }, 400);
    if (!field.allowReviewerOverride) return jsonResponse({ error: true, message: `Field ${canonicalFieldKey} does not allow reviewer override` }, 400);
    if (action === "overridden" && field.requiredForApproval && !reason) {
      return jsonResponse({ error: true, message: "Reason is required for material overrides" }, 400);
    }
    const typeError = validateOverrideValue(field.valueType, body.overrideValue ?? body.override_value ?? null);
    if (typeError) return jsonResponse({ error: true, message: typeError }, 400);

    const currentPayload = await fetchCurrentPayload({ supabaseAdmin, orgId, uploadedFileId, runId });
    if (currentPayload?.generation_id && currentGenerationId && currentPayload.generation_id !== currentGenerationId) {
      return staleGenerationResponse({ currentRunId: run.id, currentGenerationId });
    }

    const projection = await fetchProjection({ supabaseAdmin, orgId, uploadedFileId, runId, fieldKey: canonicalFieldKey, generationId: currentGenerationId });

    await supabaseAdmin
      .from("document_field_review_overrides")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("uploaded_file_id", uploadedFileId)
      .eq("run_id", runId)
      .eq("canonical_field_key", canonicalFieldKey)
      .eq("is_active", true);

    const effectiveGenerationId = currentGenerationId ?? requestedGenerationId ?? null;
    const { data, error } = await supabaseAdmin
      .from("document_field_review_overrides")
      .insert({
        org_id: orgId,
        uploaded_file_id: uploadedFileId,
        run_id: runId,
        generation_id: effectiveGenerationId,
        canonical_field_key: canonicalFieldKey,
        original_projection_id: projection?.id ?? null,
        original_value: projection?.normalized_value ?? projection?.value ?? null,
        override_value: body.overrideValue ?? body.override_value ?? null,
        action,
        reason,
        reviewer_id: user.id,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to persist review override: ${error.message}`);

    await supabaseAdmin
      .from("document_enterprise_review_payloads")
      .update({ is_current: false, superseded_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("uploaded_file_id", uploadedFileId)
      .eq("run_id", runId)
      .eq("schema_version", "enterprise-review-payload-v1")
      .eq("is_current", true);

    return jsonResponse({ error: false, overrideId: data?.id ?? null, action, canonicalFieldKey, generationId: effectiveGenerationId });
  } catch (error: any) {
    console.error(`[document-field-review-action] error: ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Failed to persist review action" }, 500);
  }
});
