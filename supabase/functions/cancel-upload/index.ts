// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";

/**
 * cancel-upload — the "Cancel" action of the upload confirmation lifecycle.
 *
 * Branches on whether the file has been confirmed yet:
 *   - Not confirmed (still awaiting the Proceed/Cancel gate): hard-deletes
 *     the uploaded_files row (via the delete_unconfirmed_upload RPC — RLS
 *     blocks all client-side deletes of this table) and the storage object.
 *     No pipeline_jobs row can exist yet at this point (ingest-file never
 *     ran), so there's nothing else to clean up.
 *   - Already confirmed (extraction in flight or done): soft-cancel —
 *     flags the active pipeline_jobs row with cancel_requested_at. The
 *     worker observes this at its next stage checkpoint and stops before
 *     dispatching the next stage. uploaded_files/docling_raw/ui_review_payload
 *     are never touched — the audit trail is preserved.
 *
 * Idempotent both ways: a second call after the row is already gone (or the
 * flag is already set) is a no-op success, not an error.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function storagePathFromFileUrl(fileUrl: string): string {
  return String(fileUrl || "").replace(
    /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
    "",
  );
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

    const { data: fileRecord, error: fileError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, confirmed_at, file_url, file_name, status")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (fileError) {
      console.error("[cancel-upload] file lookup failed:", fileError.message);
      return jsonResponse({ error: true, error_code: "LOOKUP_FAILED", message: fileError.message }, 500);
    }

    if (!fileRecord) {
      // Already deleted by a prior cancel (or never existed for this org).
      // The desired end state — no unconfirmed row — is already true.
      return jsonResponse({ error: false, cancelled: true, already_gone: true, file_id: fileId });
    }

    if (!fileRecord.confirmed_at) {
      // Pre-extraction cancel: hard-delete. RLS blocks client-side deletes of
      // uploaded_files entirely, so this goes through the service-role RPC.
      const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc("delete_unconfirmed_upload", {
        p_org_id: orgId,
        p_file_id: fileId,
        p_actor_user_id: user.id,
        p_actor_email: user.email ?? null,
      });

      if (rpcError) {
        console.error("[cancel-upload] delete_unconfirmed_upload RPC failed:", rpcError.message);
        return jsonResponse({ error: true, error_code: "CANCEL_DELETE_FAILED", message: rpcError.message }, 500);
      }

      const deletedCount = Number(rpcResult?.deleted_count ?? 0);
      if (deletedCount > 0) {
        const storagePath = storagePathFromFileUrl(rpcResult?.file_url ?? fileRecord.file_url);
        const { error: storageError } = await supabaseAdmin.storage
          .from("financial-uploads")
          .remove([storagePath]);
        if (storageError) {
          // Non-fatal — the DB row (the authoritative resource) is already
          // gone; a leftover storage object is a low-severity cleanup gap,
          // not a correctness issue for the user-facing cancel.
          console.warn(`[cancel-upload] storage cleanup failed for ${storagePath}:`, storageError.message);
        } else {
          await logger.info("upload", "temp_file_deleted", { file_id: fileId, storage_path: storagePath });
        }
      }

      await logger.info("upload", "upload_cancelled", {
        file_id: fileId,
        file_name: fileRecord.file_name,
        soft_cancel: false,
        deleted_count: deletedCount,
      });

      return jsonResponse({ error: false, cancelled: true, hard_deleted: deletedCount > 0, file_id: fileId });
    }

    // Post-confirmation: soft-cancel. Never touches uploaded_files/docling_raw/
    // ui_review_payload — only flags the active job for the worker to observe.
    const { data: updatedJobs, error: softCancelError } = await supabaseAdmin
      .from("pipeline_jobs")
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq("uploaded_file_id", fileId)
      .in("status", ["queued", "running"])
      .is("cancel_requested_at", null)
      .select("id");

    if (softCancelError) {
      console.error("[cancel-upload] soft-cancel update failed:", softCancelError.message);
      return jsonResponse({ error: true, error_code: "SOFT_CANCEL_FAILED", message: softCancelError.message }, 500);
    }

    await logger.info("upload", "upload_cancelled", {
      file_id: fileId,
      file_name: fileRecord.file_name,
      soft_cancel: true,
      jobs_flagged: Array.isArray(updatedJobs) ? updatedJobs.length : 0,
    });

    return jsonResponse({
      error: false,
      cancelled: true,
      soft_cancel: true,
      jobs_flagged: Array.isArray(updatedJobs) ? updatedJobs.length : 0,
      file_id: fileId,
    });
  } catch (err) {
    console.error("[cancel-upload] Error:", err.message);
    const isAuthError = /unauthorized|missing authorization|invalid token/i.test(String(err.message ?? ""));
    return jsonResponse(
      { error: true, error_code: isAuthError ? "UNAUTHORIZED" : "CANCEL_UPLOAD_FAILED", message: err.message },
      isAuthError ? 401 : 400,
    );
  }
});
