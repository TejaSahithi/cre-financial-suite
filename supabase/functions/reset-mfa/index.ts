import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authorization = req.headers.get("Authorization");

  try {
    console.log("[reset-mfa] Request received");
    if (!authorization) throw new Error("Missing Authorization header");

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Get the caller's ID from their token
    const token = authorization.replace("Bearer ", "");
    const { data: { user: caller }, error: callerErr } = await adminClient.auth.getUser(token);

    if (callerErr || !caller) {
      console.error("[reset-mfa] Auth error:", callerErr);
      throw new Error("Invalid or expired session. Please sign in again.");
    }

    console.log(`[reset-mfa] Resetting MFA for user: ${caller.id} (${caller.email})`);

    // Fetch all current factors for this user via Admin API
    const { data: mfaData, error: listErr } = await adminClient.auth.admin.mfa.listFactors({
      userId: caller.id
    });

    if (listErr) {
      console.error("[reset-mfa] listFactors error:", listErr);
      throw listErr;
    }

    console.log(`[reset-mfa] Found ${mfaData.factors.length} factors`);

    // Delete all existing TOTP factors
    let deletedCount = 0;
    for (const factor of mfaData.factors) {
      if (factor.factor_type === 'totp') {
        const { error: delErr } = await adminClient.auth.admin.mfa.deleteFactor({
          userId: caller.id,
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

    return new Response(JSON.stringify({ success: true, deletedCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[reset-mfa] Critical Error:", err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 200, // Return 200 so the client can read the JSON error body easily
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
