// @ts-nocheck
// Legacy save-cam-profile Edge Function — DEPRECATED / RETIRED.
// cam_profiles has no live caller and no canonical CAM V2 equivalent: the
// 12 flat fields this patched (tenant_rsf, cam_cap_percent, etc.) don't
// exist as columns on public.lease_recovery_policies — in V2 that data is
// expressed as public.lease_recovery_policy_steps rows edited through
// cam-setup-actions-v2's resolve_missing_policy_value /
// resolve_policy_conflict actions, a genuinely different shape.
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  console.warn(`[LEGACY_CAM_API_INVOKED] save-cam-profile called from ${req.headers.get("referer") || "unknown"}. Legacy cam_profiles workflow is retired.`);

  return new Response(
    JSON.stringify({
      error: "Legacy save-cam-profile Edge Function is retired. CAM V2 recovery terms live on lease_recovery_policy_steps; edit them via CAM Setup's resolve-missing-value / resolve-conflict actions.",
      code: "LEGACY_CAM_PROFILE_WORKFLOW_RETIRED",
      replacement: "cam-setup-actions-v2",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
