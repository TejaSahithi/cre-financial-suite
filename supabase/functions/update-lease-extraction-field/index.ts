// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { getLeaseFinancialScheduleMode } from "../_shared/extraction/lease-financial-schedule/feature-mode.ts";
import { createLogger } from "../_shared/logger.ts";

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
const FIELD_VALUE_ACTIONS = new Set(["field_evidence_edit", "field_accept_backfill", "custom_field_added"]);
const SOURCE_LINK_ACTIONS = new Set([
  "source_file_manually_linked",
  "source_file_auto_linked",
  "source_file_linked_on_upload",
  "source_file_relinked_debug",
]);
const LEASE_FLAG_ACTIONS = new Set(["document_type_override_set"]);
const P4_OWNED_FIELD_KEYS = new Set([
  "lease_date",
  "start_date",
  "end_date",
  "commencement_date",
  "expiration_date",
  "rent_commencement_date",
  "monthly_rent",
  "annual_rent",
  "rent_per_sf",
  "security_deposit",
  "ti_allowance",
  "lease_term_months",
  "late_fee_amount",
  "assignment_consideration",
]);
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
  if (/access denied|permission|different organization/i.test(message)) return 403;
  if (/approved and locked|financial-active/i.test(message)) return 409;
  if (/required|not found|must be one of|is not permitted/i.test(message)) return 400;
  return 500;
}

async function validateSourceFileForOrg(supabaseAdmin: any, orgId: string, sourceFileId: unknown) {
  const id = typeof sourceFileId === "string" ? sourceFileId.trim() : "";
  if (!id) throw new Error("source_file_id is required for source_link updates");
  if (!UUID_RE.test(id)) throw new Error("source_file_id must be a valid uploaded file id");

  const { data, error } = await supabaseAdmin
    .from("uploaded_files")
    .select("id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`Could not verify source_file_id: ${error.message}`);
  if (!data?.id) throw new Error("source_file_id belongs to a different organization or does not exist");
  return id;
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
    if (getLeaseFinancialScheduleMode() === "active" && payload.fieldArea === "field_value" && payload.fieldKey && P4_OWNED_FIELD_KEYS.has(payload.fieldKey)) {
      throw new Error("financial-active field edits must use P4 reviewer decision routes");
    }
    const sourceFileId = payload.fieldArea === "source_link"
      ? await validateSourceFileForOrg(supabaseAdmin, orgId, (payload.patch as Record<string, unknown>).source_file_id)
      : await resolveSourceFileId(supabaseAdmin, payload.leaseId);
    const logger = sourceFileId ? createLogger(supabaseAdmin, sourceFileId, orgId) : null;
    const uiContext = body?._uiContext ?? null;
    await logger?.event("field_evidence_edit", "started", {
      lease_id: payload.leaseId,
      field_area: payload.fieldArea,
      action: payload.action,
      field_key: payload.fieldKey,
      ui: uiContext,
    });

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
      await logger?.event("field_evidence_edit", "failed", {
        lease_id: payload.leaseId,
        field_area: payload.fieldArea,
        reason: error.message,
      });
      throw new Error(error.message || "update_lease_extraction_field failed");
    }

    await logger?.event("field_evidence_edit", "succeeded", {
      lease_id: payload.leaseId,
      field_area: payload.fieldArea,
      action: payload.action,
      ui: uiContext,
    });
    return jsonResponse({ error: false, ...data, source_file_id: sourceFileId ?? data?.source_file_id ?? null });
  } catch (err) {
    const message = err?.message || "Could not update lease extraction field";
    return jsonResponse({
      error: true,
      message,
      error_code: "UPDATE_LEASE_EXTRACTION_FIELD_FAILED",
    }, errorStatus(message));
  }
});
