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

    if (!["approve", "reject", "save", "prepare"].includes(action)) {
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

    if (isLeaseModule(fileRecord.module_type)) {
      const leaseStoreResult = await ensureLeaseReviewDrafts(
        supabaseAdmin,
        fileRecord,
        finalRows,
        reviewedOutput,
        user,
      );

      const { error: storingStatusError } = await setStatus(supabaseAdmin, file_id, "storing");
      if (storingStatusError) {
        throw new Error(`Lease draft staging failed: ${storingStatusError.message}`);
      }
      const { error: storedStatusError } = await setStatus(supabaseAdmin, file_id, "stored", {
        reviewed_output: {
          ...reviewedOutput,
          status: "approved",
          lease_review_ids: leaseStoreResult.inserted_ids,
        },
      });
      if (storedStatusError) {
        throw new Error(`Lease draft finalization failed: ${storedStatusError.message}`);
      }

      return jsonResponse({
        error: false,
        file_id,
        action,
        review_status: "approved",
        validate_result: {
          skipped: true,
          reason: "Lease documents are routed to Lease Review before final approval.",
        },
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
) {
  const now = new Date().toISOString();
  const existingIds = Array.isArray(reviewedOutput?.lease_review_ids)
    ? reviewedOutput.lease_review_ids.filter(Boolean)
    : [];
  if (existingIds.length > 0) {
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

function buildEmptyLeaseReviewRow() {
  return {
    tenant_name: "Lease Review Draft",
    start_date: null,
    end_date: null,
    monthly_rent: null,
    square_footage: null,
    lease_type: null,
    notes: "Created from an approved document review with no structured fields.",
  };
}

async function findExistingLeaseDraft(supabaseAdmin: any, fileRecord: any, row: Record<string, unknown>) {
  const reviewedIds = Array.isArray(fileRecord.reviewed_output?.lease_review_ids)
    ? fileRecord.reviewed_output.lease_review_ids.filter(Boolean)
    : [];
  if (reviewedIds.length > 0) return reviewedIds[0];

  const sourceLookup = await supabaseAdmin
    .from("leases")
    .select("id")
    .eq("org_id", fileRecord.org_id)
    .eq("extraction_data->>source_file_id", fileRecord.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sourceLookup.error && sourceLookup.data?.id) return sourceLookup.data.id;

  const tenantName = String(row.tenant_name ?? "").trim();
  if (!tenantName) return null;

  let query = supabaseAdmin
    .from("leases")
    .select("id")
    .eq("org_id", fileRecord.org_id)
    .eq("tenant_name", tenantName)
    .order("updated_at", { ascending: false })
    .limit(1);

  const propertyId = row.property_id ?? fileRecord.property_id;
  if (propertyId) query = query.eq("property_id", propertyId);
  if (row.start_date) query = query.eq("start_date", row.start_date);
  if (row.end_date) query = query.eq("end_date", row.end_date);

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.warn(`[review-approve] Existing lease lookup failed: ${error.message}`);
    return null;
  }
  return data?.id ?? null;
}

function buildLeaseReviewDraftPayload(
  fileRecord: any,
  row: Record<string, unknown>,
  reviewedOutput: any,
  user: any,
  now: string,
  rowIndex = 0,
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
  const workflowFields = workflowOutput?.lease_fields ?? {};
  const workflowFieldValue = (key: string) =>
    workflowFields?.[key] && workflowFields[key].value != null && workflowFields[key].value !== ""
      ? workflowFields[key].value
      : null;

  return stripUndefined({
    org_id: fileRecord.org_id,
    property_id: row.property_id ?? fileRecord.property_id ?? null,
    building_id: row.building_id ?? fileRecord.building_id ?? null,
    unit_id: row.unit_id ?? fileRecord.unit_id ?? null,
    tenant_name: row.tenant_name ?? "Lease Review Draft",
    start_date: normalizeDate(row.start_date ?? row.lease_start),
    end_date: normalizeDate(row.end_date ?? row.lease_end),
    monthly_rent: monthlyRent ?? 0,
    square_footage: squareFootage ?? 0,
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
      reviewed_at: reviewedOutput?.reviewed_at ?? now,
      reviewed_by: reviewedOutput?.reviewed_by ?? user.id,
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

  if (workflowOutput?.cam_profile) {
    // Pull the lease's property_id so the cam_profile is scoped properly.
    let propertyId: string | null = null;
    try {
      const { data: leaseRow } = await supabaseAdmin
        .from("leases")
        .select("property_id")
        .eq("id", leaseId)
        .maybeSingle();
      propertyId = leaseRow?.property_id ?? null;
    } catch (_) {
      propertyId = null;
    }
    const profilePayload = {
      org_id: orgId,
      lease_id: leaseId,
      property_id: propertyId,
      cam_structure: workflowOutput.cam_profile.cam_structure ?? null,
      recovery_status: workflowOutput.cam_profile.recovery_status ?? null,
      cam_start_date: workflowOutput.cam_profile.cam_start_date ?? null,
      cam_end_date: workflowOutput.cam_profile.cam_end_date ?? null,
      estimate_frequency: workflowOutput.cam_profile.estimate_frequency ?? null,
      reconciliation_frequency: workflowOutput.cam_profile.reconciliation_frequency ?? null,
      tenant_rsf: workflowOutput.cam_profile.tenant_rsf ?? null,
      building_rsf: workflowOutput.cam_profile.building_rsf ?? null,
      tenant_pro_rata_share: workflowOutput.cam_profile.tenant_pro_rata_share ?? null,
      cam_cap_type: workflowOutput.cam_profile.cam_cap_type ?? null,
      cam_cap_percent: workflowOutput.cam_profile.cam_cap_percent ?? null,
      admin_fee_percent: workflowOutput.cam_profile.admin_fee_percent ?? null,
      gross_up_percent: workflowOutput.cam_profile.gross_up_percent ?? null,
      included_expenses: workflowOutput.cam_profile.included_expenses ?? [],
      excluded_expenses: workflowOutput.cam_profile.excluded_expenses ?? [],
      actual_cam_expense: workflowOutput.cam_profile.actual_cam_expense ?? null,
      estimated_cam_billed: workflowOutput.cam_profile.estimated_cam_billed ?? null,
      reconciliation_amount: workflowOutput.cam_profile.reconciliation_amount ?? null,
      tenant_balance_due_or_credit: workflowOutput.cam_profile.tenant_balance_due_or_credit ?? null,
      status: workflowOutput.cam_profile.status ?? "draft",
      source: "document_review",
    };

    try {
      await supabaseAdmin.from("cam_profiles").upsert(profilePayload, { onConflict: "lease_id" });
    } catch (error) {
      console.warn(`[review-approve] cam_profiles sync skipped: ${error?.message ?? error}`);
    }
  }

  // Persist expense rules derived from the lease language. This is what
  // populates the Expenses module (LeaseExpenseRules page) and gives CAM
  // Setup its recoverable category list.
  await syncLeaseExpenseRules(supabaseAdmin, orgId, leaseId, workflowOutput);
}

/**
 * Persist workflow_output.expense_rules into lease_expense_rule_sets +
 * lease_expense_rules. Idempotent: if a rule set already exists for this
 * lease+version we keep it and refresh the child rows.
 *
 * Each expense_rule from the workflow maps a string category (e.g. "cam",
 * "real_estate_taxes") to a row in the org's expense_categories taxonomy.
 * Missing categories are auto-created with a stable normalized_key so the
 * caller never has to bootstrap the taxonomy by hand.
 */
async function syncLeaseExpenseRules(supabaseAdmin: any, orgId: string, leaseId: string, workflowOutput: any) {
  const expenseRules = Array.isArray(workflowOutput?.expense_rules) ? workflowOutput.expense_rules : [];
  if (expenseRules.length === 0) return;

  try {
    // 1. Ensure a draft rule set exists.
    let ruleSetId: string | null = null;
    const { data: existingSets } = await supabaseAdmin
      .from("lease_expense_rule_sets")
      .select("id, status, version")
      .eq("lease_id", leaseId)
      .neq("status", "archived")
      .order("version", { ascending: false })
      .limit(1);
    if (existingSets && existingSets[0]?.id) {
      ruleSetId = existingSets[0].id;
    } else {
      const { data: created, error: createErr } = await supabaseAdmin
        .from("lease_expense_rule_sets")
        .insert({
          org_id: orgId,
          lease_id: leaseId,
          version: 1,
          status: "draft",
        })
        .select("id")
        .single();
      if (createErr || !created?.id) {
        console.warn(`[review-approve] lease_expense_rule_sets insert skipped: ${createErr?.message ?? createErr}`);
        return;
      }
      ruleSetId = created.id;
    }
    if (!ruleSetId) return;

    // 2. Resolve / create expense_categories for every category string.
    const categoryKeys = Array.from(new Set(
      expenseRules
        .map((r: any) => normalizeCategoryKey(r?.expense_category || r?.category || r?.key))
        .filter(Boolean),
    ));
    if (categoryKeys.length === 0) return;

    // Pull both org-scoped categories AND system_default categories so we
    // don't duplicate the global taxonomy per-org.
    const { data: existingCategories } = await supabaseAdmin
      .from("expense_categories")
      .select("id, normalized_key, category_name, subcategory_name, org_id, is_system_default")
      .or(`org_id.eq.${orgId},org_id.is.null`)
      .in("normalized_key", categoryKeys);
    const categoryByKey = new Map<string, any>();
    for (const cat of existingCategories || []) {
      if (cat?.normalized_key && !categoryByKey.has(String(cat.normalized_key))) {
        categoryByKey.set(String(cat.normalized_key), cat);
      }
    }
    const missingKeys = categoryKeys.filter((k) => !categoryByKey.has(k));
    if (missingKeys.length > 0) {
      const insertCats = missingKeys.map((k) => ({
        org_id: orgId,
        normalized_key: k,
        category_name: humanizeFieldName(k),
        subcategory_name: humanizeFieldName(k),
      }));
      const { data: insertedCats, error: insertCatsErr } = await supabaseAdmin
        .from("expense_categories")
        .insert(insertCats)
        .select("id, normalized_key");
      if (insertCatsErr) {
        console.warn(`[review-approve] expense_categories insert skipped: ${insertCatsErr.message}`);
      } else {
        for (const cat of insertedCats || []) {
          if (cat?.normalized_key) categoryByKey.set(String(cat.normalized_key), cat);
        }
      }
    }

    // 3. Replace existing rules for this rule set with the workflow output.
    await supabaseAdmin
      .from("lease_expense_rules")
      .delete()
      .eq("rule_set_id", ruleSetId);

    const rulePayloads = expenseRules
      .map((rule: any) => {
        const key = normalizeCategoryKey(rule?.expense_category || rule?.category || rule?.key);
        const category = key ? categoryByKey.get(key) : null;
        if (!category?.id) return null;
        const recoveryMethod = String(rule?.recovery_method || "").toLowerCase();
        const status = mapRuleStatus(rule);
        return {
          rule_set_id: ruleSetId,
          expense_category_id: category.id,
          row_status: status,
          mentioned_in_lease: Boolean(rule?.mentioned_in_lease ?? status !== "not_mentioned"),
          is_recoverable: Boolean(rule?.recoverable_flag ?? rule?.recoverable_from_tenant ?? rule?.is_recoverable),
          is_excluded: Boolean(rule?.is_excluded || rule?.excluded_from_recovery),
          is_controllable: Boolean(rule?.is_controllable),
          is_subject_to_cap: Boolean(rule?.is_subject_to_cap || rule?.cap_type),
          cap_type: rule?.cap_type ?? null,
          cap_value: toNumberOrNull(rule?.cap_value ?? rule?.cap_amount),
          has_base_year: Boolean(rule?.has_base_year || rule?.base_year_type),
          base_year_type: rule?.base_year_type ?? null,
          gross_up_applicable: Boolean(rule?.gross_up_applicable),
          admin_fee_applicable: Boolean(rule?.admin_fee_applicable),
          admin_fee_percent: toNumberOrNull(rule?.admin_fee_percent),
          notes: rule?.notes ?? rule?.source_clause ?? null,
          confidence: toNumberOrNull(rule?.confidence ?? rule?.confidence_score),
          source: "lease_workflow",
        };
      })
      .filter(Boolean);

    if (rulePayloads.length > 0) {
      const { data: insertedRules, error: insertRulesErr } = await supabaseAdmin
        .from("lease_expense_rules")
        .insert(rulePayloads)
        .select("id, expense_category_id");
      if (insertRulesErr) {
        console.warn(`[review-approve] lease_expense_rules insert skipped: ${insertRulesErr.message}`);
        return;
      }

      // 4. Persist supporting clauses if present, keyed back to the rule row.
      const clausePayloads: any[] = [];
      for (let i = 0; i < expenseRules.length; i += 1) {
        const rule = expenseRules[i];
        const inserted = insertedRules?.[i];
        const text = rule?.source_clause ?? rule?.clause_text ?? rule?.notes;
        if (!inserted?.id || !text) continue;
        clausePayloads.push({
          lease_expense_rule_id: inserted.id,
          lease_id: leaseId,
          page_number: toNumberOrNull(rule?.source_page),
          clause_type: rule?.clause_type ?? "supporting_text",
          clause_text: String(text).slice(0, 4000),
          confidence: toNumberOrNull(rule?.confidence ?? rule?.confidence_score),
        });
      }
      if (clausePayloads.length > 0) {
        await supabaseAdmin
          .from("lease_expense_rule_clauses")
          .insert(clausePayloads)
          .then(() => {})
          .catch((err: any) => console.warn(`[review-approve] rule clauses skipped: ${err?.message ?? err}`));
      }
    }
  } catch (error: any) {
    console.warn(`[review-approve] expense rule sync skipped: ${error?.message ?? error}`);
  }
}

function normalizeCategoryKey(value: unknown): string | null {
  if (value == null) return null;
  const cleaned = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || null;
}

function mapRuleStatus(rule: any): string {
  if (!rule?.mentioned_in_lease) return "not_mentioned";
  if (rule?.status === "approved" || rule?.status === "confirmed") return "mapped";
  if (rule?.recoverable_flag === true || rule?.is_recoverable === true) return "mapped";
  return "needs_review";
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
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
    /extraction_data|confidence_score|low_confidence_fields|extracted_fields|lease_date|property_name|property_address|landlord_address|tenant_contact_name|tenant_address|suite_number|rentable_area_sqft|permitted_use|broker_name|lease_term|commencement_date|rent_commencement_date|expiration_date|renewal_notice_days|renewal_escalation_percent|holdover_rent_multiplier|base_rent_monthly|rent_due_day|rent_frequency|rent_payment_timing|late_fee_grace_days|late_fee_percent|default_interest_rate_formula|building_rsf|tenant_rsf|tenant_pro_rata_share|floor_plan_reference|parking_rights|common_area_description/i.test(message);
}

const LEASE_WORKFLOW_OPTIONAL_COLUMNS = [
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
 * Read every lease_field's confidence_score and emit a key→0-100 map.
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
