// @ts-nocheck
// v4 - lease_date in dates group; monthly_rent min=1; lease_type enum description
/**
 * review-approve
 *
 * Human review gate for the canonical document pipeline.
 *
 * Actions:
 * - save: persist the editable review payload without approving.
 * - approve: persist reviewer decisions, flatten accepted fields into rows,
 *   transition to approved, then run validate-data and store-data.
 * - reject: keep the file/audit trail, mark review rejected, and fail the file.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { setStatus, setFailed } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";

type Action = "approve" | "reject" | "save" | "prepare";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  // Hoisted so the outer catch block can still log a failure even though
  // it's constructed inside the try block below (needs file_id/orgId, which
  // require a successful body parse + auth first).
  let reviewGateLogger: ReturnType<typeof createLogger> | null = null;

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const body = await req.json().catch(() => ({}));
    const {
      file_id,
      action = "approve" as Action,
      edited_rows,
      review_payload,
      reject_reason,
    } = body;

    if (!file_id) {
      return jsonResponse(
        { error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" },
        400,
      );
    }

    const logger = createLogger(supabaseAdmin, file_id, orgId);
    reviewGateLogger = logger;
    await logger.event("review_gate", "started", { action, ui: body?._uiContext ?? null });

    if (!["approve", "reject", "save", "prepare"].includes(action)) {
      await logger.event("review_gate", "failed", { action, reason: "invalid_action" });
      return jsonResponse(
        { error: true, message: `Invalid action: ${action}`, error_code: "INVALID_ACTION" },
        400,
      );
    }

    if (action === "reject" && !reject_reason) {
      await logger.event("review_gate", "failed", { action, reason: "missing_reject_reason" });
      return jsonResponse(
        {
          error: true,
          message: "reject_reason is required when action='reject'",
          error_code: "MISSING_REJECT_REASON",
        },
        400,
      );
    }

    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("*")
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
          message: `File ${file_id} does not require review.`,
          error_code: "NOT_REVIEWABLE",
        },
        422,
      );
    }

    if (fileRecord.review_status === "approved" && action !== "save") {
      const existingRows = getExistingReviewedRows(fileRecord);
      let storeResult: unknown = null;
      if (isLeaseModule(fileRecord.module_type)) {
        storeResult = await ensureLeaseReviewDrafts(
          supabaseAdmin,
          fileRecord,
          existingRows,
          fileRecord.reviewed_output ?? null,
          user,
        );
      }
      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "approved",
        already_approved: true,
        message: `File ${file_id} has already been approved.`,
        store_result: storeResult,
        store_triggered: !!storeResult,
        reviewed_output: {
          accepted_count: 0,
          rejected_count: 0,
          custom_count: 0,
          row_count: existingRows.length,
        },
      });
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

    const now = new Date().toISOString();
    const payload = normalizeSubmittedPayload(
      review_payload ?? fileRecord.ui_review_payload,
      edited_rows,
      fileRecord,
      user.id,
      now,
    );
    const reviewedOutput = buildReviewedOutput(payload, user.id, now);
    const finalRows = reviewedOutput.final_records;
    const audit = appendAudit(fileRecord.review_audit, {
      action,
      user_id: user.id,
      at: now,
      accepted_count: reviewedOutput.accepted_fields.length,
      rejected_count: reviewedOutput.rejected_fields.length,
      custom_count: reviewedOutput.custom_fields.length,
      row_count: finalRows.length,
      reason: reject_reason ?? null,
    });

    if (action === "prepare") {
      if (!isLeaseModule(fileRecord.module_type)) {
        return jsonResponse(
          {
            error: true,
            message: "prepare is only supported for lease review files.",
            error_code: "INVALID_PREPARE_ACTION",
          },
          422,
        );
      }

      const leaseStoreResult = await ensureLeaseReviewDrafts(
        supabaseAdmin,
        fileRecord,
        finalRows,
        reviewedOutput,
        user,
        true,
      );

      const { error: prepareErr } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          ui_review_payload: {
            ...payload,
            review_status: "pending",
            prepared_by: user.id,
            prepared_at: now,
          },
          reviewed_output: {
            ...reviewedOutput,
            status: "draft",
            lease_review_ids: leaseStoreResult.inserted_ids,
          },
          review_audit: audit,
          review_status: "pending",
          valid_data: finalRows,
          parsed_data: finalRows,
          row_count: finalRows.length,
          valid_count: finalRows.length,
          updated_at: now,
        })
        .eq("id", file_id);

      if (prepareErr) throw new Error(`Prepare failed: ${prepareErr.message}`);

      await logger.event("review_gate", "succeeded", { action, row_count: finalRows.length });
      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "pending",
        store_result: leaseStoreResult,
        store_triggered: true,
        reviewed_output: {
          accepted_count: reviewedOutput.accepted_fields.length,
          rejected_count: reviewedOutput.rejected_fields.length,
          custom_count: reviewedOutput.custom_fields.length,
          row_count: finalRows.length,
        },
      });
    }

    if (action === "save") {
      const { error: saveErr } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          ui_review_payload: {
            ...payload,
            review_status: "saved",
            saved_by: user.id,
            saved_at: now,
          },
          reviewed_output: {
            ...reviewedOutput,
            status: "draft",
          },
          review_audit: audit,
          // Keep the database FSM in a reviewable state. "saved" is a UI
          // draft state in ui_review_payload, not an uploaded_files.review_status
          // value in the pipeline constraint.
          review_status: "pending",
          valid_data: finalRows,
          parsed_data: finalRows,
          row_count: finalRows.length,
          valid_count: finalRows.length,
          updated_at: now,
        })
        .eq("id", file_id);

      if (saveErr) throw new Error(`Save failed: ${saveErr.message}`);

      await logger.event("review_gate", "succeeded", { action, row_count: finalRows.length });
      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "saved",
        row_count: finalRows.length,
      });
    }

    if (action === "reject") {
      const rejectedPayload = {
        ...payload,
        review_status: "rejected",
        rejected_by: user.id,
        rejected_at: now,
      };
      const { error: rejectErr } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          ui_review_payload: rejectedPayload,
          reviewed_output: {
            ...reviewedOutput,
            status: "rejected",
            reject_reason,
          },
          review_audit: audit,
          review_status: "rejected",
          rejected_by: user.id,
          rejected_at: now,
          reject_reason,
          updated_at: now,
        })
        .eq("id", file_id);

      if (rejectErr) throw new Error(`Reject update failed: ${rejectErr.message}`);

      await setFailed(
        supabaseAdmin,
        file_id,
        `Rejected by reviewer: ${reject_reason}`,
        "review",
        60,
      );

      await logger.event("review_gate", "succeeded", { action, reject_reason });
      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "rejected",
        reject_reason,
      });
    }

    if (!finalRows || finalRows.length === 0) {
      await logger.event("review_gate", "failed", { action, reason: "empty_approval" });
      return jsonResponse(
        {
          error: true,
          message: "Cannot approve a file with 0 review records.",
          error_code: "EMPTY_APPROVAL",
        },
        422,
      );
    }

    const approvedPayload = {
      ...payload,
      review_status: "approved",
      approved_by: user.id,
      approved_at: now,
    };

    const { error: persistErr } = await supabaseAdmin
      .from("uploaded_files")
      .update({
        ui_review_payload: approvedPayload,
        reviewed_output: {
          ...reviewedOutput,
          status: "approved",
        },
        review_audit: audit,
        parsed_data: finalRows,
        valid_data: finalRows,
        row_count: finalRows.length,
        valid_count: finalRows.length,
        updated_at: now,
      })
      .eq("id", file_id);

    if (persistErr) {
      throw new Error(`Failed to persist reviewed output: ${persistErr.message}`);
    }

    // P0.6: lease-module approval goes through the two-finalizer gate
    // (extraction readiness, then approval) instead of the plain FSM
    // setStatus() sequence - this is what actually prevents approving a
    // file whose review_readiness never reached 'ready'. Non-lease modules
    // are out of P0's scope (no review_readiness concept applies to them)
    // and keep the original setStatus("approved") path unchanged.
    if (isLeaseModule(fileRecord.module_type)) {
      // Lease Truth Assembly approval-safety gate: block before the DB
      // finalizer even runs when any field carries an unresolved, genuine
      // conflict (see findConflictingTruthAssemblyFields above) -- this is
      // additive to the existing review_readiness gate below, not a
      // replacement for it.
      const conflictingFields = findConflictingTruthAssemblyFields(fileRecord);
      if (conflictingFields.length > 0) {
        await logger.event("review_gate", "blocked", {
          action,
          reason: "truth_assembly_conflict",
          conflicting_fields: conflictingFields,
        });
        return jsonResponse(
          {
            error: true,
            message: `Cannot approve: ${conflictingFields.length} field(s) have an unresolved conflict between independently-extracted candidates: ${conflictingFields.join(", ")}.`,
            error_code: "TRUTH_ASSEMBLY_CONFLICT",
            conflicting_fields: conflictingFields,
          },
          422,
        );
      }
      const { data: finalizeResult, error: finalizeRpcError } = await supabaseAdmin.rpc(
        "finalize_lease_review_approval",
        {
          p_org_id: orgId,
          p_uploaded_file_id: file_id,
          p_generation_id: fileRecord.active_generation_id ?? null,
          p_lease_id: null,
          p_actor_user_id: user.id,
          p_actor_email: user.email ?? null,
          p_idempotency_key: null,
        },
      );

      if (finalizeRpcError) {
        throw new Error(`Approval finalization RPC call failed: ${finalizeRpcError.message}`);
      }
      if (!finalizeResult?.success) {
        await logger.event("review_gate", "blocked", {
          action,
          reason: finalizeResult?.error_code || "APPROVAL_FINALIZATION_FAILED",
          readiness: finalizeResult?.readiness ?? null,
        });
        return jsonResponse(
          {
            error: true,
            message: finalizeResult?.error_code === "NOT_READY"
              ? `File is not ready for approval (review_readiness=${finalizeResult?.readiness}).`
              : (finalizeResult?.error_message || "Approval could not be finalized."),
            error_code: finalizeResult?.error_code || "APPROVAL_FINALIZATION_FAILED",
            readiness: finalizeResult?.readiness ?? null,
            blocking_reasons: finalizeResult?.blocking_reasons ?? null,
          },
          422,
        );
      }

      // Approval finalized (status now 'storing', artifact_sync_status
      // 'pending'). Artifact fan-out (CAM/clause sync) stays a best-effort,
      // non-transactional step (porting its ~2000-line matching/decision
      // engine to SQL is P1+ scope, same precedent as
      // persist_lease_extraction_merge/review_expense_classification) - but
      // its outcome is now explicitly tracked via artifact_sync_status
      // rather than silently conflated with the approval itself.
      let leaseStoreResult: unknown = null;
      let artifactSyncSucceeded = false;
      let artifactSyncErrorMessage: string | null = null;
      try {
        leaseStoreResult = await ensureLeaseReviewDrafts(
          supabaseAdmin,
          fileRecord,
          finalRows,
          reviewedOutput,
          user,
          true,
        );
        artifactSyncSucceeded = true;
      } catch (artifactError: any) {
        artifactSyncErrorMessage = artifactError?.message ?? String(artifactError);
        console.error(`[review-approve] artifact_sync_failed file_id=${file_id}:`, artifactSyncErrorMessage);
      }

      const { data: markResult, error: markRpcError } = await supabaseAdmin.rpc(
        "mark_lease_artifact_sync_result",
        {
          p_org_id: orgId,
          p_uploaded_file_id: file_id,
          p_success: artifactSyncSucceeded,
          p_error_message: artifactSyncErrorMessage,
        },
      );
      if (markRpcError) {
        console.error(`[review-approve] mark_lease_artifact_sync_result call failed file_id=${file_id}:`, markRpcError.message);
      }

      await logger.event("review_gate", "succeeded", {
        action,
        lease_module: true,
        artifact_sync_succeeded: artifactSyncSucceeded,
        row_count: finalRows.length,
      });
      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "approved",
        approval_state: "approved",
        artifact_sync_status: markResult?.artifact_sync_status ?? (artifactSyncSucceeded ? "completed" : "failed"),
        validate_result: {
          skipped: true,
          reason: "Lease documents are routed to Lease Review before final approval.",
        },
        store_result: leaseStoreResult,
        store_triggered: artifactSyncSucceeded,
        artifact_sync_error: artifactSyncErrorMessage,
        reviewed_output: {
          accepted_count: reviewedOutput.accepted_fields.length,
          rejected_count: reviewedOutput.rejected_fields.length,
          custom_count: reviewedOutput.custom_fields.length,
          row_count: finalRows.length,
        },
      });
    }

    const { error: approveErr } = await setStatus(
      supabaseAdmin,
      file_id,
      "approved",
      { approved_by: user.id },
    );
    if (approveErr) {
      throw new Error(`Approve status transition failed: ${approveErr.message}`);
    }

    const authHeader =
      req.headers.get("Authorization") ??
      req.headers.get("x-supabase-auth") ??
      req.headers.get("x-user-jwt") ??
      "";
    const actingOrgId = req.headers.get("x-acting-org-id")?.trim() || "";

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
          ...(actingOrgId ? { "x-acting-org-id": actingOrgId } : {}),
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
            ...(actingOrgId ? { "x-acting-org-id": actingOrgId } : {}),
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

    await logger.event("review_gate", storeOk ? "succeeded" : "failed", {
      action,
      lease_module: false,
      store_triggered: storeOk,
      row_count: finalRows.length,
    });
    return jsonResponse({
      error: !storeOk,
      file_id,
      action,
      review_status: "approved",
      validate_result: validateResult,
      store_result: storeResult,
      store_triggered: storeOk,
      reviewed_output: {
        accepted_count: reviewedOutput.accepted_fields.length,
        rejected_count: reviewedOutput.rejected_fields.length,
        custom_count: reviewedOutput.custom_fields.length,
        row_count: finalRows.length,
      },
    });
  } catch (err) {
    if (reviewGateLogger) {
      await reviewGateLogger.event("review_gate", "failed", { reason: err.message });
    }
    console.error("[review-approve] Error:", err.message, err.stack);
    return new Response(
      JSON.stringify({
        error: true,
        message: err.message,
        error_code: "REVIEW_APPROVE_FAILED",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

function normalizeSubmittedPayload(payload: any, editedRows: any, fileRecord: any, userId: string, now: string) {
  if (payload?.records || payload?.rows) {
    const records = (payload.records ?? payload.rows ?? []).map((record: any, index: number) =>
      normalizeRecord(record, index, userId, now)
    );
    return {
      ...payload,
      schema_version: payload.schema_version ?? 2,
      records,
      rows: records,
      updated_by: userId,
      updated_at: now,
    };
  }

  if (Array.isArray(editedRows)) {
    const records = editedRows.map((row: Record<string, unknown>, index: number) => {
      const standardFields = Object.entries(row).map(([key, value]) =>
        normalizeField({
          field_key: key,
          label: humanizeFieldName(key),
          value,
          original_value: value,
          is_standard: true,
          required: false,
          status: "accepted",
          accepted: true,
          rejected: false,
          source: "user",
          confidence: 1,
        }, index, "standard", userId, now)
      );
      return {
        record_index: index,
        row_index: index,
        standard_fields: standardFields,
        custom_fields: [],
        rejected_fields: [],
        missing_required: [],
        warnings: [],
        values: row,
      };
    });

    return {
      schema_version: 2,
      file_id: fileRecord.id,
      module_type: fileRecord.module_type,
      records,
      rows: records,
      updated_by: userId,
      updated_at: now,
    };
  }

  const fallbackRows = fileRecord.valid_data ?? fileRecord.parsed_data ?? [];
  return normalizeSubmittedPayload(null, fallbackRows, fileRecord, userId, now);
}

function normalizeRecord(record: any, index: number, userId: string, now: string) {
  const standardFields = Array.isArray(record.standard_fields)
    ? record.standard_fields.map((field: any) => normalizeField(field, index, "standard", userId, now))
    : [];
  const customFields = Array.isArray(record.custom_fields)
    ? record.custom_fields.map((field: any) => normalizeField(field, index, "custom", userId, now))
    : [];

  if (standardFields.length === 0 && record.fields && typeof record.fields === "object") {
    for (const [key, field] of Object.entries(record.fields)) {
      standardFields.push(
        normalizeField(
          {
            ...(typeof field === "object" ? field : { value: field }),
            field_key: key,
            label: humanizeFieldName(key),
            is_standard: true,
          },
          index,
          "standard",
          userId,
          now,
        ),
      );
    }
  }

  if (standardFields.length === 0 && record.values && typeof record.values === "object") {
    for (const [key, value] of Object.entries(record.values)) {
      standardFields.push(
        normalizeField(
          {
            field_key: key,
            label: humanizeFieldName(key),
            value,
            original_value: value,
            is_standard: true,
            source: "system",
          },
          index,
          "standard",
          userId,
          now,
        ),
      );
    }
  }

  const rejectedFields = [
    ...standardFields.filter((field: any) => field.status === "rejected"),
    ...customFields.filter((field: any) => field.status === "rejected"),
    ...(Array.isArray(record.rejected_fields) ? record.rejected_fields : []),
  ];
  const values = flattenFields([...standardFields, ...customFields], { includeMissingStandard: true });

  return {
    ...record,
    record_index: record.record_index ?? record.row_index ?? index,
    row_index: record.row_index ?? record.record_index ?? index,
    standard_fields: standardFields,
    custom_fields: customFields,
    rejected_fields: dedupeFields(rejectedFields),
    missing_required: findMissingRequired(standardFields),
    values,
  };
}

function normalizeField(field: any, recordIndex: number, kind: "standard" | "custom", userId: string, now: string) {
  const key = field.field_key ?? field.name ?? field.key ?? field.label ?? `custom_field_${recordIndex}`;
  const originalValue = field.original_value ?? field.value ?? null;
  const rejected = field.status === "rejected" || field.rejected === true;
  const accepted = field.status === "accepted" || field.accepted === true;
  const edited = field.status === "edited" || valueChanged(originalValue, field.value);
  const missing = isBlank(field.value);
  const status = rejected
    ? "rejected"
    : accepted
      ? "accepted"
      : edited
        ? "edited"
        : missing
          ? "missing"
          : "pending";

  return {
    id: field.id ?? `${recordIndex}:${kind}:${key}`,
    field_key: key,
    label: field.label ?? humanizeFieldName(key),
    value: field.value ?? null,
    original_value: originalValue,
    field_type: field.field_type ?? inferFieldType(field.value),
    required: !!field.required,
    is_standard: kind === "standard" ? field.is_standard !== false : false,
    confidence: normalizeConfidence(field.confidence),
    source: edited || accepted ? "user" : (field.source ?? "system"),
    evidence: field.evidence ?? null,
    status,
    accepted: status === "accepted" || status === "edited",
    rejected: status === "rejected",
    user_edit: edited
      ? {
          previous: originalValue,
          edited_at: field.user_edit?.edited_at ?? now,
          edited_by: field.user_edit?.edited_by ?? userId,
        }
      : field.user_edit ?? null,
  };
}

function buildReviewedOutput(payload: any, userId: string, now: string) {
  const records = payload.records ?? payload.rows ?? [];
  const finalRecords: Record<string, unknown>[] = [];
  const acceptedFields: any[] = [];
  const rejectedFields: any[] = [];
  const userEditedFields: any[] = [];
  const customFields: any[] = [];

  for (const record of records) {
    const allFields = [
      ...(record.standard_fields ?? []),
      ...(record.custom_fields ?? []),
    ];
    const flatRow = flattenFields(allFields, { includeMissingStandard: true });
    finalRecords.push(flatRow);

    for (const field of allFields) {
      const auditField = {
        record_index: record.record_index ?? record.row_index ?? 0,
        field_key: field.field_key,
        label: field.label,
        value: field.value ?? null,
        original_value: field.original_value ?? null,
        source: field.source,
        confidence: field.confidence,
        is_standard: field.is_standard !== false,
        status: field.status,
      };
      if (field.status === "rejected") rejectedFields.push(auditField);
      else acceptedFields.push(auditField);
      if (field.is_standard === false) customFields.push(auditField);
      if (field.status === "edited" || field.user_edit) userEditedFields.push(auditField);
    }

    if (Array.isArray(record.rejected_fields)) {
      for (const field of record.rejected_fields) {
        if (field?.status === "rejected") {
          rejectedFields.push({
            record_index: record.record_index ?? record.row_index ?? 0,
            field_key: field.field_key,
            label: field.label,
            value: field.value ?? null,
            original_value: field.original_value ?? null,
            source: field.source,
            confidence: field.confidence,
            is_standard: field.is_standard !== false,
            status: "rejected",
          });
        }
      }
    }
  }

  return {
    schema_version: 1,
    reviewed_by: userId,
    reviewed_at: now,
    workflow_output: payload?.metadata?.workflow_output ?? null,
    approved_standard_fields: acceptedFields.filter((field) => field.is_standard),
    custom_fields: customFields,
    user_edited_fields: userEditedFields,
    rejected_fields: dedupeFields(rejectedFields),
    accepted_fields: acceptedFields,
    final_records: finalRecords,
  };
}

function flattenFields(fields: any[], opts: { includeMissingStandard: boolean }) {
  const row: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.status === "rejected") continue;
    if (!field.field_key) continue;
    if (isBlank(field.value) && field.is_standard === false) continue;
    if (isBlank(field.value) && !opts.includeMissingStandard) continue;
    row[field.field_key] = field.value ?? null;
  }
  return row;
}

function findMissingRequired(fields: any[]) {
  return fields
    .filter((field) => field.required && field.status !== "rejected" && isBlank(field.value))
    .map((field) => field.field_key);
}

function dedupeFields(fields: any[]) {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const field of fields) {
    const key = `${field.record_index ?? 0}:${field.field_key}:${field.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(field);
  }
  return out;
}

function appendAudit(existing: unknown, event: Record<string, unknown>) {
  const current = Array.isArray(existing) ? existing : [];
  return [...current, event];
}

function isLeaseModule(moduleType: string | null | undefined): boolean {
  return moduleType === "leases" || moduleType === "lease";
}

// Lease Truth Assembly approval-safety gate (bounded, application-layer
// check -- no DB migration, no change to the existing review_readiness DB
// gate). A field the canonical publisher (lease-truth-assembly.ts) has
// explicitly marked "conflicting" (a genuine, evidence-backed disagreement
// between duplicate-concept candidates, e.g. start_date vs. commencement_date)
// must block approval rather than silently approving whichever value
// happened to be displayed.
function findConflictingTruthAssemblyFields(fileRecord: any): string[] {
  const records = fileRecord?.ui_review_payload?.records;
  if (!Array.isArray(records) || records.length === 0) return [];
  const conflicting = new Set<string>();
  for (const record of records) {
    const standardFields = Array.isArray(record?.standard_fields) ? record.standard_fields : [];
    for (const field of standardFields) {
      if (field?.truth_assembly_status === "conflicting") {
        conflicting.add(field.truth_assembly_field_id ?? field.field_key);
      }
    }
  }
  return [...conflicting];
}

function getExistingReviewedRows(fileRecord: any): Record<string, unknown>[] {
  if (Array.isArray(fileRecord.reviewed_output?.final_records)) {
    return fileRecord.reviewed_output.final_records;
  }
  if (Array.isArray(fileRecord.valid_data)) return fileRecord.valid_data;
  if (Array.isArray(fileRecord.parsed_data)) return fileRecord.parsed_data;
  const records = fileRecord.ui_review_payload?.records ?? fileRecord.ui_review_payload?.rows;
  if (Array.isArray(records)) {
    return records.map((record: any) =>
      record?.values && typeof record.values === "object"
        ? record.values
        : flattenFields([
          ...(record?.standard_fields ?? []),
          ...(record?.custom_fields ?? []),
        ], { includeMissingStandard: true })
    );
  }
  return [];
}

async function ensureLeaseReviewDrafts(
  supabaseAdmin: any,
  fileRecord: any,
  rows: Record<string, unknown>[],
  reviewedOutput: any,
  user: any,
  allowUpdate = false,
) {
  const now = new Date().toISOString();
  const existingIds = Array.isArray(reviewedOutput?.lease_review_ids)
    ? reviewedOutput.lease_review_ids.filter(Boolean)
    : [];
  if (existingIds.length > 0) {
    for (const existingId of existingIds) {
      await syncLeaseSourceDocument(supabaseAdmin, fileRecord.org_id, existingId, fileRecord, user);
    }
    return {
      table: "leases",
      inserted_count: 0,
      inserted_ids: existingIds,
      existing: true,
      draft_created: false,
      route: "lease_review",
    };
  }

  const finalRows = Array.isArray(rows) && rows.length > 0 ? rows : [buildEmptyLeaseReviewRow()];
  const insertedIds: string[] = [];
  let createdCount = 0;

  for (let rowIndex = 0; rowIndex < finalRows.length; rowIndex += 1) {
    const row = finalRows[rowIndex];
    const existingLeaseId = await findExistingLeaseDraft(supabaseAdmin, fileRecord, row);
    if (existingLeaseId) {
      if (allowUpdate) {
        // Re-run scenario: overwrite the stale draft's extracted fields with
        // the fresh pipeline output, but only while the lease is still "draft"
        // (i.e. the reviewer hasn't approved/rejected it yet).
        //
        // Azure+Vertex Phase 4E (local implementation): a re-run must never
        // silently wipe a reviewer's prior field-by-field decisions.
        // extraction_data is still rebuilt from scratch every time (so
        // untouched automated fields keep refreshing from the fresh
        // extraction) but the existing extraction_data.field_reviews value
        // is read first and overlaid back onto the fresh payload afterward.
        // field_reviews is confirmed (by reading every migration that
        // targets an extraction_data sub-key) to be the SOLE human-owned key
        // inside extraction_data - no other sub-key is written by any RPC.
        const { data: existingLeaseRow } = await supabaseAdmin
          .from("leases")
          .select("extraction_data")
          .eq("id", existingLeaseId)
          .maybeSingle();
        const existingFieldReviews = existingLeaseRow?.extraction_data?.field_reviews;

        const fullPayload = buildLeaseReviewDraftPayload(fileRecord, row, reviewedOutput, user, now, rowIndex, existingFieldReviews);
        const { org_id: _o, created_by: _cb, created_at: _ca, status: _s, ...patchFields } = fullPayload as any;
        await supabaseAdmin
          .from("leases")
          .update({ ...patchFields, updated_at: now })
          .eq("id", existingLeaseId)
          .eq("status", "draft");
        console.log(
          `[review-approve] Updated existing draft lease ${existingLeaseId} with fresh extraction data` +
          (existingFieldReviews && Object.keys(existingFieldReviews).length > 0
            ? ` (preserved ${Object.keys(existingFieldReviews).length} existing reviewer field_reviews)`
            : ""),
        );
      }
      await syncLeaseSourceDocument(supabaseAdmin, fileRecord.org_id, existingLeaseId, fileRecord, user);
      await syncLeaseWorkflowArtifacts(
        supabaseAdmin,
        fileRecord.org_id,
        existingLeaseId,
        getWorkflowOutputForRow(reviewedOutput, rowIndex),
      );
      insertedIds.push(existingLeaseId);
      continue;
    }

    const leasePayload = buildLeaseReviewDraftPayload(fileRecord, row, reviewedOutput, user, now, rowIndex);
    const inserted = await insertLeaseDraft(supabaseAdmin, leasePayload);
    await syncLeaseSourceDocument(supabaseAdmin, fileRecord.org_id, inserted.id, fileRecord, user);
    await syncLeaseWorkflowArtifacts(
      supabaseAdmin,
      fileRecord.org_id,
      inserted.id,
      getWorkflowOutputForRow(reviewedOutput, rowIndex),
    );
    insertedIds.push(inserted.id);
    createdCount += 1;
  }

  return {
    table: "leases",
    inserted_count: createdCount,
    inserted_ids: insertedIds,
    existing: createdCount === 0,
    draft_created: createdCount > 0,
    route: "lease_review",
  };
}

async function syncLeaseSourceDocument(supabaseAdmin: any, orgId: string, leaseId: string, fileRecord: any, user: any) {
  if (!orgId || !leaseId || !fileRecord?.id) return;

  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, org_id, source_file_id, extraction_data")
    .eq("id", leaseId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (leaseError || !lease?.id) {
    throw new Error(`Could not verify lease source link: ${leaseError?.message ?? "lease not found"}`);
  }

  const extractionData = lease.extraction_data && typeof lease.extraction_data === "object"
    ? lease.extraction_data
    : {};
  const existingSource = lease.source_file_id ?? extractionData.source_file_id ?? null;
  if (existingSource && existingSource !== fileRecord.id) {
    throw new Error("Existing lease source_file_id does not match this upload");
  }

  const nextExtractionData = {
    ...extractionData,
    source_file_id: fileRecord.id,
    source_file_name: fileRecord.file_name ?? extractionData.source_file_name ?? null,
    document_subtype: fileRecord.document_subtype ?? extractionData.document_subtype ?? null,
  };
  const { error: updateError } = await supabaseAdmin
    .from("leases")
    .update({
      source_file_id: fileRecord.id,
      extraction_data: nextExtractionData,
      updated_at: new Date().toISOString(),
    })
    .eq("id", leaseId)
    .eq("org_id", orgId);
  if (updateError) {
    throw new Error(`Could not persist lease source link: ${updateError.message}`);
  }

  const { error: linkError } = await supabaseAdmin
    .from("document_links")
    .upsert({
      org_id: orgId,
      file_id: fileRecord.id,
      entity_type: "lease",
      entity_id: leaseId,
      link_role: "source",
      created_by: user?.id ?? null,
    }, { onConflict: "file_id,entity_type,entity_id,link_role" });
  if (linkError) {
    console.warn(`[review-approve] document_links source sync skipped: ${linkError.message}`);
  }
}

function buildEmptyLeaseReviewRow() {
  // Empty row when extraction produced no structured fields. EVERY field
  // stays null so downstream readers can't mistake a UI placeholder for
  // extracted lease data. The "Lease Review Draft" string used to live in
  // tenant_name and silently became the tenant's name on the lease row -
  // that regression is what this nullification prevents.
  return {
    tenant_name: null,
    start_date: null,
    end_date: null,
    monthly_rent: null,
    square_footage: null,
    lease_type: null,
    notes: "Created from an approved document review with no structured fields.",
  };
}

async function findExistingLeaseDraft(supabaseAdmin: any, fileRecord: any, _row: Record<string, unknown>) {
  const reviewedIds = Array.isArray(fileRecord.reviewed_output?.lease_review_ids)
    ? fileRecord.reviewed_output.lease_review_ids.filter(Boolean)
    : [];
  if (reviewedIds.length > 0) return reviewedIds[0];

  const attempts = [
    () => supabaseAdmin
      .from("leases")
      .select("id")
      .eq("org_id", fileRecord.org_id)
      .eq("source_file_id", fileRecord.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    () => supabaseAdmin
      .from("leases")
      .select("id")
      .eq("org_id", fileRecord.org_id)
      .eq("extraction_data->>source_file_id", fileRecord.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    () => supabaseAdmin
      .from("leases")
      .select("id")
      .eq("org_id", fileRecord.org_id)
      .eq("extraction_data->>uploaded_file_id", fileRecord.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ];

  for (const run of attempts) {
    const { data, error } = await run();
    if (error) {
      console.warn(`[review-approve] Existing lease source lookup failed: ${error.message}`);
      continue;
    }
    if (data?.id) return data.id;
  }

  const linkLookup = await supabaseAdmin
    .from("document_links")
    .select("entity_id")
    .eq("org_id", fileRecord.org_id)
    .eq("file_id", fileRecord.id)
    .eq("entity_type", "lease")
    .in("link_role", ["source", "source_file"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!linkLookup.error && linkLookup.data?.entity_id) {
    return linkLookup.data.entity_id;
  }

  return null;
}

function buildLeaseReviewDraftPayload(
  fileRecord: any,
  row: Record<string, unknown>,
  reviewedOutput: any,
  user: any,
  now: string,
  rowIndex = 0,
  existingFieldReviews?: Record<string, unknown> | null,
) {
  // Merge confidence sources: per-row field confidence (from reviewer audit)
  // plus the workflow's per-field confidence_score. The workflow scores are
  // critical because the upload pipeline doesn't surface per-field reviewer
  // confidence on first publish.
  const workflowOutputEarly = getWorkflowOutputForRow(reviewedOutput, rowIndex);
  const confidenceScores = mergeConfidenceMaps(
    collectConfidenceScores(reviewedOutput),
    collectConfidenceFromWorkflow(workflowOutputEarly),
  );
  const lowConfidenceFields = Object.entries(confidenceScores)
    .filter(([, score]) => typeof score === "number" && score < 75)
    .map(([field]) => field);
  const customFields = Array.isArray(reviewedOutput?.custom_fields)
    ? reviewedOutput.custom_fields.filter((field: any) => field?.status !== "rejected")
    : [];
  const rejectedFields = Array.isArray(reviewedOutput?.rejected_fields)
    ? reviewedOutput.rejected_fields
    : [];

  const monthlyRent = toNumber(row.monthly_rent ?? row.base_rent);
  const annualRent = toNumber(row.annual_rent) ?? (monthlyRent != null ? monthlyRent * 12 : null);
  const squareFootage = toNumber(row.square_footage ?? row.total_sf);
  const rentPerSf = toNumber(row.rent_per_sf) ??
    (annualRent != null && squareFootage ? roundMoney(annualRent / squareFootage) : null);
  const workflowOutput = getWorkflowOutputForRow(reviewedOutput, rowIndex);
  // Carry the consolidated extraction diagnostics (incl. mapping_failure_reason)
  // onto the lease so the Extraction Debug panel and Lease Review readiness
  // banner can read them without falling back to the uploaded_files row.
  const extractionDebug =
    fileRecord?.normalized_output?.metadata?.extractionDebug
    || fileRecord?.normalized_output?.metadata?.extraction_debug
    || fileRecord?.ui_review_payload?.metadata?.extractionDebug
    || fileRecord?.ui_review_payload?.metadata?.extraction_debug
    || null;
  const workflowFields = workflowOutput?.lease_fields ?? {};
  const workflowFieldValue = (key: string) =>
    workflowFields?.[key] && workflowFields[key].value != null && workflowFields[key].value !== ""
      ? workflowFields[key].value
      : null;

  return stripUndefined({
    org_id: fileRecord.org_id,
    source_file_id: fileRecord.id ?? null,
    property_id: row.property_id ?? fileRecord.property_id ?? null,
    building_id: row.building_id ?? fileRecord.building_id ?? null,
    unit_id: row.unit_id ?? fileRecord.unit_id ?? null,
    // Write null when extraction returned no tenant_name. The previous
    // fallback wrote the literal string "Lease Review Draft" which the
    // resolver then displayed as the extracted tenant. Lease list views
    // can show "Untitled draft" - that's a display decision, not data.
    tenant_name: row.tenant_name ?? null,
    start_date: normalizeDate(row.start_date ?? row.lease_start),
    end_date: normalizeDate(row.end_date ?? row.lease_end),
    // Preserve null when extraction found no rent value. The leases.monthly_rent
    // column is `numeric DEFAULT 0` but nullable; writing null here keeps the
    // extraction surface honest ("Not Found") instead of stamping a misleading
    // $0 that the UI then renders as a confirmed extracted value. Downstream
    // arithmetic consumers (billing/budget/CAM) already coalesce null to 0.
    monthly_rent: monthlyRent ?? null,
    square_footage: squareFootage ?? null,
    lease_type: row.lease_type ?? null,
    lease_date: normalizeDate(workflowFieldValue("lease_date")),
    property_name: workflowFieldValue("property_name") ?? null,
    property_address: workflowFieldValue("property_address") ?? row.property_address ?? null,
    landlord_address: workflowFieldValue("landlord_address") ?? null,
    tenant_contact_name: workflowFieldValue("tenant_contact_name") ?? null,
    tenant_address: workflowFieldValue("tenant_address") ?? null,
    suite_number: workflowFieldValue("suite_number") ?? row.unit_number ?? null,
    rentable_area_sqft: toNumber(workflowFieldValue("rentable_area_sqft")),
    permitted_use: workflowFieldValue("permitted_use") ?? null,
    broker_name: workflowFieldValue("broker_name") ?? null,
    lease_term: workflowFieldValue("lease_term") ?? null,
    commencement_date: normalizeDate(workflowFieldValue("commencement_date")),
    rent_commencement_date: normalizeDate(
      workflowFieldValue("rent_commencement_date") ?? row.rent_commencement_date ?? row.rent_start_date,
    ),
    expiration_date: normalizeDate(workflowFieldValue("expiration_date")),
    renewal_notice_days: toInteger(workflowFieldValue("renewal_notice_days")),
    renewal_escalation_percent: toNumber(workflowFieldValue("renewal_escalation_percent")),
    holdover_rent_multiplier: toNumber(workflowFieldValue("holdover_rent_multiplier")),
    base_rent_monthly: toNumber(workflowFieldValue("base_rent_monthly")),
    rent_due_day: toInteger(workflowFieldValue("rent_due_day")),
    rent_frequency: workflowFieldValue("rent_frequency") ?? null,
    rent_payment_timing: workflowFieldValue("rent_payment_timing") ?? null,
    late_fee_grace_days: toInteger(workflowFieldValue("late_fee_grace_days")),
    late_fee_percent: toNumber(workflowFieldValue("late_fee_percent")),
    default_interest_rate_formula: workflowFieldValue("default_interest_rate_formula") ?? null,
    building_rsf: toNumber(workflowFieldValue("building_rsf")),
    tenant_rsf: toNumber(workflowFieldValue("tenant_rsf")),
    tenant_pro_rata_share: toNumber(workflowFieldValue("tenant_pro_rata_share")),
    floor_plan_reference: workflowFieldValue("floor_plan_reference") ?? null,
    parking_rights: workflowFieldValue("parking_rights") ?? null,
    common_area_description: workflowFieldValue("common_area_description") ?? null,
    status: "draft",
    created_by: user.email ?? user.id,
    created_at: now,
    updated_at: now,
    annual_rent: annualRent,
    rent_per_sf: rentPerSf,
    lease_term_months: toInteger(row.lease_term_months),
    security_deposit: toNumber(row.security_deposit),
    cam_amount: toNumber(row.cam_amount),
    nnn_amount: toNumber(row.nnn_amount),
    escalation_rate: toNumber(row.escalation_rate),
    renewal_options: row.renewal_options ?? null,
    ti_allowance: toNumber(row.ti_allowance),
    free_rent_months: toInteger(row.free_rent_months),
    notes: row.notes ?? null,
    escalation_type: row.escalation_type ?? null,
    escalation_timing: row.escalation_timing ?? null,
    cam_applicable: row.cam_applicable ?? null,
    cam_cap: toNumber(row.cam_cap),
    cam_cap_type: row.cam_cap_type ?? null,
    cam_cap_rate: toNumber(row.cam_cap_rate),
    admin_fee_pct: toNumber(row.admin_fee_pct),
    management_fee_pct: toNumber(row.management_fee_pct),
    management_fee_basis: row.management_fee_basis ?? null,
    gross_up_clause: row.gross_up_clause ?? null,
    allocation_method: row.allocation_method ?? null,
    weight_factor: toNumber(row.weight_factor),
    base_year_amount: toNumber(row.base_year_amount),
    expense_stop_amount: toNumber(row.expense_stop_amount),
    hvac_responsibility: row.hvac_responsibility ?? null,
    sales_reporting_frequency: row.sales_reporting_frequency ?? null,
    extraction_data: {
      source: "document_review",
      source_file_id: fileRecord.id,
      source_file_name: fileRecord.file_name ?? null,
      document_subtype: fileRecord.document_subtype ?? null,
      confidence_scores: confidenceScores,
      // Per-field evidence map the Lease Review UI reads to render Raw
      // Extracted / Source Page / Exact Source Text / Extraction Status.
      // Shape matches what readFieldEvidence() in the frontend expects.
      fields: buildPerFieldEvidence(workflowOutput, row),
      field_evidence: buildPerFieldEvidence(workflowOutput, row),
      custom_fields: customFields,
      rejected_fields: rejectedFields,
      workflow_output: workflowOutput,
      extraction_debug: extractionDebug,
      reviewed_at: reviewedOutput?.reviewed_at ?? now,
      reviewed_by: reviewedOutput?.reviewed_by ?? user.id,
      // Preserve prior reviewer decisions exactly across an automated
      // re-run - see the allowUpdate call site's comment. Only overlaid
      // when the caller actually found an existing non-empty value; a
      // fresh/first-time draft build (existingFieldReviews undefined) does
      // not add this key at all, matching pre-Phase-4E payload shape.
      ...(existingFieldReviews && Object.keys(existingFieldReviews).length > 0
        ? { field_reviews: existingFieldReviews }
        : {}),
    },
    confidence_score: averageConfidence(confidenceScores),
    low_confidence_fields: lowConfidenceFields,
    extracted_fields: row,
  });
}

function getWorkflowOutputForRow(reviewedOutput: any, rowIndex = 0) {
  const workflowOutput = reviewedOutput?.workflow_output;
  if (!workflowOutput) return null;
  if (Array.isArray(workflowOutput?.records)) {
    return workflowOutput.records[rowIndex] ?? workflowOutput.records[0] ?? null;
  }
  return workflowOutput;
}

async function syncLeaseWorkflowArtifacts(supabaseAdmin: any, orgId: string, leaseId: string, workflowOutput: any) {
  if (!workflowOutput || !leaseId) return;

  const leaseClauses = Array.isArray(workflowOutput?.lease_clauses)
    ? workflowOutput.lease_clauses
        .filter((clause: any) => clause?.clause_text)
        .map((clause: any) => ({
          org_id: orgId,
          lease_id: leaseId,
          clause_type: clause.clause_type,
          clause_title: clause.clause_title,
          clause_text: clause.clause_text,
          source_page: clause.source_page ?? null,
          confidence_score: clause.confidence_score ?? null,
          structured_fields_json: clause.structured_fields_json ?? {},
          source: "document_review",
        }))
    : [];

  if (leaseClauses.length > 0) {
    try {
      await supabaseAdmin
        .from("lease_clauses")
        .delete()
        .eq("lease_id", leaseId)
        .eq("source", "document_review");
      await supabaseAdmin.from("lease_clauses").insert(leaseClauses);
    } catch (error) {
      console.warn(`[review-approve] lease_clauses sync skipped: ${error?.message ?? error}`);
    }
  }

  // Keep downstream financial artifacts behind the approval boundary.
  // CAM profiles and lease-expense rule rows are published by
  // approve-lease-workflow (or the approved-lease backfill endpoint), never
  // while this function is preparing/updating a review draft.
}

async function insertLeaseDraft(supabaseAdmin: any, payload: Record<string, unknown>) {
  let { data, error } = await supabaseAdmin
    .from("leases")
    .insert(payload)
    .select("id")
    .single();

  if (error && looksLikeMissingLeaseMetadataColumn(error)) {
    const fallbackPayload = { ...payload };
    for (const key of LEASE_WORKFLOW_OPTIONAL_COLUMNS) {
      delete fallbackPayload[key];
    }
    const retry = await supabaseAdmin
      .from("leases")
      .insert(fallbackPayload)
      .select("id")
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error || !data?.id) {
    throw new Error(`Failed to create lease review draft: ${error?.message ?? "No inserted id returned"}`);
  }

  return data;
}

function looksLikeMissingLeaseMetadataColumn(error: any): boolean {
  const message = String(error?.message || error?.details || "");
  const code = String(error?.code || "");
  return code === "42703" ||
    code === "PGRST204" ||
    /source_file_id|extraction_data|confidence_score|low_confidence_fields|extracted_fields|lease_date|property_name|property_address|landlord_address|tenant_contact_name|tenant_address|suite_number|rentable_area_sqft|permitted_use|broker_name|lease_term|commencement_date|rent_commencement_date|expiration_date|renewal_notice_days|renewal_escalation_percent|holdover_rent_multiplier|base_rent_monthly|rent_due_day|rent_frequency|rent_payment_timing|late_fee_grace_days|late_fee_percent|default_interest_rate_formula|building_rsf|tenant_rsf|tenant_pro_rata_share|floor_plan_reference|parking_rights|common_area_description/i.test(message);
}

const LEASE_WORKFLOW_OPTIONAL_COLUMNS = [
  "source_file_id",
  "extraction_data",
  "confidence_score",
  "low_confidence_fields",
  "extracted_fields",
  "lease_date",
  "property_name",
  "property_address",
  "landlord_address",
  "tenant_contact_name",
  "tenant_address",
  "suite_number",
  "rentable_area_sqft",
  "permitted_use",
  "broker_name",
  "lease_term",
  "commencement_date",
  "rent_commencement_date",
  "expiration_date",
  "renewal_notice_days",
  "renewal_escalation_percent",
  "holdover_rent_multiplier",
  "base_rent_monthly",
  "rent_due_day",
  "rent_frequency",
  "rent_payment_timing",
  "late_fee_grace_days",
  "late_fee_percent",
  "default_interest_rate_formula",
  "building_rsf",
  "tenant_rsf",
  "tenant_pro_rata_share",
  "floor_plan_reference",
  "parking_rights",
  "common_area_description",
];

/**
 * Build the per-field evidence map consumed by the Lease Review UI.
 *
 * For each lease_field emitted by buildLeaseWorkflowAbstraction, expose:
 *   { value, raw_value, source_page, source_text, source_clause,
 *     confidence, confidence_score, extraction_status, manually_edited }
 *
 * The frontend's readFieldEvidence() walks extraction_data.fields[key] +
 * extraction_data.field_evidence[key]. Both are written from the same source
 * so older readers (which look at one and not the other) still resolve.
 */
