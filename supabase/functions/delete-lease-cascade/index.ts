// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  const rawIds = Array.isArray(body.lease_ids)
    ? body.lease_ids.map((id) => String(id).trim())
    : [];

  const validIds = [
    ...(UUID_RE.test(leaseId) ? [leaseId] : []),
    ...rawIds.filter((id) => UUID_RE.test(id)),
  ];
  const uniqueIds = [...new Set(validIds)];

  if (uniqueIds.length === 0) {
    throw new Error("lease_id or lease_ids is required and must be valid UUID(s)");
  }
  return { leaseIds: uniqueIds, singleMode: uniqueIds.length === 1 && Boolean(leaseId) };
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
    await assertPageAccess(req, orgId, ["Leases"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const deletedIds: string[] = [];
    const errors: string[] = [];

    for (const targetId of payload.leaseIds) {
      const { data: lease, error: fetchError } = await supabaseAdmin
        .from("leases")
        .select("id, org_id")
        .eq("id", targetId)
        .maybeSingle();

      if (fetchError) {
        errors.push(`Could not look up lease ${targetId}: ${fetchError.message}`);
        continue;
      }
      if (!lease) {
        errors.push("Lease not found");
        continue;
      }
      if (lease.org_id && orgId && lease.org_id !== orgId) {
        errors.push("Lease does not belong to your organization");
        continue;
      }

      const { error } = await supabaseAdmin.rpc("delete_lease_cascade", {
        target_lease_id: targetId,
        p_actor_user_id: user.id,
        p_actor_email: user.email || null,
      });

      if (error) {
        errors.push(error.message || "delete_lease_cascade failed");
        continue;
      }

      deletedIds.push(targetId);
    }

    if (deletedIds.length === 0 && errors.length > 0) {
      throw new Error(errors[0]);
    }

    return jsonResponse({
      error: false,
      lease_id: payload.singleMode ? deletedIds[0] || payload.leaseIds[0] : undefined,
      lease_ids: deletedIds,
      failed_count: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const message = err?.message || "Could not delete lease";
    return jsonResponse(
      {
        error: true,
        message,
        error_code: "DELETE_LEASE_CASCADE_FAILED",
      },
      errorStatus(message)
    );
  }
});
