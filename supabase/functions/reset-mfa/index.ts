import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authorization = req.headers.get("Authorization");

  try {
    if (!authorization) throw new Error("Unauthorized");

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Get the caller's ID from their token (AAL1 is fine since we are explicitly bypassing it here)
    const token = authorization.replace("Bearer ", "");
    const { data: { user: caller }, error: callerErr } = await adminClient.auth.getUser(token);
    if (callerErr || !caller) throw new Error("Invalid token");

    // Fetch all current factors for this user via Admin API
    const { data: mfaData, error: listErr } = await adminClient.auth.admin.mfa.listFactors({
      userId: caller.id
    });
    
    if (listErr) throw listErr;

    // Delete all existing TOTP factors so they can enroll fresh
    for (const factor of mfaData.factors) {
      if (factor.factor_type === 'totp') {
        await adminClient.auth.admin.mfa.deleteFactor({
          userId: caller.id,
          id: factor.id
        });
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[reset-mfa] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
