// @ts-nocheck
// Legacy compute-cam Edge Function — DEPRECATED / RETIRED.
// All CAM calculations use the canonical run-cam-calculation-v2 engine.
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  console.warn(`[LEGACY_CAM_API_INVOKED] compute-cam called from ${req.headers.get("referer") || "unknown"}. Legacy compute-cam is retired. Use run-cam-calculation-v2.`);

  return new Response(
    JSON.stringify({
      error: "Legacy compute-cam Edge Function is retired. Use run-cam-calculation-v2 for authoritative CAM calculations.",
      code: "LEGACY_CAM_ENGINE_RETIRED",
      replacement: "run-cam-calculation-v2",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
