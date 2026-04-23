// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authorization = req.headers.get("Authorization");

  try {
    if (!authorization) {
      return new Response(JSON.stringify({ error: "Unauthorized: missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: "Server misconfigured: missing service credentials" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const token = authorization.replace("Bearer ", "");
    const { data: { user }, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: `Invalid token: ${userError?.message || "no user"}` }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const fullName = typeof body?.full_name === "string" ? body.full_name.trim() : "";
    const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
    const requestedOrgId = typeof body?.org_id === "string" ? body.org_id : "";
    const now = new Date().toISOString();

    const { data: memberships, error: membershipsError } = await adminClient
      .from("memberships")
      .select("id, org_id, status")
      .eq("user_id", user.id);

    if (membershipsError) {
      throw membershipsError;
    }

    const invitedMemberships = (memberships || []).filter((membership: any) => membership?.status === "invited");
    const invitedOrgIds = [...new Set(invitedMemberships.map((membership: any) => membership?.org_id).filter(Boolean))];
    if (invitedOrgIds.length === 0) {
      return new Response(JSON.stringify({ error: "No pending invitation found for this account" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (requestedOrgId && !invitedOrgIds.includes(requestedOrgId)) {
      return new Response(JSON.stringify({ error: "The requested organization does not have a pending invite for this account" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const targetOrgIds = requestedOrgId ? [requestedOrgId] : invitedOrgIds;

    const membershipPayload: Record<string, unknown> = {
      status: "active",
      updated_at: now,
    };
    if (phone) membershipPayload.phone = phone;

    const { data: activatedMemberships, error: membershipError } = await adminClient
      .from("memberships")
      .update(membershipPayload)
      .eq("user_id", user.id)
      .in("org_id", targetOrgIds)
      .eq("status", "invited")
      .select("org_id");

    if (membershipError) {
      throw membershipError;
    }

    const activatedOrgIds = [...new Set((activatedMemberships || []).map((membership: any) => membership?.org_id).filter(Boolean))];
    if (activatedOrgIds.length === 0) {
      return new Response(JSON.stringify({ error: "No invited memberships were activated" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const profilePayload: Record<string, unknown> = {
      id: user.id,
      email: user.email || null,
      status: "active",
      onboarding_type: "invited",
      first_login: false,
      onboarding_complete: true,
      last_sign_in_at: user.last_sign_in_at || now,
      updated_at: now,
    };
    if (fullName) profilePayload.full_name = fullName;
    if (phone) profilePayload.phone = phone;

    const { error: profileError } = await adminClient
      .from("profiles")
      .upsert(profilePayload, { onConflict: "id" });

    if (profileError) {
      throw profileError;
    }

    if (user.email) {
      const { error: invitationError } = await adminClient
        .from("invitations")
        .update({ status: "accepted", updated_at: now })
        .eq("email", user.email)
        .in("org_id", activatedOrgIds)
        .in("status", ["pending", "pending_approval"]);

      if (invitationError) {
        console.warn("[accept-invite] invitation update warning:", invitationError.message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      org_ids: activatedOrgIds,
      primary_org_id: activatedOrgIds[0] || null,
      activated_memberships: activatedOrgIds.length,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[accept-invite] Error:", error?.message || error);
    return new Response(JSON.stringify({ error: error?.message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
