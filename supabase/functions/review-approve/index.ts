// @ts-nocheck
/**
 * review-approve — Human review gate for lease-sensitive documents
 *
 * Three actions are supported:
 *   action = "approve" (default):
 *     Flip review_status → 'approved', status → 'approved',
 *     optionally persist reviewer's corrections, then invoke store-data.
 *
 *   action = "reject":
 *     Flip review_status → 'rejected', status → 'failed' with the
 *     provided reason. store-data is NOT called.
 *
 *   action = "save":
 *     Save edits WITHOUT approving. Lets the reviewer park progress and
 *     come back later. Status stays 'review_required'.
 *
 * Body:
 *   {
 *     file_id: string,
 *     action?: 'approve' | 'reject' | 'save',
 *     edited_rows?: Record<string, unknown>[],  // optional overrides
 *     reject_reason?: string,                   // required for reject
 *   }
 *
 * RLS guarantees org_id isolation; we double-check explicitly for
 * defense-in-depth.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { setStatus, setFailed } from "../_shared/pipeline-status.ts";

type Action = "approve" | "reject" | "save";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const body = await req.json().catch(() => ({}));
    const {
      file_id,
      action = "approve" as Action,
      edited_rows,
      reject_reason,
    } = body;

    if (!file_id) {
      return jsonResponse(
        { error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" },
        400,
      );
    }

    if (!["approve", "reject", "save"].includes(action)) {
      return jsonResponse(
        { error: true, message: `Invalid action: ${action}`, error_code: "INVALID_ACTION" },
        400,
      );
    }

    if (action === "reject" && !reject_reason) {
      return jsonResponse(
        {
          error: true,
          message: "reject_reason is required when action='reject'",
          error_code: "MISSING_REJECT_REASON",
        },
        400,
      );
    }

    // Fetch file record (org isolation)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select(
        "id, org_id, module_type, status, review_required, review_status, " +
        "ui_review_payload, valid_data, parsed_data",
      )
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      return jsonResponse(
        {
          error: true,
          message: `File not found: ${fetchError?.message ?? "Invalid file_id or org mismatch"}`,
          error_code: "FILE_NOT_FOUND",
        },
        404,
      );
    }

    if (!fileRecord.review_required) {
      return jsonResponse(
        {
          error: true,
          message: `File ${file_id} does not require review (review_required=false).`,
          error_code: "NOT_REVIEWABLE",
        },
        422,
      );
    }

    if (fileRecord.review_status === "approved" && action !== "save") {
      return jsonResponse(
        {
          error: true,
          message: `File ${file_id} has already been approved.`,
          error_code: "ALREADY_APPROVED",
        },
        409,
      );
    }

    if (fileRecord.review_status === "rejected" && action !== "save") {
      return jsonResponse(
        {
          error: true,
          message: `File ${file_id} has already been rejected.`,
          error_code: "ALREADY_REJECTED",
        },
        409,
      );
    }

    // Normalize edited_rows — reviewer may send a list of row objects that
    // replace the values in valid_data. If not provided, carry over what's
    // already stored.
    const finalRows: Record<string, unknown>[] = Array.isArray(edited_rows)
      ? edited_rows
      : (fileRecord.valid_data ?? fileRecord.parsed_data ?? []);

    const now = new Date().toISOString();

    // ── Action: save ────────────────────────────────────────────────────
    if (action === "save") {
      const { error: saveErr } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          valid_data: finalRows,
          row_count: finalRows.length,
          valid_count: finalRows.length,
          updated_at: now,
        })
        .eq("id", file_id);

      if (saveErr) throw new Error(`Save failed: ${saveErr.message}`);

      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "pending",
        row_count: finalRows.length,
      });
    }

    // ── Action: reject ──────────────────────────────────────────────────
    if (action === "reject") {
      const { error: rejectErr } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          review_status: "rejected",
          rejected_by: user.id,
          rejected_at: now,
          reject_reason,
          updated_at: now,
        })
        .eq("id", file_id);

      if (rejectErr) throw new Error(`Reject update failed: ${rejectErr.message}`);

      // Transition to 'failed' so the file drops out of the active queue.
      // Legal review policy: rejected files remain visible but non-actionable.
      await setFailed(
        supabaseAdmin,
        file_id,
        `Rejected by reviewer: ${reject_reason}`,
        "review",
        60,
      );

      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "rejected",
        reject_reason,
      });
    }

    // ── Action: approve ─────────────────────────────────────────────────
    if (!finalRows || finalRows.length === 0) {
      return jsonResponse(
        {
          error: true,
          message: "Cannot approve a file with 0 rows.",
          error_code: "EMPTY_APPROVAL",
        },
        422,
      );
    }

    // Persist reviewer edits onto both parsed_data and valid_data.
    // validate-data reads parsed_data; store-data reads valid_data.
    const { error: persistErr } = await supabaseAdmin
      .from("uploaded_files")
      .update({
        parsed_data: finalRows,
        valid_data: finalRows,
        row_count: finalRows.length,
        valid_count: finalRows.length,
        updated_at: now,
      })
      .eq("id", file_id);
    if (persistErr) throw new Error(`Failed to persist edits: ${persistErr.message}`);

    // Flip status → 'approved'. setStatus() also stamps approved_by/at.
    const { error: approveErr } = await setStatus(
      supabaseAdmin,
      file_id,
      "approved",
      { approved_by: user.id },
    );
    if (approveErr) {
      throw new Error(`Approve status transition failed: ${approveErr.message}`);
    }

    // Chain: validate-data then store-data with the caller's JWT so RLS
    // works end-to-end and reviewer edits still pass schema validation.
    const authHeader =
      req.headers.get("Authorization") ??
      req.headers.get("x-supabase-auth") ??
      req.headers.get("x-user-jwt") ??
      "";

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    let validateResult: unknown = null;
    let validateOk = false;
    let storeResult: unknown = null;
    let storeOk = false;
    try {
      const validateRes = await fetch(`${supabaseUrl}/functions/v1/validate-data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        },
        body: JSON.stringify({ file_id }),
      });
      validateResult = await validateRes.json().catch(() => ({}));
      validateOk = validateRes.ok;
      if (!validateOk) {
        console.error(`[review-approve] validate-data failed (${validateRes.status}):`, validateResult);
      } else {
        const storeRes = await fetch(`${supabaseUrl}/functions/v1/store-data`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": authHeader,
            "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          },
          body: JSON.stringify({ file_id }),
        });
        storeResult = await storeRes.json().catch(() => ({}));
        storeOk = storeRes.ok;
        if (!storeOk) {
          console.error(`[review-approve] store-data failed (${storeRes.status}):`, storeResult);
        }
      }
    } catch (chainErr) {
      console.error("[review-approve] validate/store fetch error:", chainErr.message);
      storeResult = { error: true, message: chainErr.message };
    }

    return jsonResponse({
      error: !storeOk,
      file_id,
      action,
      review_status: "approved",
      validate_result: validateResult,
      store_result: storeResult,
      store_triggered: storeOk,
    });
  } catch (err) {
    console.error("[review-approve] Error:", err.message, err.stack);
    return jsonResponse(
      {
        error: true,
        message: err.message,
        error_code: "REVIEW_APPROVE_FAILED",
      },
      500,
    );
  }
});
