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
  override: "overridden",
  clear: "cleared",
  "not applicable": "marked_not_applicable",
  not_applicable: "marked_not_applicable",
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

async function fetchProjection(args: { supabaseAdmin: any; orgId: string; runId: string; fieldKey: string }) {
  const { data, error } = await args.supabaseAdmin
    .from("document_canonical_field_projections")
    .select("id, value, normalized_value")
    .eq("org_id", args.orgId)
    .eq("run_id", args.runId)
    .eq("field_key", args.fieldKey)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch original projection: ${error.message}`);
  return data ?? null;
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
    const generationId = body.generationId ?? body.generation_id ?? null;
    const canonicalFieldKey = body.canonicalFieldKey ?? body.canonical_field_key;
    const action = normalizeAction(body.action);
    const reason = typeof body.reason === "string" ? body.reason.trim() : null;

    if (!uploadedFileId || !runId || !canonicalFieldKey || !action) {
      return jsonResponse({ error: true, message: "uploadedFileId, runId, canonicalFieldKey, and a valid action are required" }, 400);
    }

    const field = buildCanonicalReviewFieldRegistry("lease").find((entry) => entry.canonicalFieldKey === canonicalFieldKey);
    if (!field) return jsonResponse({ error: true, message: `Field ${canonicalFieldKey} is not registered for canonical review` }, 400);
    if (!field.allowReviewerOverride) return jsonResponse({ error: true, message: `Field ${canonicalFieldKey} does not allow reviewer override` }, 400);
    if (action === "overridden" && field.requiredForApproval && !reason) {
      return jsonResponse({ error: true, message: "Reason is required for material overrides" }, 400);
    }
    const typeError = validateOverrideValue(field.valueType, body.overrideValue ?? body.override_value ?? null);
    if (typeError) return jsonResponse({ error: true, message: typeError }, 400);

    const projection = await fetchProjection({ supabaseAdmin, orgId, runId, fieldKey: canonicalFieldKey });

    await supabaseAdmin
      .from("document_field_review_overrides")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("uploaded_file_id", uploadedFileId)
      .eq("run_id", runId)
      .eq("canonical_field_key", canonicalFieldKey)
      .eq("is_active", true);

    const { data, error } = await supabaseAdmin
      .from("document_field_review_overrides")
      .insert({
        org_id: orgId,
        uploaded_file_id: uploadedFileId,
        run_id: runId,
        generation_id: generationId,
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

    return jsonResponse({ error: false, overrideId: data?.id ?? null, action, canonicalFieldKey });
  } catch (error: any) {
    console.error(`[document-field-review-action] error: ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Failed to persist review action" }, 500);
  }
});