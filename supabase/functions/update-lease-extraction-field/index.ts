// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_VALUE_ACTIONS = new Set(["field_evidence_edit", "custom_field_added"]);
const SOURCE_LINK_ACTIONS = new Set([
  "source_file_manually_linked",
  "source_file_auto_linked",
  "source_file_linked_on_upload",
  "source_file_relinked_debug",
]);
const LEASE_FLAG_ACTIONS = new Set(["document_type_override_set"]);
const ACTIONS_BY_AREA: Record<string, Set<string>> = {
  field_value: FIELD_VALUE_ACTIONS,
  source_link: SOURCE_LINK_ACTIONS,
  lease_flag: LEASE_FLAG_ACTIONS,
};

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const fieldArea = String(body.field_area || "").trim();
  const allowedActions = ACTIONS_BY_AREA[fieldArea];
  if (!allowedActions) {
    throw new Error(`field_area must be one of ${Object.keys(ACTIONS_BY_AREA).join(", ")}`);
  }

  const action = String(body.action || "").trim();
  if (!allowedActions.has(action)) {
    throw new Error(`action must be one of ${[...allowedActions].join(", ")}`);
  }

  const fieldKey = body.field_key != null ? String(body.field_key).trim() : "";
  if (fieldArea === "field_value" && !fieldKey) {
    throw new Error("field_key is required for field_area=field_value");
  }

  const patch = body.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch must be an object");
  }

  return { leaseId, fieldArea, action, fieldKey: fieldKey || null, patch };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/approved and locked/i.test(message)) return 409;
  if (/required|not found|must be one of|is not permitted/i.test(message)) return 400;
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

    const { data, error } = await supabaseAdmin.rpc("update_lease_extraction_field", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_field_area: payload.fieldArea,
      p_action: payload.action,
      p_field_key: payload.fieldKey,
      p_patch: payload.patch,
    });

    if (error) {
      throw new Error(error.message || "update_lease_extraction_field failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not update lease extraction field";
    return jsonResponse({
      error: true,
      message,
      error_code: "UPDATE_LEASE_EXTRACTION_FIELD_FAILED",
    }, errorStatus(message));
  }
});
