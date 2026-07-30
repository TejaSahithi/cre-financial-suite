/**
 * leaseAbstractService — pre-approval lease review draft/reject handling and
 * the `lease_field_reviews` audit-trail mirror (a per-field row alongside
 * `leases.extraction_data.field_reviews`, gated off by
 * mirrorLeaseFieldReviewsFromBrowser today). Final abstract approval itself
 * is owned by approve_lease_workflow (see leaseApprovalWorkflowService.js),
 * not this file.
 */
import { supabase } from "@/services/supabaseClient";
import {
  rejectLeaseAbstractWorkflow,
  saveLeaseReviewDraftWorkflow,
} from "@/services/leaseService";
import { resolveLeaseFields } from "@/lib/leaseFieldResolver";
import {
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
  resolveFieldColumns,
  LEASE_REVIEW_FIELDS,
  NUMERIC_REVIEW_FIELDS,
} from "@/lib/leaseReviewSchema";

const mirrorLeaseFieldReviewsFromBrowser = false;
const ABSTRACT_STATUS = {
  APPROVED: "approved",
  PENDING_REVIEW: "pending_review",
  REJECTED: "rejected",
};

function extractMissingColumn(error) {
  const message = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ");
  if (!message) return null;

  let match = message.match(/Could not find the '([^']+)' column/i);
  if (match?.[1]) return match[1];

  match = message.match(/column\s+["']?([a-zA-Z0-9_.]+)["']?/i);
  if (match?.[1]) return String(match[1]).split(".").pop();

  return null;
}

function isMissingColumnError(error) {
  return error?.code === "PGRST204" || error?.code === "42703" || !!extractMissingColumn(error);
}

async function updateLeaseStripMissing(leaseId, update) {
  let payload = { ...update };
  const stripped = new Set();

  while (true) {
    const { data, error } = await supabase
      .from("leases")
      .update(payload)
      .eq("id", leaseId)
      .select()
      .single();

    if (!error) return data;
    const missingColumn = isMissingColumnError(error) ? extractMissingColumn(error) : null;
    if (!missingColumn || stripped.has(missingColumn) || !(missingColumn in payload)) {
      throw error;
    }

    stripped.add(missingColumn);
    const { [missingColumn]: _omitted, ...nextPayload } = payload;
    payload = nextPayload;
  }
}


function toText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Upsert one row into lease_field_reviews per field key in `fieldReviews`.
 * Returns the inserted/updated rows.
 */
export async function persistFieldReviews({ lease, fieldReviews, reviewer }) {
  if (!lease?.id || !lease?.org_id) return [];
  if (!mirrorLeaseFieldReviewsFromBrowser) return [];
  const rows = Object.entries(fieldReviews || {}).map(([fieldKey, review]) => {
    const { rawValue, sourcePage, sourceText } = readFieldEvidence(lease, fieldKey);
    const value = review?.value !== undefined ? review.value : readFieldValue(lease, fieldKey);
    const confidence = readFieldConfidence(lease, fieldKey);
    return {
      org_id: lease.org_id,
      lease_id: lease.id,
      field_key: fieldKey,
      status: review?.status || "pending",
      normalized_value: toText(value),
      raw_value: toText(rawValue),
      source_page: typeof sourcePage === "number" ? sourcePage : null,
      source_text: toText(sourceText),
      confidence: typeof confidence === "number" ? confidence : null,
      note: review?.note || null,
      reviewer: review?.reviewer || reviewer || null,
      reviewed_at: review?.reviewed_at || new Date().toISOString(),
    };
  });
  if (rows.length === 0) return [];
  const { data, error } = await supabase
    .from("lease_field_reviews")
    .upsert(rows, { onConflict: "lease_id,field_key" })
    .select();
  if (error) {
    // Table not present yet (older schema) — don't block callers.
    if (error.code === "PGRST205" || error.code === "42P01") {
      console.warn("[leaseAbstractService] lease_field_reviews table missing; skipping audit upsert.");
      return [];
    }
    if (error.code === "42501" || /row-level security|permission denied/i.test([error.message, error.details, error.hint].filter(Boolean).join(" "))) {
      console.warn("[leaseAbstractService] lease_field_reviews mirror blocked by RLS; using leases.extraction_data.field_reviews only.");
      return [];
    }
    throw error;
  }
  return data || [];
}

/**
 * Build an immutable abstract snapshot from the current lease + review state.
 * This is what gets frozen on the lease.abstract_snapshot column each time the
 * abstract is approved (one snapshot per version).
 */
export function buildAbstractSnapshot({ lease, fieldReviews, version, approver }) {
  const approved = {};
  const pending_fields = {};
  const rejected_fields = {};
  const unmapped_terms = {};
  const allFields = {};

  const allKeys = new Set([
    ...LEASE_REVIEW_FIELDS.map(f => f.key),
    ...Object.keys(fieldReviews || {}),
    ...Object.keys(lease?.extraction_data?.fields || {}),
    ...Object.keys(lease?.extraction_data?.workflow_output?.lease_fields || {}),
    ...Object.keys(lease?.extracted_fields || {})
  ]);

  const knownKeys = new Set(LEASE_REVIEW_FIELDS.map(f => f.key));

  for (const key of allKeys) {
    const value = readFieldValue(lease, key);
    const { rawValue, sourcePage, sourceText, extractionStatus } = readFieldEvidence(lease, key);
    const confidence = readFieldConfidence(lease, key);
    const review = fieldReviews?.[key] || null;
    const review_status = review?.status || "pending";
    const fieldDef = LEASE_REVIEW_FIELDS.find(f => f.key === key);

    const entry = {
      value: value ?? null,
      raw_value: rawValue ?? null,
      source_page: sourcePage ?? null,
      source_text: sourceText ?? null,
      exact_source_text: sourceText ?? null,
      confidence_score: typeof confidence === "number" ? confidence : null,
      confidence: typeof confidence === "number" ? confidence : null,
      extraction_status: extractionStatus ?? null,
      review_status: review_status,
      reviewed_at: review?.reviewed_at || null,
      reviewer: review?.reviewer || null,
      section_key: fieldDef?.tab || null,
      field_key: key,
    };

    allFields[key] = entry;

    if (["accepted", "edited", "approved", "reviewed"].includes(review_status)) {
      approved[key] = entry;
    } else if (review_status === "rejected") {
      rejected_fields[key] = entry;
    } else {
      if (knownKeys.has(key)) {
        pending_fields[key] = entry;
      } else {
        unmapped_terms[key] = entry;
      }
    }
  }

  return {
    version,
    approved_at: new Date().toISOString(),
    approved_by: approver || null,
    fields: allFields,
    approved,
    pending_fields,
    rejected_fields,
    unmapped_terms,
  };
}

/**
 * Mark a lease abstract as approved. Writes to the new abstract_* columns AND
 * keeps `leases.status='approved'` + `extraction_data.abstract` in sync so
 * downstream code that hasn't migrated yet keeps working.
 *
 * Returns the updated lease row.
 */
export async function approveLeaseAbstract({
  lease,
  fieldReviews,
  approvedBy,
  signedAt,
  comments,
  documentUrl,
}) {
  if (!lease?.id) throw new Error("approveLeaseAbstract: lease.id is required");
  const nextVersion = (lease.abstract_version || 0) + 1;
  const snapshot = buildAbstractSnapshot({
    lease,
    fieldReviews,
    version: nextVersion,
    approver: approvedBy,
  });
  const nextExtraction = {
    ...(lease.extraction_data || {}),
    field_reviews: fieldReviews,
    abstract: {
      approved_at: snapshot.approved_at,
      approved_by: approvedBy,
      version: nextVersion,
    },
  };

  // Use canonical mode to grab the best available values for top-level columns
  const summaryKeys = [
    "tenant_name", "landlord_name", "lease_type", "commencement_date", 
    "expiration_date", "monthly_rent", "annual_rent", "square_footage", 
    "total_sf", "property_name"
  ];
  
  const resolvedFields = resolveLeaseFields(lease, summaryKeys, { mode: "canonical" });
  const columnSync = {};

  for (const key of summaryKeys) {
    const resolved = resolvedFields[key];
    if (!resolved || !resolved.found || resolved.value == null) continue;
    
    // Convert to numbers for numeric fields
    let value = resolved.value;
    if (NUMERIC_REVIEW_FIELDS.has(key)) {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
      if (!Number.isFinite(n)) continue;
      value = n;
    } else if (typeof value === "string") {
      value = value.trim();
      if (!value) continue;
    }

    const columns = resolveFieldColumns(key);
    for (const column of columns) {
      if (columnSync[column] === undefined) {
         // Do not overwrite existing values unless they are null/empty.
         // (User requested onlyFillMissing = true, approvedOnly = true, force = false logic here)
         if (lease[column] == null || lease[column] === "") {
           columnSync[column] = value;
         }
      }
    }
  }

  const update = {
    ...columnSync,
    status: "approved",
    signed_by: approvedBy,
    signed_at: signedAt || snapshot.approved_at,
    approval_comments: comments || null,
    approval_document_url: documentUrl || null,
    abstract_status: ABSTRACT_STATUS.APPROVED,
    abstract_version: nextVersion,
    abstract_approved_at: snapshot.approved_at,
    abstract_approved_by: approvedBy,
    abstract_snapshot: snapshot,
    extraction_data: nextExtraction,
    extracted_fields: snapshot.fields,
  };

  const data = await updateLeaseStripMissing(lease.id, update);

  // Update uploaded_files.reviewed_output if source_file_id exists
  if (lease.source_file_id) {
    try {
      await supabase
        .from("uploaded_files")
        .update({ reviewed_output: snapshot })
        .eq("id", lease.source_file_id);
    } catch (err) {
      console.warn("[leaseAbstractService] failed to update uploaded_files.reviewed_output:", err);
    }
  }

  // Persist per-field reviews so the audit trail is queryable. If the
  // dedicated table doesn't exist yet (older schema), don't block approval.
  await persistFieldReviews({
    lease: { ...lease, ...data },
    fieldReviews,
    reviewer: approvedBy,
  }).catch((err) => {
    console.warn("[leaseAbstractService] persistFieldReviews skipped:", err?.message || err);
  });

  // Expense rules are persisted from the primary LLM workflow payload
  // (`workflow_output.expense_rules`) by leaseExpenseRuleService. Do not
  // derive/write lease_expense_rules from already-normalized abstract fields
  // here; that legacy fallback creates duplicate paths and can be blocked by
  // the protected rule-table RLS policies.

  return data;
}

/**
 * Save the in-progress review state without approving. Updates the JSONB
 * (Phase 2 shape) and upserts lease_field_reviews so the audit table mirrors
 * the draft.
 */
export async function saveAbstractDraft({ lease, fieldReviews, reviewer, action }) {
  if (!lease?.id) throw new Error("saveAbstractDraft: lease.id is required");
  const data = await saveLeaseReviewDraftWorkflow({ leaseId: lease.id, fieldReviews, ...(action ? { action } : {}) });
  const merged = {
    ...lease,
    ...(data || {}),
    id: data?.id || data?.lease_id || lease.id,
    property_id: data?.property_id || lease.property_id || null,
    org_id: data?.org_id || lease.org_id || null,
    extraction_data: data?.extraction_data || {
      ...(lease.extraction_data || {}),
      field_reviews: fieldReviews,
    },
  };
  await persistFieldReviews({ lease: merged, fieldReviews, reviewer }).catch((err) => {
    console.warn("[leaseAbstractService] persistFieldReviews skipped:", err?.message || err);
  });
  return merged;
}

/**
 * Mark a lease abstract as rejected (document rejected) — used by the
 * "Reject Document" action in Lease Review.
 */
export async function rejectLeaseAbstract({ lease, reason, reviewer }) {
  if (!lease?.id) throw new Error("rejectLeaseAbstract: lease.id is required");
  const data = await rejectLeaseAbstractWorkflow({
    leaseId: lease.id,
    reason,
    rejectedBy: reviewer || null,
  });
  return {
    ...lease,
    ...(data || {}),
    id: data?.id || data?.lease_id || lease.id,
    property_id: data?.property_id || lease.property_id || null,
    org_id: data?.org_id || lease.org_id || null,
    status: data?.status || "rejected",
    abstract_status: data?.abstract_status || ABSTRACT_STATUS.REJECTED,
    extraction_data: data?.extraction_data || {
      ...(lease.extraction_data || {}),
      rejection: {
        reason,
        rejected_at: new Date().toISOString(),
        rejected_by: reviewer || null,
      },
    },
  };
}

/**
 * Convenience: load the current per-field review rows for a lease, keyed by
 * field_key. Used by pages that need the audit trail (e.g. Lease Detail).
 */
export async function loadFieldReviewMap(leaseId) {
  if (!leaseId) return {};
  const { data, error } = await supabase
    .from("lease_field_reviews")
    .select("field_key, status, normalized_value, raw_value, source_page, source_text, confidence, note, reviewer, reviewed_at")
    .eq("lease_id", leaseId);
  if (error) {
    console.warn("[leaseAbstractService] loadFieldReviewMap failed:", error.message);
    return {};
  }
  const map = {};
  for (const row of data || []) {
    map[row.field_key] = row;
  }
  return map;
}
