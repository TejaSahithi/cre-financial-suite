/**
 * leaseAbstractService — writes the approved-lease-abstract data model
 * introduced in migration 20260514120000_approved_lease_abstract.sql.
 *
 * The Phase 2 review workspace persists field reviews into
 * `leases.extraction_data.field_reviews` (additive JSONB). This service
 * promotes those reviews into:
 *   - `lease_field_reviews` rows (one per field, SQL-indexable)
 *   - dedicated columns on `leases` (abstract_status, abstract_version,
 *     abstract_approved_at, abstract_approved_by, abstract_snapshot)
 *
 * Both the JSONB and the new columns are written so old code that still
 * reads `extraction_data` keeps working during the transition.
 */
import { supabase } from "@/services/supabaseClient";
import {
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
  LEASE_REVIEW_FIELDS,
} from "@/lib/leaseReviewSchema";

export const ABSTRACT_STATUS = {
  DRAFT: "draft",
  PENDING_REVIEW: "pending_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
};

function isMissingAbstractColumnError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    error?.code === "PGRST204" &&
    (
      message.includes("abstract_status") ||
      message.includes("abstract_version") ||
      message.includes("abstract_snapshot") ||
      message.includes("abstract_approved_at") ||
      message.includes("abstract_approved_by")
    )
  );
}

function withLegacyAbstractFallback(update, extractionData) {
  return {
    ...update,
    extraction_data: extractionData,
  };
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
  if (error) throw error;
  return data || [];
}

/**
 * Build an immutable abstract snapshot from the current lease + review state.
 * This is what gets frozen on the lease.abstract_snapshot column each time the
 * abstract is approved (one snapshot per version).
 */
export function buildAbstractSnapshot({ lease, fieldReviews, version, approver }) {
  const fields = {};
  for (const field of LEASE_REVIEW_FIELDS) {
    const value = readFieldValue(lease, field.key);
    const { rawValue, sourcePage, sourceText } = readFieldEvidence(lease, field.key);
    const confidence = readFieldConfidence(lease, field.key);
    const review = fieldReviews?.[field.key] || null;
    fields[field.key] = {
      value: value ?? null,
      raw_value: rawValue ?? null,
      source_page: sourcePage ?? null,
      source_text: sourceText ?? null,
      confidence: typeof confidence === "number" ? confidence : null,
      review_status: review?.status || "pending",
      reviewed_at: review?.reviewed_at || null,
      reviewer: review?.reviewer || null,
    };
  }
  return {
    version,
    approved_at: new Date().toISOString(),
    approved_by: approver || null,
    fields,
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

  const update = {
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
  };

  const { data, error } = await supabase
    .from("leases")
    .update(update)
    .eq("id", lease.id)
    .select()
    .single();
  if (error) {
    if (!isMissingAbstractColumnError(error)) throw error;
    const legacyUpdate = withLegacyAbstractFallback(
      {
        status: "approved",
        signed_by: approvedBy,
        signed_at: signedAt || snapshot.approved_at,
        approval_comments: comments || null,
        approval_document_url: documentUrl || null,
      },
      nextExtraction,
    );
    const { data: legacyData, error: legacyError } = await supabase
      .from("leases")
      .update(legacyUpdate)
      .eq("id", lease.id)
      .select()
      .single();
    if (legacyError) throw legacyError;
    await persistFieldReviews({
      lease: { ...lease, ...legacyData },
      fieldReviews,
      reviewer: approvedBy,
    }).catch(() => {});
    return legacyData;
  }

  // Persist per-field reviews so the audit trail is queryable.
  await persistFieldReviews({
    lease: { ...lease, ...data },
    fieldReviews,
    reviewer: approvedBy,
  });

  return data;
}

/**
 * Save the in-progress review state without approving. Updates the JSONB
 * (Phase 2 shape) and upserts lease_field_reviews so the audit table mirrors
 * the draft.
 */
export async function saveAbstractDraft({ lease, fieldReviews, reviewer }) {
  if (!lease?.id) throw new Error("saveAbstractDraft: lease.id is required");
  const nextExtraction = {
    ...(lease.extraction_data || {}),
    field_reviews: fieldReviews,
  };
  const update = {
    extraction_data: nextExtraction,
    abstract_status: lease.abstract_status === ABSTRACT_STATUS.APPROVED
      ? ABSTRACT_STATUS.APPROVED  // Keep approved status; new edits create the next version on approval.
      : ABSTRACT_STATUS.PENDING_REVIEW,
  };
  const { data, error } = await supabase
    .from("leases")
    .update(update)
    .eq("id", lease.id)
    .select()
    .single();
  if (error) {
    if (!isMissingAbstractColumnError(error)) throw error;
    const { data: legacyData, error: legacyError } = await supabase
      .from("leases")
      .update({ extraction_data: nextExtraction })
      .eq("id", lease.id)
      .select()
      .single();
    if (legacyError) throw legacyError;
    await persistFieldReviews({ lease: { ...lease, ...legacyData }, fieldReviews, reviewer }).catch(() => {});
    return legacyData;
  }
  await persistFieldReviews({ lease: { ...lease, ...data }, fieldReviews, reviewer }).catch(() => {});
  return data;
}

/**
 * Mark a lease abstract as rejected (document rejected) — used by the
 * "Reject Document" action in Lease Review.
 */
export async function rejectLeaseAbstract({ lease, reason, reviewer }) {
  const nextExtraction = {
    ...(lease.extraction_data || {}),
    rejection: {
      reason,
      rejected_at: new Date().toISOString(),
      rejected_by: reviewer || null,
    },
  };
  const { data, error } = await supabase
    .from("leases")
    .update({
      status: "rejected",
      abstract_status: ABSTRACT_STATUS.REJECTED,
      extraction_data: nextExtraction,
    })
    .eq("id", lease.id)
    .select()
    .single();
  if (error) {
    if (!isMissingAbstractColumnError(error)) throw error;
    const { data: legacyData, error: legacyError } = await supabase
      .from("leases")
      .update({
        status: "rejected",
        extraction_data: nextExtraction,
      })
      .eq("id", lease.id)
      .select()
      .single();
    if (legacyError) throw legacyError;
    return legacyData;
  }
  return data;
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