function buildPerFieldEvidence(workflowOutput: any, row: Record<string, unknown>): Record<string, unknown> {
  const leaseFields = workflowOutput?.lease_fields ?? {};
  const evidence: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(leaseFields)) {
    if (!field || typeof field !== "object") continue;
    const f = field as Record<string, unknown>;
    const rawCandidate = f.raw_value ?? f.source_clause ?? row?.[key] ?? null;
    evidence[key] = {
      value: f.value ?? null,
      raw_value: rawCandidate,
      raw: rawCandidate,
      source_page: f.source_page ?? null,
      page: f.source_page ?? null,
      source_text: f.source_clause ?? null,
      exact_source_text: f.source_clause ?? null,
      snippet: f.source_clause ?? null,
      source_clause: f.source_clause ?? null,
      confidence: normalizeConfidence(f.confidence_score),
      confidence_score: normalizeConfidence(f.confidence_score),
      extraction_status: f.extraction_status ?? null,
      field_group: f.field_group ?? null,
    };
  }
  return evidence;
}

/**
 * Read every lease_field's confidence_score and emit a key->0-100 map.
 * normalize-pdf-output writes lease_field.confidence_score as a 0-1 float;
 * the UI expects 0-100 so we scale here.
 */
function collectConfidenceFromWorkflow(workflowOutput: any): Record<string, number> {
  const out: Record<string, number> = {};
  const leaseFields = workflowOutput?.lease_fields ?? {};
  for (const [key, field] of Object.entries(leaseFields)) {
    if (!field || typeof field !== "object") continue;
    const raw = (field as Record<string, unknown>).confidence_score;
    if (typeof raw !== "number" || Number.isNaN(raw)) continue;
    out[key] = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  }
  return out;
}

