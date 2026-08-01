// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { publishApprovedLeaseExpenseArtifacts } from "../_shared/approved-lease-expense-rules.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/must be approved/i.test(message)) return 409;
  if (/required|invalid|not found/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["LeaseExpenseRules", "LeaseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const leaseId = String(body?.lease_id || "").trim();
    if (!UUID_RE.test(leaseId)) {
      throw new Error("lease_id is required");
    }

    const { data: lease, error: leaseError } = await supabaseAdmin
      .from("leases")
      .select("*")
      .eq("org_id", orgId)
      .eq("id", leaseId)
      .maybeSingle();
    if (leaseError || !lease) {
      throw new Error(leaseError?.message || "Approved lease not found");
    }

    const result = await publishApprovedLeaseExpenseArtifacts({
      supabaseAdmin,
      orgId,
      lease,
      actorUserId: user.id,
      actorEmail: user.email || null,
      force: body?.force === true,
    });

    return jsonResponse({ error: false, ...result });
  } catch (error) {
    const message = error?.message || "Could not synchronize approved lease expense rules";
    console.error("[sync-approved-lease-expense-rules] failed", {
      message,
      stack: error?.stack || null,
    });
    return jsonResponse({
      error: true,
      message,
      details: error?.details || error?.hint || null,
      error_code: "SYNC_APPROVED_LEASE_EXPENSE_RULES_FAILED",
    }, errorStatus(message));
  }
});
