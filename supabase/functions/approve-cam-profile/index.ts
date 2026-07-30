// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const profileId = String(body.profile_id || "").trim();
  if (!UUID_RE.test(profileId)) {
    throw new Error("profile_id is required");
  }
  return { profileId };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/lease abstract must be approved/i.test(message)) return 409;
  if (/required|not found|cannot approve/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["CAMSetup"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("cam_profiles")
      .select("lease_id")
      .eq("id", payload.profileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (profileError || !profile?.lease_id) {
      throw new Error(profileError?.message || "CAM profile not found");
    }
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from("leases")
      .select("abstract_status, status, abstract_approved_at")
      .eq("id", profile.lease_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (leaseError || !lease) {
      throw new Error(leaseError?.message || "Lease not found");
    }
    if (
      String(lease.abstract_status || "").toLowerCase() !== "approved" &&
      String(lease.status || "").toLowerCase() !== "approved" &&
      !lease.abstract_approved_at
    ) {
      throw new Error("Lease abstract must be approved before a CAM profile can be approved");
    }

    const { data, error } = await supabaseAdmin.rpc("approve_cam_profile", {
      p_org_id: orgId,
      p_profile_id: payload.profileId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
    });

    if (error) {
      throw new Error(error.message || "approve_cam_profile failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not approve CAM profile";
    return jsonResponse({
      error: true,
      message,
      error_code: "APPROVE_CAM_PROFILE_FAILED",
    }, errorStatus(message));
  }
});
