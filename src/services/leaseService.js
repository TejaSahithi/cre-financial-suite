import { createEntityService } from '@/services/api';
import { supabase } from '@/services/supabaseClient';
import { resolveLeaseFields } from '@/lib/leaseFieldResolver';
import { NUMERIC_REVIEW_FIELDS, resolveFieldColumns } from '@/lib/leaseReviewSchema';
import { logAudit } from '@/services/audit';

const baseService = createEntityService('Lease');

const MISSING_SCHEMA_ERROR_CODES = new Set(["PGRST202", "PGRST204", "PGRST205", "42P01", "42703"]);

// Narrow, function-specific classifier: only "delete_lease_cascade is not
// deployed/callable" shapes are treated as an unavailable-workflow error.
// A bare "not found"/"does not exist" substring is NOT enough on its own —
// the RPC's own business errors ("Lease not found") also contain "not
// found" and must instead pass through unchanged (Phase 6R-10A: the prior,
// broader text match misclassified that exact case).
function isDeleteLeaseCascadeUnavailableError(error) {
  if (MISSING_SCHEMA_ERROR_CODES.has(String(error?.code || "").toUpperCase())) {
    return true;
  }
  const text = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  if (text.includes("schema cache")) return true;
  if (text.includes("could not find the function")) return true;
  if (text.includes("delete_lease_cascade") && text.includes("does not exist")) return true;
  return false;
}

const LEASE_DELETE_UNAVAILABLE_MESSAGE =
  "Lease deletion is temporarily unavailable because the server-side delete workflow is not deployed. Please contact support or retry after migrations are applied.";

export const leaseService = {
  ...baseService,
  async delete(id) {
    if (!id) throw new Error("Lease ID is required for deletion");
    if (supabase) {
      const { data: { user } = {} } = await supabase.auth.getUser().catch(() => ({ data: {} }));

      // delete_lease_cascade owns the entire cascade (detach + delete
      // children + delete lease + audit) in one transaction. There is no
      // client-side fallback: a non-atomic, per-table cascade driven by the
      // caller's own RLS session was a real correctness risk (partial
      // deletes on failure, silent no-ops on tables with no DELETE policy,
      // and a growing list of tables it had to be kept in sync with by
      // hand) — see Phase 6R-9's investigation. If the RPC is genuinely
      // unavailable (schema-cache-miss -- an incompletely migrated
      // environment), fail clearly instead of attempting that cascade.
      const { error } = await supabase.rpc('delete_lease_cascade', {
        target_lease_id: id,
        p_actor_user_id: user?.id || null,
        p_actor_email: user?.email || null,
      });
      if (!error) {
        return true;
      }
      if (isDeleteLeaseCascadeUnavailableError(error)) {
        console.error(`[leaseService] delete_lease_cascade RPC not available for lease ${id}:`, error);
        throw new Error(LEASE_DELETE_UNAVAILABLE_MESSAGE);
      }
      console.error(`[leaseService] Cascade delete failed for lease ${id}:`, error);
      throw error;
    }

    return baseService.delete(id);
  }
};

// Server-owned, audited replacement for the single-field-path direct writes
// to leases.extraction_data (Phase 6D-2). See update_lease_extraction_field
// RPC / update-lease-extraction-field edge function. Not for whole-object
// rebuilds or the field_reviews map (those stay client-side for now).
export async function updateLeaseExtractionField({ leaseId, fieldArea, action, fieldKey = null, patch }) {
  return invokeEdgeFunction("update-lease-extraction-field", {
    lease_id: leaseId,
    field_area: fieldArea,
    action,
    field_key: fieldKey,
    patch,
  });
}

// Server-owned, audited replacement for the whole-field_reviews-map draft
// save (Phase 6D-3). See save_lease_review_draft RPC / save-lease-review-draft
// edge function. Called by leaseAbstractService.js's saveAbstractDraft, which
// still computes the next fieldReviews map client-side (unchanged) and only
// delegates the mechanical persistence step here.
export async function saveLeaseReviewDraft({ leaseId, fieldReviews }) {
  return invokeEdgeFunction("save-lease-review-draft", {
    lease_id: leaseId,
    field_reviews: fieldReviews,
  });
}

// Server-owned, audited replacement for the "Reject Document" action
// (Phase 6D-5). See reject_lease_abstract RPC / reject-lease-abstract edge
// function. Called by leaseAbstractService.js's rejectLeaseAbstract.
export async function rejectLeaseAbstract({ leaseId, reason, rejectedBy = null }) {
  return invokeEdgeFunction("reject-lease-abstract", {
    lease_id: leaseId,
    reason,
    rejected_by: rejectedBy,
  });
}

// Server-owned, audited replacement for the "Send Back" (for re-extraction)
// action (Phase 6R-1). See send_lease_back_for_reextraction RPC /
// send-lease-back-for-reextraction edge function. Called by
// LeaseReview.jsx's handleSendBack.
export async function sendLeaseBackForReextraction({ leaseId, reason = null }) {
  return invokeEdgeFunction("send-lease-back-for-reextraction", {
    lease_id: leaseId,
    reason,
  });
}

// Server-owned, audited replacement for the post-approval building/unit
// auto-link direct write (Phase 6R-13). See link_lease_space_assignment RPC
// / link-lease-space-assignment edge function. The building/unit MATCH
// itself (text-matching against candidate rows) stays entirely client-side,
// unchanged -- see buildingUnitMatcher.js's matchBuildingAndUnit(). This
// wrapper only persists whichever of building_id/unit_id was resolved. Not
// folded into update_lease_extraction_field: that RPC rejects any write
// once abstract_status='approved', and this always runs immediately after
// approval succeeds.
export async function linkLeaseSpaceAssignment({ leaseId, buildingId = null, unitId = null }) {
  return invokeEdgeFunction("link-lease-space-assignment", {
    lease_id: leaseId,
    building_id: buildingId,
    unit_id: unitId,
  });
}

