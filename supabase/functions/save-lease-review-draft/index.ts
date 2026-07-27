// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { getLeaseDocumentPackageMode } from "../_shared/extraction/document-package/feature-mode.ts";
import { getLeaseFinancialScheduleMode } from "../_shared/extraction/lease-financial-schedule/feature-mode.ts";
import { createLogger } from "../_shared/logger.ts";

// This route is lease_id-scoped, not file_id-scoped, but pipeline_logs is
// keyed on the source uploaded_files row. Resolve it best-effort so review
// actions land in the same activity log as the rest of the pipeline; a
// lease with no resolvable source file (or any lookup failure) simply skips
// logging rather than blocking the save.
async function resolveSourceFileId(supabaseAdmin: any, leaseId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("leases")
      .select("source_file_id")
      .eq("id", leaseId)
      .maybeSingle();
    return data?.source_file_id ?? null;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const fieldReviews = body.field_reviews;
  if (!fieldReviews || typeof fieldReviews !== "object" || Array.isArray(fieldReviews)) {
    throw new Error("field_reviews must be an object");
  }

  return { leaseId, fieldReviews };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/approved and locked|package-active|financial-active/i.test(message)) return 409;
  if (/required|not found|must be a|must be an/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["Leases", "LeaseUpload", "LeaseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);
    const sourceFileId = await resolveSourceFileId(supabaseAdmin, payload.leaseId);
    const logger = sourceFileId ? createLogger(supabaseAdmin, sourceFileId, orgId) : null;
    const uiContext = body?._uiContext ?? null;
    await logger?.event("review_draft", "started", {
      lease_id: payload.leaseId,
      field_count: Object.keys(payload.fieldReviews).length,
      ui: uiContext,
    });

    if (getLeaseDocumentPackageMode() === "active") {
      throw new Error("package-active review draft saves must use package reviewer decision routes");
    }
    if (getLeaseFinancialScheduleMode() === "active") {
      throw new Error("financial-active review draft saves must use P4 reviewer decision routes");
    }

    const { data, error } = await supabaseAdmin.rpc("save_lease_review_draft", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_field_reviews: payload.fieldReviews,
    });

    if (error) {
      await logger?.event("review_draft", "failed", { lease_id: payload.leaseId, reason: error.message });
      throw new Error(error.message || "save_lease_review_draft failed");
    }

    await logger?.event("review_draft", "succeeded", { lease_id: payload.leaseId, ui: uiContext });
    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not save lease review draft";
    return jsonResponse({
      error: true,
      message,
      error_code: "SAVE_LEASE_REVIEW_DRAFT_FAILED",
    }, errorStatus(message));
  }
});
