// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

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

    const { data, error } = await supabaseAdmin.rpc("delete_uploaded_file_workflow", {
      p_org_id: orgId,
      p_file_id: payload.fileId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
    });

    if (error) {
      throw new Error(error.message || "delete_uploaded_file_workflow failed");
    }

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
