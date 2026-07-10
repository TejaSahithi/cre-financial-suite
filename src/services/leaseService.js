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

/**
 * Server-owned uploaded_files delete (Phase HARD-2). Replaces the direct
 * supabase.from("uploaded_files").delete() write with an audited,
 * org-boundary-checked RPC call via the delete-uploaded-file edge function.
 *
 * @param {string} fileId
 */
export async function deleteUploadedFile(fileId) {
  if (!fileId) throw new Error("File ID is required");
  const result = await invokeEdgeFunction("delete-uploaded-file", {
    file_id: fileId,
  });
  return result;
}

/**
 * Server-owned lease extraction_data field/source-link/lease-flag write
 * (Phase HARD-3B1 / 6D-2 / 6R-1). Replaces direct
 * supabase.from("leases").update() writes for the narrow set of areas the
 * update_lease_extraction_field RPC owns.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {'field_value'|'source_link'|'lease_flag'} params.fieldArea
 * @param {string} params.action
 * @param {string|null} [params.fieldKey] - required iff fieldArea==='field_value'
 * @param {Object} params.patch
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
