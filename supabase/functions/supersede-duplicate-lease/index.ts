// @ts-nocheck
// Controlled action for consolidating duplicate lease extractions into one
// canonical lease record (see supersede_duplicate_lease RPC,
// 20269900000035_supersede_duplicate_lease_rpc.sql). Never merges field
// values -- the caller has already decided which lease is canonical; this
// only marks the other as superseded so it stops appearing as an active,
// approved lease anywhere (Lease List, Rent Projection, Critical Dates,
// CAM Setup).
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUUID(value: unknown, fieldName: string): string {
  const s = String(value ?? "").trim();
  if (!UUID_RE.test(s)) throw new Error(`${fieldName} is required and must be a valid UUID`);
  return s;
}

function requireString(value: unknown, fieldName: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${fieldName} is required`);
  return s;
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/already superseded by a different|itself superseded/i.test(message)) return 409;
  if (/required|not found|must be different/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["Leases", "LeaseUpload", "LeaseReview", "CAMSetup"], "write");

    const body = await req.json().catch(() => ({}));
    const duplicateLeaseId = requireUUID(body?.duplicate_lease_id, "duplicate_lease_id");
    const canonicalLeaseId = requireUUID(body?.canonical_lease_id, "canonical_lease_id");
    const reason = requireString(body?.reason, "reason");

    const { data: duplicateRow, error: duplicateError } = await supabaseAdmin
      .from("leases").select("property_id").eq("id", duplicateLeaseId).eq("org_id", orgId).maybeSingle();
    if (duplicateError) throw new Error(duplicateError.message);
    if (!duplicateRow) throw new Error("Duplicate lease not found for this organization");
    await assertPropertyAccess(req, duplicateRow.property_id);

    const { data, error } = await supabaseAdmin.rpc("supersede_duplicate_lease", {
      p_org_id: orgId,
      p_duplicate_lease_id: duplicateLeaseId,
      p_canonical_lease_id: canonicalLeaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email ?? "unknown@example.com",
      p_reason: reason,
    });
    if (error) throw new Error(error.message);

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not supersede duplicate lease";
    return jsonResponse({ error: true, message, error_code: "SUPERSEDE_DUPLICATE_LEASE_FAILED" }, errorStatus(message));
  }
});
