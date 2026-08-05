// @ts-nocheck
// Legacy approve-cam-profile Edge Function — DEPRECATED / RETIRED.
// cam_profiles has no live caller and no canonical CAM V2 equivalent: V2
// policies (public.lease_recovery_policies) are materialized directly to
// status='approved' by public.materialize_lease_recovery_policy, there is
// no manual per-record "approve" step to delegate to.
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  console.warn(`[LEGACY_CAM_API_INVOKED] approve-cam-profile called from ${req.headers.get("referer") || "unknown"}. Legacy cam_profiles workflow is retired.`);

  return new Response(
    JSON.stringify({
      error: "Legacy approve-cam-profile Edge Function is retired. CAM V2 recovery policies are materialized as approved directly from approved lease expense rules; there is no manual profile-approval step.",
      code: "LEGACY_CAM_PROFILE_WORKFLOW_RETIRED",
      replacement: "materialize_lease_recovery_policy",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
