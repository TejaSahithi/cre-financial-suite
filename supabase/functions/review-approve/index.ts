// @ts-nocheck
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
      review_payload,
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

    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select(
        "id, org_id, module_type, status, review_required, review_status, " +
        "ui_review_payload, reviewed_output, review_audit, valid_data, parsed_data",
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
          message: `File ${file_id} does not require review.`,
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
          review_status: "saved",
          valid_data: finalRows,
          parsed_data: finalRows,
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

      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "rejected",
        reject_reason,
      });
    }

    if (!finalRows || finalRows.length === 0) {
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
      reviewed_output: {
        accepted_count: reviewedOutput.accepted_fields.length,
        rejected_count: reviewedOutput.rejected_fields.length,
        custom_count: reviewedOutput.custom_fields.length,
        row_count: finalRows.length,
      },
    });
  } catch (err) {
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
