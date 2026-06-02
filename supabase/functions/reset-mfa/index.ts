import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": '*',
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function getAalFromToken(token: string): string | null {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    const payload = JSON.parse(jsonPayload);
    return payload?.aal || null;
  } catch (e) {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authorization = req.headers.get("Authorization");

  try {
    console.log("[reset-mfa] Request received");
    if (!authorization) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const token = authorization.replace("Bearer ", "");
    const { data: { user: caller }, error: callerErr } = await adminClient.auth.getUser(token);

    if (callerErr || !caller) {
      console.error("[reset-mfa] Auth error:", callerErr);
      return new Response(JSON.stringify({ error: "Invalid or expired session. Please sign in again." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let targetUserId = caller.id;
    let isAdminRecovery = false;

    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (body && body.target_user_id) {
          targetUserId = body.target_user_id;
        }
      } catch (e) {
        // Ignore JSON parse errors for empty bodies
      }
    }

    const { data: adminMembership } = await adminClient
      .from("memberships")
      .select("role")
      .eq("user_id", caller.id)
      .eq("role", "super_admin")
      .maybeSingle();
    const isSuperAdmin = !!adminMembership;
    const aal = getAalFromToken(token);

    // Authorization checks
    if (targetUserId === caller.id) {
      // Self-service reset requires aal2
      if (aal !== "aal2") {
        const { error: auditErr } = await adminClient.from("audit_logs").insert({
          actor_user_id: caller.id,
          action: "mfa_reset_blocked",
          severity: "error",
          source: "edge_function",
          error_message: "AAL1 self-service reset attempt blocked"
        });
        if (auditErr) throw new Error(`Audit log failed: ${auditErr.message}`);
        return new Response(JSON.stringify({ error: "Forbidden: aal2 required for self-service MFA reset" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      // Admin recovery requires super_admin
      if (!isSuperAdmin) {
        const { error: auditErr } = await adminClient.from("audit_logs").insert({
          actor_user_id: caller.id,
          target_user_id: targetUserId,
          action: "mfa_reset_blocked",
          severity: "error",
          source: "edge_function",
          error_message: "Unauthorized admin recovery attempt"
        });
        if (auditErr) throw new Error(`Audit log failed: ${auditErr.message}`);
        return new Response(JSON.stringify({ error: "Forbidden: super_admin required for admin recovery" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      isAdminRecovery = true;
    }

    console.log(`[reset-mfa] Resetting MFA for user: ${targetUserId} (Requested by: ${caller.id})`);

    const { data: mfaData, error: listErr } = await adminClient.auth.admin.mfa.listFactors({
      userId: targetUserId
    });

    if (listErr) {
      console.error("[reset-mfa] listFactors error:", listErr);
      throw listErr;
    }

    let deletedCount = 0;
    for (const factor of mfaData.factors) {
      if (factor.factor_type === 'totp') {
        const { error: delErr } = await adminClient.auth.admin.mfa.deleteFactor({
          userId: targetUserId,
          id: factor.id
        });
        if (delErr) {
          console.error(`[reset-mfa] Failed to delete factor ${factor.id}:`, delErr);
        } else {
          deletedCount++;
        }
      }
    }

    console.log(`[reset-mfa] Successfully deleted ${deletedCount} factors`);

    const { error: auditErr } = await adminClient.from("audit_logs").insert({
      actor_user_id: caller.id,
      target_user_id: targetUserId,
      action: "mfa_reset_success",
      severity: "info",
      source: "edge_function",
      metadata: { deletedCount, isAdminRecovery }
    });
    if (auditErr) throw new Error(`Audit log failed: ${auditErr.message}`);

    return new Response(JSON.stringify({ success: true, deletedCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[reset-mfa] Critical Error:", err.message);
    
    // Attempt to log error (may fail if caller isn't defined, so wrap in try)
    try {
      const adminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      // Only log if it's not a generic unhandled exception and we have a token
      const authorization = req.headers.get("Authorization");
      if (authorization) {
        const token = authorization.replace("Bearer ", "");
        const { data: { user: caller } } = await adminClient.auth.getUser(token);
        if (caller) {
          const { error: auditErr } = await adminClient.from("audit_logs").insert({
            actor_user_id: caller.id,
            action: "mfa_reset_error",
            severity: "error",
            source: "edge_function",
            error_message: err.message
          });
          if (auditErr) throw new Error(`Audit log failed: ${auditErr.message}`);
        }
      }
    } catch(e) {}

    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
