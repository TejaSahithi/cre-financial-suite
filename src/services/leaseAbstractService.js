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
import { saveLeaseReviewDraftWorkflow, rejectLeaseAbstractWorkflow } from "@/services/leaseService";
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

const autoApproveAcceptedExpenseRules = false;
const mirrorLeaseFieldReviewsFromBrowser = false;

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
 * Save the in-progress review state without approving. Routes through the
 * server-owned save_lease_review_draft RPC (Phase HARD-3B1 / 6D-3) instead
 * of writing extraction_data.field_reviews directly. Note: the RPC
 * unconditionally rejects this write once abstract_status==='approved'
 * (409) — an intentional guarantee introduced by that RPC, not a behavior
 * this wrapper adds. Callers already surface errors via toast + local
 * state revert, so a rejected draft save fails loudly rather than silently
 * no-opping the way the old direct write did.
 */
export async function saveAbstractDraft({ lease, fieldReviews, reviewer }) {
  if (!lease?.id) throw new Error("saveAbstractDraft: lease.id is required");
  const result = await saveLeaseReviewDraftWorkflow({ leaseId: lease.id, fieldReviews });
  const data = {
    id: lease.id,
    property_id: result?.property_id ?? lease.property_id ?? null,
    extraction_data: result?.extraction_data,
    abstract_status: result?.abstract_status,
    updated_at: result?.updated_at,
  };
  await persistFieldReviews({ lease: { ...lease, ...data }, fieldReviews, reviewer }).catch((err) => {
    console.warn("[leaseAbstractService] persistFieldReviews skipped:", err?.message || err);
  });
  return data;
}

/**
 * Mark a lease abstract as rejected (document rejected) — used by the
 * "Reject Document" action in Lease Review. Routes through the server-owned
 * reject_lease_abstract RPC (Phase HARD-3B1 / 6D-5).
 */
export async function rejectLeaseAbstract({ lease, reason, reviewer }) {
  if (!lease?.id) throw new Error("rejectLeaseAbstract: lease.id is required");
  const result = await rejectLeaseAbstractWorkflow({ leaseId: lease.id, reason, rejectedBy: reviewer || null });
  return {
    id: lease.id,
    property_id: result?.property_id ?? lease.property_id ?? null,
    status: result?.status,
    abstract_status: result?.abstract_status,
    extraction_data: result?.extraction_data,
    updated_at: result?.updated_at,
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
