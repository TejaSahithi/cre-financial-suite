// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";

/**
 * confirm-upload — the "Proceed" action of the upload confirmation
 * lifecycle.
 *
 * upload-handler stores the file and inserts a durable uploaded_files row
 * with confirmed_at left NULL ("awaiting confirmation"). Nothing downstream
 * of upload-handler runs until this function is called — no parse-document-azure,
 * no Azure Document Intelligence, no normalize-pdf-output, no OpenAI, no
 * lease-extraction-worker.
 *
 * Idempotent: a second call (double-click, retry) for an already-confirmed
 * file_id is a no-op that returns the existing pipeline_jobs row instead of
 * re-triggering ingest-file.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json().catch(() => ({}));
    const fileId = body.file_id;
    if (!fileId) {
      return jsonResponse({ error: true, error_code: "MISSING_FILE_ID", message: "file_id is required" }, 400);
    }

    const logger = createLogger(supabaseAdmin, fileId, orgId);

    // Atomic idempotent confirm: only the FIRST call for a given file_id
    // finds a matching row (confirmed_at IS NULL) and flips it. A concurrent
    // or repeated call finds zero rows and falls through to the
    // already-confirmed lookup below instead of re-triggering extraction.
    const { data: confirmedRow, error: confirmError } = await supabaseAdmin
      .from("uploaded_files")
      .update({ confirmed_at: new Date().toISOString() })
      .eq("id", fileId)
      .eq("org_id", orgId)
      .is("confirmed_at", null)
      .select("id, module_type, file_name")
      .maybeSingle();

    if (confirmError) {
      console.error("[confirm-upload] confirm update failed:", confirmError.message);
      return jsonResponse({ error: true, error_code: "CONFIRM_FAILED", message: confirmError.message }, 500);
    }

    if (!confirmedRow) {
      // Either already confirmed by a prior click/race, or the file_id
      // doesn't belong to this org, or it never existed. Distinguish those
      // so a genuine not-found still surfaces clearly.
      const { data: existing } = await supabaseAdmin
        .from("uploaded_files")
        .select("id, confirmed_at, module_type")
        .eq("id", fileId)
        .eq("org_id", orgId)
        .maybeSingle();

      if (!existing) {
        return jsonResponse({ error: true, error_code: "FILE_NOT_FOUND", message: "Uploaded file not found" }, 404);
      }

      const { data: existingJob } = await supabaseAdmin
        .from("pipeline_jobs")
        .select("id, stage, status")
        .eq("uploaded_file_id", fileId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return jsonResponse({
        error: false,
        already_confirmed: true,
        file_id: fileId,
        pipeline_job: existingJob ?? null,
      });
    }

    await logger.info("upload", "upload_confirmed", {
      file_id: fileId,
      file_name: confirmedRow.file_name,
      confirmed_by: user.email ?? user.id,
    });

    // Forward the caller's own auth to ingest-file — no internal-auth changes
    // needed there, it already only requires a valid user JWT via verifyUser.
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const forwardHeaders: Record<string, string> = { "Content-Type": "application/json" };
    const authHeader = req.headers.get("Authorization");
    if (authHeader) forwardHeaders["Authorization"] = authHeader;
    const actingOrgHeader = req.headers.get("x-acting-org-id");
    if (actingOrgHeader) forwardHeaders["x-acting-org-id"] = actingOrgHeader;

    let ingestResponse: Response;
    try {
      ingestResponse = await fetch(`${supabaseUrl}/functions/v1/ingest-file`, {
        method: "POST",
        headers: forwardHeaders,
        body: JSON.stringify({ file_id: fileId, module_type: confirmedRow.module_type }),
      });
    } catch (fetchErr: any) {
      console.error("[confirm-upload] ingest-file call failed:", fetchErr?.message);
      return jsonResponse({
        error: true,
        error_code: "INGEST_DISPATCH_FAILED",
        message: `Confirmed, but failed to start extraction: ${fetchErr?.message ?? fetchErr}`,
        file_id: fileId,
      }, 502);
    }

    const ingestText = await ingestResponse.text().catch(() => "");
    let ingestData: any = {};
    try {
      ingestData = ingestText ? JSON.parse(ingestText) : {};
    } catch {
      ingestData = { raw_response: ingestText.slice(0, 500) };
    }

    if (!ingestResponse.ok) {
      console.error(`[confirm-upload] ingest-file returned ${ingestResponse.status}:`, ingestText.slice(0, 500));
      return jsonResponse({
        error: true,
        error_code: "INGEST_FAILED",
        message: ingestData?.message || `ingest-file returned HTTP ${ingestResponse.status}`,
        file_id: fileId,
      }, ingestResponse.status);
    }

    await logger.info("upload", "pipeline_enqueued_after_confirmation", {
      file_id: fileId,
      job_id: ingestData?.job_id ?? null,
    });

    return jsonResponse({
      error: false,
      already_confirmed: false,
      file_id: fileId,
      ...ingestData,
    });
  } catch (err) {
    console.error("[confirm-upload] Error:", err.message);
    const isAuthError = /unauthorized|missing authorization|invalid token/i.test(String(err.message ?? ""));
    return jsonResponse(
      { error: true, error_code: isAuthError ? "UNAUTHORIZED" : "CONFIRM_UPLOAD_FAILED", message: err.message },
      isAuthError ? 401 : 400,
    );
  }
});
