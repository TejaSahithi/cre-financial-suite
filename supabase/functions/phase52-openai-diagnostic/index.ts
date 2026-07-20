// @ts-nocheck
/**
 * @deprecated — RETIRED
 *
 * phase52-openai-diagnostic diagnostic function is retired as OpenAI is no longer used.
 * OpenAI is used instead.
 *
 * Returns HTTP 410 Gone.
 */

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      error: "DEPRECATED",
      error_code: "ENDPOINT_RETIRED",
      message:
        "phase52-openai-diagnostic is retired. Diagnostic test endpoints have been unified.",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