function mergeConfidenceMaps(...maps: Record<string, number>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === "number" && !Number.isNaN(v)) merged[k] = v;
    }
  }
  return merged;
}

function collectConfidenceScores(reviewedOutput: any): Record<string, number> {
  const scores: Record<string, number> = {};
  const fields = [
    ...(reviewedOutput?.accepted_fields ?? []),
    ...(reviewedOutput?.user_edited_fields ?? []),
  ];
  for (const field of fields) {
    if (!field?.field_key) continue;
    const score = normalizeConfidence(field.confidence);
    if (score == null) continue;
    scores[field.field_key] = score <= 1 ? Math.round(score * 100) : Math.round(score);
  }
  return scores;
}

function averageConfidence(scores: Record<string, number>): number | null {
  const values = Object.values(scores).filter((score) => typeof score === "number" && !Number.isNaN(score));
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, score) => sum + score, 0) / values.length);
}

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed == null ? null : Math.round(parsed);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function stripUndefined(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value <= 1) return Math.max(0, Math.min(1, value));
  return Math.max(0, Math.min(1, value / 100));
}

function inferFieldType(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  return "string";
}

function valueChanged(previous: unknown, next: unknown): boolean {
  return JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null);
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function humanizeFieldName(fieldName: string): string {
  return String(fieldName)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// Test hook (same pattern as lease-extraction-worker/index.ts's __test__).
export const __test__ = {
  buildLeaseReviewDraftPayload,
  findConflictingTruthAssemblyFields,
};