/**
 * Backfills missing top-level summary columns on the `leases` table using the 
 * generic lease field resolver to read from extraction_data, snapshot_json, etc.
 * 
 * @param {Object} options
 * @param {boolean} options.dryRun - If true, only reports what would change.
 * @param {boolean} options.force - If true, overwrites existing non-null fields.
 * @param {boolean} options.approvedOnly - If true, only processes approved leases.
 */
export async function updateLeaseExtractionField({ leaseId, fieldArea, action, fieldKey = null, patch }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("update-lease-extraction-field", {
    lease_id: leaseId,
    field_area: fieldArea,
    action,
    field_key: fieldKey,
    patch,
  });
}

/**
 * Server-owned lease review draft save (Phase HARD-3B1 / 6D-3). Replaces
 * leaseAbstractService.js's direct extraction_data.field_reviews write.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {Object} params.fieldReviews
 */
export async function saveLeaseReviewDraftWorkflow({ leaseId, fieldReviews }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("save-lease-review-draft", {
    lease_id: leaseId,
    field_reviews: fieldReviews,
  });
}

/**
 * Server-owned lease abstract rejection (Phase HARD-3B1 / 6D-5). Replaces
 * leaseAbstractService.js's direct status/abstract_status/rejection write.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string} params.reason
 * @param {string|null} [params.rejectedBy]
 */
export async function rejectLeaseAbstractWorkflow({ leaseId, reason, rejectedBy = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("reject-lease-abstract", {
    lease_id: leaseId,
    reason,
    rejected_by: rejectedBy,
  });
}

/**
 * Server-owned "send back for re-extraction" verdict (Phase HARD-3B1 /
 * 6R-1). Replaces LeaseReview.jsx's direct status='draft' +
 * extraction_data.send_back write.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string|null} [params.reason]
 */
export async function sendLeaseBackForReextraction({ leaseId, reason = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("send-lease-back-for-reextraction", {
    lease_id: leaseId,
    reason,
  });
}

/**
 * Server-owned typed-column + extraction_data.fields[key] field save
 * (Phase HARD-3B2). Replaces LeaseReview.jsx's handleFieldSave /
 * FieldDetailDrawer.onSaveEdit direct writes. Server-side whitelists which
 * columnUpdates keys are real, currently-existing lease columns and
 * silently drops the rest.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string} params.fieldKey
 * @param {Object} [params.columnUpdates] - {column_name: value}
 * @param {Object} [params.patch] - {field, field_evidence, confidence_score}
 */
export async function updateLeaseFieldAndColumns({ leaseId, fieldKey, columnUpdates = {}, patch = {} }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("update-lease-field-and-columns", {
    lease_id: leaseId,
    field_key: fieldKey,
    column_updates: columnUpdates,
    patch,
  });
}

/**
 * Server-owned evidence-backfill bulk merge (Phase HARD-3B2). Replaces
 * LeaseReview.jsx's evidence-backfill useEffect direct write. All
 * evidence-matching computation stays client-side; this only persists the
 * already-computed patch transactionally with one audit row.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {Object} [params.fieldsPatch]
 * @param {Object} [params.fieldEvidencePatch]
 * @param {Object|null} [params.workflowOutput]
 */
export async function backfillLeaseEvidence({ leaseId, fieldsPatch = {}, fieldEvidencePatch = {}, workflowOutput = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("backfill-lease-evidence", {
    lease_id: leaseId,
    fields_patch: fieldsPatch,
    field_evidence_patch: fieldEvidencePatch,
    workflow_output: workflowOutput,
  });
}

/**
 * Server-owned post-approval building/unit link (Phase HARD-3B2, reuses
 * the already-deployed link_lease_space_assignment RPC from Phase 6R-13).
 * Replaces LeaseReview.jsx's post-approval building/unit auto-link direct
 * write. Client-side text matching (matchBuildingAndUnit) stays unchanged;
 * this only persists the resolved building_id/unit_id.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string|null} [params.buildingId]
 * @param {string|null} [params.unitId]
 */
export async function linkLeaseSpaceAssignment({ leaseId, buildingId = null, unitId = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("link-lease-space-assignment", {
    lease_id: leaseId,
    building_id: buildingId,
    unit_id: unitId,
  });
}

/**
 * Server-owned lease extraction-data merge persistence (Phase HARD-3B3A).
 * Replaces the remaining direct leases UPDATE writes in
 * LeaseReview.jsx's handleReextractLease (manual-review fallback + success/
 * blocked merge) and ExtractionDebugPanel.jsx's handleApplyLatestExtraction.
 * All field-matching/protection/merge computation stays entirely
 * client-side, unchanged -- this only persists the already-computed patch
 * (a subset of fields/field_evidence/confidence_scores/workflow_output/
 * evidence_refreshed_at/extraction_debug/last_reextract_blocked_at)
 * transactionally with one audit row.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {'lease_extraction_manual_review_recorded'|'lease_extraction_merged'|'lease_extraction_merge_blocked'|'lease_extraction_debug_applied'} params.action
 * @param {Object} params.patch
 */
export async function persistLeaseExtractionMerge({ leaseId, action, patch }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("persist-lease-extraction-merge", {
    lease_id: leaseId,
    action,
    patch,
  });
}
