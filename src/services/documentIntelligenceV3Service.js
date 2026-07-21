import { invokeEdgeFunction } from "@/services/edgeFunctions";

/**
 * Document Intelligence v3 Ã¢â‚¬â€ Readiness diagnostic fetch (Phase 4).
 *
 * Unlike invokeEdgeFunction itself (which throws on any failure),
 * this wrapper always resolves and never throws -- callers (currently only
 * ExtractionDebugPanel.jsx's on-demand "Load v3 Diagnostics" button) can
 * render a non-blocking inline error without needing their own try/catch
 * around every call site. This is a read-only diagnostic call: it performs
 * no writes and has no side effects on the current Lease Review flow.
 *
 * @param {Object} params
 * @param {string|null} [params.uploadedFileId] - required unless runId is given
 * @param {string|null} [params.runId] - optional; when omitted the endpoint
 *   resolves the latest completed Document Intelligence v3 run for uploadedFileId
 * @returns {Promise<{error: false, readiness: Object} | {error: true, message: string}>}
 */
export async function fetchDocumentIntelligenceV3Readiness({ uploadedFileId = null, runId = null } = {}) {
  if (!uploadedFileId && !runId) {
    return { error: true, message: "No uploaded_file_id or run_id available for this document." };
  }

  try {
    const data = await invokeEdgeFunction("document-intelligence-v3-readiness", {
      uploaded_file_id: uploadedFileId,
      run_id: runId,
    });
    return { error: false, readiness: data?.readiness ?? null };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to load Document Intelligence v3 diagnostics." };
  }
}
/**
 * Document Intelligence v3 - Advisory audit / current review comparison
 * fetch (Phase 14). Read-only diagnostic call used only by the admin
 * Extraction Debug panel.
 *
 * @param {Object} params
 * @param {string|null} [params.uploadedFileId]
 * @param {string|null} [params.runId]
 * @param {string|null} [params.leaseId]
 * @returns {Promise<{error: false, advisoryAudit: Object} | {error: true, message: string}>}
 */
export async function fetchDocumentIntelligenceV3AdvisoryAudit({
  uploadedFileId = null,
  runId = null,
  leaseId = null,
} = {}) {
  if (!uploadedFileId && !runId && !leaseId) {
    return { error: true, message: "No uploaded_file_id, run_id, or lease_id available for this document." };
  }

  try {
    const data = await invokeEdgeFunction("document-intelligence-v3-advisory-audit", {
      uploaded_file_id: uploadedFileId,
      run_id: runId,
      lease_id: leaseId,
      persist_snapshot: false,
    });
    return { error: false, advisoryAudit: data?.advisory_audit ?? null };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to load Document Intelligence v3 advisory audit." };
  }
}
/**
 * Document Intelligence v3 - Batch advisory audit report fetch (Phase 15).
 * Read-only diagnostic call used only by the admin Extraction Debug panel
 * and manual QA utilities.
 *
 * @param {Object} params
 * @param {string[]} [params.uploadedFileIds]
 * @param {string[]} [params.runIds]
 * @param {string[]} [params.leaseIds]
 * @param {number|null} [params.limit]
 * @returns {Promise<{error: false, batchAudit: Object} | {error: true, message: string}>}
 */
export async function fetchDocumentIntelligenceV3AdvisoryAuditBatch({
  uploadedFileIds = [],
  runIds = [],
  leaseIds = [],
  limit = null,
} = {}) {
  const hasInput = uploadedFileIds.length > 0 || runIds.length > 0 || leaseIds.length > 0;
  if (!hasInput) {
    return { error: false, batchAudit: null };
  }

  try {
    const data = await invokeEdgeFunction("document-intelligence-v3-advisory-audit-batch", {
      uploaded_file_ids: uploadedFileIds,
      run_ids: runIds,
      lease_ids: leaseIds,
      limit,
    });
    return { error: false, batchAudit: data?.batch_audit ?? null };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to load Document Intelligence v3 batch advisory audit." };
  }
}
/**
 * Document Intelligence v3 - Projection diff fetch (Release 2). Read-only
 * diagnostic call comparing the live ui_review_payload against a v3 run's
 * document_canonical_field_projections, per field, with type-aware
 * normalization. Used only by the admin Extraction Debug panel.
 *
 * @param {Object} params
 * @param {string|null} [params.uploadedFileId]
 * @param {string|null} [params.runId]
 * @returns {Promise<{error: false, projectionDiff: Object, diagnosticsContext: Object} | {error: true, message: string}>}
 */
