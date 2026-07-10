/**
 * leaseAbstractService — pre-approval lease review draft/reject handling and
 * the `lease_field_reviews` audit-trail mirror (a per-field row alongside
 * `leases.extraction_data.field_reviews`, gated off by
 * mirrorLeaseFieldReviewsFromBrowser today). Final abstract approval itself
 * is owned by approve_lease_workflow (see leaseApprovalWorkflowService.js),
 * not this file.
 */
import { supabase } from "@/services/supabaseClient";
import { saveLeaseReviewDraft, rejectLeaseAbstract as rejectLeaseAbstractViaRpc } from "@/services/leaseService";
import {
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
} from "@/lib/leaseReviewSchema";

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
 * Save the in-progress review state without approving. Server-owned,
 * audited (Phase 6D-3: save_lease_review_draft RPC / save-lease-review-draft
 * edge function) — replaces the prior direct supabase.from("leases").update()
 * call. Note: the RPC rejects this write once abstract_status='approved'
 * (a new guarantee — previously an approved lease's draft could still be
 * silently resaved here, keeping abstract_status='approved'; the FieldDetailDrawer's
 * Accept/Reject/reset controls have never been gated by abstract_status
 * client-side, so this tightens a real gap rather than preserving the old
 * silent-allow behavior).
 */
export async function saveAbstractDraft({ lease, fieldReviews, reviewer }) {
  if (!lease?.id) throw new Error("saveAbstractDraft: lease.id is required");
  const data = await saveLeaseReviewDraft({ leaseId: lease.id, fieldReviews });
  await persistFieldReviews({
    lease: { ...lease, extraction_data: data.extraction_data, abstract_status: data.abstract_status },
    fieldReviews,
    reviewer,
  }).catch((err) => {
    console.warn("[leaseAbstractService] persistFieldReviews skipped:", err?.message || err);
  });
  return data;
}

/**
 * Mark a lease abstract as rejected (document rejected) — used by the
 * "Reject Document" action in Lease Review. Server-owned, audited (Phase
 * 6D-5: reject_lease_abstract RPC / reject-lease-abstract edge function) --
 * replaces the prior direct supabase.from("leases").update() call. Note:
 * the RPC rejects this action once abstract_status='approved' (a new
 * guarantee -- the old client code had no such check at all).
 */
export async function rejectLeaseAbstract({ lease, reason, reviewer }) {
  if (!lease?.id) throw new Error("rejectLeaseAbstract: lease.id is required");
  return rejectLeaseAbstractViaRpc({ leaseId: lease.id, reason, rejectedBy: reviewer || null });
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
