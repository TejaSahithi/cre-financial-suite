// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required and must be a valid UUID");
  }
  return { leaseId };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|only organization admins/i.test(message)) return 403;
  if (/required|not found|does not belong/i.test(message)) return 400;
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
    // PRE-AZ-HOTFIX-1A: narrower than ENTITY_WRITE_PAGES.Lease
    // (['Leases', 'LeaseUpload', 'LeaseReview']) used by other lease-write
    // edge functions -- confirmed by direct inspection that lease deletion
    // is reachable only from Leases.jsx (single-delete and bulk-delete
    // mutations, both via leaseService.delete()). LeaseUpload.jsx only
    // deletes uploaded_files records (a different table/action); its own
    // UI copy explicitly says to delete the lease "separately from the
    // Leases list". LeaseReview.jsx has no lease-delete action at all.
    await assertPageAccess(req, orgId, ["Leases"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    // delete_lease_cascade itself takes no p_org_id and performs no
    // caller-authorization check (it only checks the lease exists) -- the
    // org boundary must be enforced here, before calling it.
    const { data: lease, error: fetchError } = await supabaseAdmin
      .from("leases")
      .select("id, org_id")
      .eq("id", payload.leaseId)
      .maybeSingle();

    if (fetchError) {
      throw new Error(fetchError.message || "Could not look up lease");
    }
    if (!lease) {
      throw new Error("Lease not found");
    }
    if (lease.org_id !== orgId) {
      throw new Error("Lease does not belong to your organization");
    }

    const { error } = await supabaseAdmin.rpc("delete_lease_cascade", {
      target_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
    });

    if (error) {
      throw new Error(error.message || "delete_lease_cascade failed");
    }

    return jsonResponse({ error: false, lease_id: payload.leaseId });
  } catch (err) {
    const message = err?.message || "Could not delete lease";
    return jsonResponse({
      error: true,
      message,
      error_code: "DELETE_LEASE_CASCADE_FAILED",
    }, errorStatus(message));
  }
});
