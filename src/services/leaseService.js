import { createEntityService } from '@/services/api';
import { invokeEdgeFunction } from '@/services/edgeFunctions';

const baseService = createEntityService('Lease');

export const leaseService = {
  ...baseService,
  // PRE-AZ-HOTFIX-1: lease cascade delete is now exclusively server-owned
  // via the delete-lease-cascade edge function, which validates org
  // ownership and calls delete_lease_cascade through the service-role
  // client. This replaces the former direct
  // supabase.rpc('delete_lease_cascade', ...) call (which the RPC's
  // now-revoked anon/authenticated grant had allowed) and its
  // deleteLeaseCascadeFallback direct-table-delete degraded path. There is
  // deliberately no client-side fallback left: if the edge function is
  // unavailable, deletion must fail loudly rather than silently falling
  // back to an authenticated-client cascade delete. The RPC writes its own
  // canonical audit_logs row (with the real actor identity now that the
  // edge function passes it through), so no separate client-side
  // logAudit() call is needed here.
  async delete(id) {
    if (!id) throw new Error("Lease ID is required for deletion");
    await invokeEdgeFunction("delete-lease-cascade", { lease_id: id });
    return true;
  }
};

// Server-owned, audited replacement for the single-field-path direct writes
// to leases.extraction_data (Phase 6D-2). See update_lease_extraction_field
// RPC / update-lease-extraction-field edge function. Not for whole-object
// rebuilds or the field_reviews map (those stay client-side for now).
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
  if (!leaseId) throw new Error("Lease ID is required");
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
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("link-lease-space-assignment", {
    lease_id: leaseId,
    building_id: buildingId,
    unit_id: unitId,
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

export async function deleteUploadedFile(fileId) {
  if (!fileId) throw new Error('File ID is required');
  return invokeEdgeFunction('delete-uploaded-file', {
    file_id: fileId,
  });
}