export async function fetchDocumentIntelligenceV3ProjectionDiff({ uploadedFileId = null, runId = null } = {}) {
  if (!uploadedFileId && !runId) {
    return { error: true, message: "No uploaded_file_id or run_id available for this document." };
  }

  try {
    const data = await invokeEdgeFunction("document-intelligence-v3-projection-diff", {
      uploaded_file_id: uploadedFileId,
      run_id: runId,
    });
    return { error: false, projectionDiff: data?.projection_diff ?? null, diagnosticsContext: data?.diagnostics_context ?? null };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to load Document Intelligence v3 projection diff." };
  }
}
/**
 * Document Intelligence v3 - Run operational metrics fetch (Release 2).
 * Read-only diagnostic call: pages/blocks/claims/evidence/projection
 * counts, stage durations/failures, provider-aware table-write health, and
 * transport-wrapper readiness. Used only by the admin Extraction Debug panel.
 *
 * @param {Object} params
 * @param {string|null} [params.uploadedFileId]
 * @param {string|null} [params.runId]
 * @returns {Promise<{error: false, runMetrics: Object, diagnosticsContext: Object} | {error: true, message: string}>}
 */
export async function fetchDocumentIntelligenceV3RunMetrics({ uploadedFileId = null, runId = null } = {}) {
  if (!uploadedFileId && !runId) {
    return { error: true, message: "No uploaded_file_id or run_id available for this document." };
  }

  try {
    const data = await invokeEdgeFunction("document-intelligence-v3-run-metrics", {
      uploaded_file_id: uploadedFileId,
      run_id: runId,
    });
    return { error: false, runMetrics: data?.run_metrics ?? null, diagnosticsContext: data?.diagnostics_context ?? null };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to load Document Intelligence v3 run metrics." };
  }
}

/**
 * Document Intelligence v4 - Enterprise review payload fetch. This is the
 * canonical-review authority read model; it still returns legacy payload for
 * rollback and diagnostics when canonical authority is disabled.
 */
export async function fetchDocumentIntelligenceV4ReviewPayload({ uploadedFileId = null, runId = null, generationId = null } = {}) {
  if (!uploadedFileId && !runId) {
    return { error: true, message: "No uploaded_file_id or run_id available for this document." };
  }

  try {
    const data = await invokeEdgeFunction("document-intelligence-v4-review-payload", {
      uploaded_file_id: uploadedFileId,
      run_id: runId,
      generation_id: generationId,
    });
    return {
      error: false,
      mode: data?.mode ?? "legacy",
      sourceMode: data?.sourceMode ?? data?.source_mode ?? null,
      uiAuthority: data?.uiAuthority ?? data?.ui_authority ?? "legacy",
      enterpriseReviewPayload: data?.enterpriseReviewPayload ?? null,
      legacyReviewPayload: data?.legacyReviewPayload ?? null,
      authorityReadiness: data?.authorityReadiness ?? null,
      approvalReadiness: data?.approvalReadiness ?? null,
      diagnostics: data?.diagnostics ?? null,
    };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to load Document Intelligence v4 review payload." };
  }
}

/** Persist a Release 4 reviewer action without mutating the original projection. */
export async function submitDocumentFieldReviewAction({ uploadedFileId, runId, generationId = null, canonicalFieldKey, action, overrideValue = null, reason = null } = {}) {
  if (!uploadedFileId || !runId || !canonicalFieldKey || !action) {
    return { error: true, message: "uploadedFileId, runId, canonicalFieldKey, and action are required." };
  }

  try {
    const data = await invokeEdgeFunction("document-field-review-action", {
      uploadedFileId,
      runId,
      generationId,
      canonicalFieldKey,
      action,
      overrideValue,
      reason,
    });
    return { error: false, ...data };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to submit review action." };
  }
}
/** Document Intelligence v4 - Corpus readiness metrics for canonical hybrid rollout. */
export async function fetchDocumentIntelligenceV4ReadinessMetrics({ uploadedFileId = null, runId = null, since = null, limit = 200 } = {}) {
  try {
    const data = await invokeEdgeFunction("document-intelligence-v4-readiness-metrics", {
      uploaded_file_id: uploadedFileId,
      run_id: runId,
      since,
      limit,
    });
    return { error: false, readinessMetrics: data?.readinessMetrics ?? null, diagnostics: data?.diagnostics ?? null };
  } catch (err) {
    return { error: true, message: err?.message || "Failed to load Document Intelligence v4 readiness metrics." };
  }
}
