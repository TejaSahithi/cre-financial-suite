// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-B: thin
// HTTP wrapper around _shared/cam-engine-v2/snapshot/build-cam-run-input.ts
// for standalone preview/inspection use (run-cam-calculation-v2 calls the
// same shared function in-process, not over HTTP, as its own step 3-4).
// See that module's header comment for the full 10-requirement mapping.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { buildCamRunInputV2 } from "../_shared/cam-engine-v2/snapshot/build-cam-run-input.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["CAMSetup", "CAMDashboard"], "read");

    const body = await req.json().catch(() => ({}));
    const propertyId = String(body?.property_id || "").trim();
    const recoveryPeriodId = String(body?.recovery_period_id || "").trim();
    const scopeType = String(body?.scope_type || "property").trim();
    const scopeId = body?.scope_id ? String(body.scope_id).trim() : propertyId;
    const camRunId = String(body?.cam_run_id || "").trim();
    const runMode = body?.run_mode === "posting_eligible" ? "posting_eligible" : "preview";

    if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
    if (!UUID_RE.test(recoveryPeriodId)) throw new Error("recovery_period_id is required");
    if (!UUID_RE.test(camRunId)) throw new Error("cam_run_id is required — build-cam-run-input-v2 attaches its snapshot to an already-created draft run, it does not create one (see run-cam-calculation-v2)");

    await assertPropertyAccess(req, propertyId);

    const result = await buildCamRunInputV2(supabaseAdmin, {
      orgId, propertyId, recoveryPeriodId, scopeType, scopeId, camRunId, runMode,
    });

    return jsonResponse(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, errorStatus(message));
  }
});
