// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const fileId = String(body.file_id || "").trim();
  if (!UUID_RE.test(fileId)) {
    throw new Error("file_id is required and must be a valid UUID");
  }
  return { fileId };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|only organization admins/i.test(message)) return 403;
  if (/required|not found/i.test(message)) return 400;
  // HARD-2C: file already linked to downstream lease evidence.
  if (/already linked to lease evidence/i.test(message)) return 409;
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
    // Reachable from two pages: LeaseUpload.jsx's "Delete Upload" button and
    // Documents.jsx's row-level delete action (both confirmed via direct
    // code inspection during Phase HARD-2/HARD-2B investigation) -- either
    // page's write access is sufficient, matching the OR semantics
    // ENTITY_WRITE_PAGES already uses for multi-page entities (e.g. Lease:
    // ['Leases', 'LeaseUpload', 'LeaseReview']).
    await assertPageAccess(req, orgId, ["LeaseUpload", "Documents"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);
    // pipeline_logs.file_id CASCADEs when the file row is deleted, so a
    // "succeeded" event here would vanish along with the file it describes.
    // Log the attempt (survives on failure) via pipeline_logs, and log the
    // durable "this file was deleted" fact via audit_logs (org-scoped, not
    // file-FK'd) instead — the same table Lease/Expense/Budget lifecycle
    // events already use for exactly this reason.
    const logger = createLogger(supabaseAdmin, payload.fileId, orgId);
    const uiContext = body?._uiContext ?? null;
    await logger.event("file_delete", "started", { ui: uiContext });

    const { data, error } = await supabaseAdmin.rpc("delete_uploaded_file_workflow", {
      p_org_id: orgId,
      p_file_id: payload.fileId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
    });

    if (error) {
      await logger.event("file_delete", "failed", { reason: error.message });
      throw new Error(error.message || "delete_uploaded_file_workflow failed");
    }

    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      entity_type: "UploadedFile",
      entity_id: payload.fileId,
      action: "delete",
      user_email: user.email ?? null,
    }).then(({ error: auditErr }: any) => {
      if (auditErr) console.warn(`[delete-uploaded-file] audit_logs write skipped: ${auditErr.message}`);
    });

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not delete uploaded file";
    return jsonResponse({
      error: true,
      message,
      error_code: "DELETE_UPLOADED_FILE_FAILED",
    }, errorStatus(message));
  }
});
