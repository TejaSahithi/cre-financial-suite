// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";

/**
 * Deprecated public extraction endpoint.
 *
 * The canonical pipeline is:
 * upload-handler -> ingest-file -> parse-file / parse-pdf-docling
 * -> normalize-pdf-output -> validate-data -> store-data -> compute.
 *
 * Keeping this HTTP surface active caused scanned documents to bypass the
 * server-side OCR/review pipeline. It now returns 410 for one release cycle.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      error: true,
      error_code: "DEPRECATED_ENDPOINT",
      message:
        "extract-document-fields is deprecated. Upload documents through upload-handler and start processing with ingest-file.",
      canonical_flow: [
        "upload-handler",
        "ingest-file",
        "parse-file or parse-pdf-docling",
        "normalize-pdf-output",
        "validate-data",
        "store-data",
        "compute-orchestrator",
      ],
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
