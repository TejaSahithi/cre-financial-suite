/**
 * Document Intelligence v3 â€” Diagnostics display helpers (Phase 4).
 *
 * Pure functions only (no React, no fetch) so they can be unit-tested
 * directly in this repo's Node-environment Vitest setup, which cannot
 * mount React components. ExtractionDebugPanel.jsx is the sole consumer.
 */

const NOT_AVAILABLE_MESSAGE = "No v3 diagnostic run is available for this upload yet.";

const EVIDENCE_SUFFICIENCY_LABELS = {
  fields_with_no_evidence: "No evidence",
  fields_with_text_only_evidence: "Text only",
  fields_with_block_anchored_evidence: "Block anchored",
  fields_with_visual_anchored_evidence: "Visual anchored",
  fields_with_calculated_evidence: "Calculated",
  fields_with_cross_reference_evidence: "Cross reference",
  fields_with_insufficient_evidence: "Insufficient",
};

/**
 * Defensively resolves the uploaded_files id to send to the
 * document-intelligence-v3-readiness endpoint, trying every path this
 * codebase is known to store a source-file link under (mirroring the
 * dual singular/plural uploaded_files/uploaded_file convention used by
 * leaseFieldResolver.js and the same source_file_id fallback
 * ExtractionDebugPanel.jsx already uses for its other actions).
 *
 * @param {Object|null} lease
 * @param {Object|null} uploadedFile - the already-fetched debug uploaded_files row, if any
 * @returns {string|null}
 */
export function resolveUploadedFileIdForV3Diagnostics(lease, uploadedFile) {
  const candidates = [
    lease?.source_file_id,
    lease?.extraction_data?.source_file_id,
    lease?.extraction_data?.uploaded_file_id,
    uploadedFile?.id,
    lease?.uploaded_files?.id,
    lease?.uploaded_file?.id,
    Array.isArray(lease?.uploaded_files) ? lease.uploaded_files[0]?.id : null,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim()) return String(candidate).trim();
  }
  return null;
}

function emptyCounts() {
  return {
    claimCounts: { total: 0, canonical_field: 0, dynamic: 0 },
    evidenceCounts: { total: 0 },
    validationDropCounts: { total: 0, by_reason: {} },
    sourceBackedCounts: {
      required_total: 0,
      required_source_backed: 0,
      required_missing: 0,
      required_needs_review: 0,
    },
    evidenceSufficiencyCounts: emptyEvidenceSufficiencyCounts(),
  };
}

function emptyEvidenceSufficiencyCounts() {
  return {
    fields_with_no_evidence: 0,
    fields_with_text_only_evidence: 0,
    fields_with_block_anchored_evidence: 0,
    fields_with_visual_anchored_evidence: 0,
    fields_with_calculated_evidence: 0,
    fields_with_cross_reference_evidence: 0,
    fields_with_insufficient_evidence: 0,
  };
}

export function summarizeEvidenceSufficiencyCounts(counts) {
  const resolved = { ...emptyEvidenceSufficiencyCounts(), ...(counts || {}) };
  return Object.entries(EVIDENCE_SUFFICIENCY_LABELS).map(([key, label]) => ({
    key,
    label,
    count: resolved[key] ?? 0,
  }));
}
function summarizeFieldList(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return {
    total: list.length,
    sourceBacked: list.filter((f) => f?.status === "source_backed").length,
    missing: list.filter((f) => f?.status === "missing").length,
    needsReview: list.filter((f) => f?.status === "needs_review").length,
    fields: list,
  };
}

/**
 * Normalizes the Phase 5 canonical-layout audit summary (readiness.layout_summary,
 * if the side-write computed one) into the compact shape the Extraction
 * Debug panel's "Canonical Layout Summary" subsection renders. Never
 * fetches anything new -- only shapes data already present on the readiness
 * response (Phase 5 Task F).
 *
 * @param {Object|null|undefined} layoutSummary - readiness.layout_summary
 */
export function summarizeLayoutSummary(layoutSummary) {
  if (!layoutSummary || typeof layoutSummary !== "object" || Object.keys(layoutSummary).length === 0) {
    return null;
  }
  return {
    layoutProvider: layoutSummary.layout_provider ?? null,
    apiVersion: layoutSummary.api_version ?? null,
    pageCount: layoutSummary.page_count ?? null,
    fullTextChars: layoutSummary.full_text_chars ?? 0,
    pagesWithText: layoutSummary.pages_with_text ?? 0,
    textBlockCount: layoutSummary.text_block_count ?? 0,
    tableCount: layoutSummary.table_count ?? 0,
    figureCount: layoutSummary.figure_count ?? 0,
    signatureRegionCount: layoutSummary.signature_region_count ?? 0,
    selectionMarkCount: layoutSummary.selection_mark_count ?? 0,
    pageMarkersPresent: Boolean(layoutSummary.page_markers_present),
    pageMappingCoverage: layoutSummary.page_mapping_coverage ?? null,
    warnings: Array.isArray(layoutSummary.warnings) ? layoutSummary.warnings : [],
  };
}

/**
 * Phase 7: derives the evidence-anchor diagnostic tile from
 * readiness.coverage_summary (Phase 7 Task E's new fields, side-write.ts's
 * computeEvidenceDiagnosticCounts()). No new fetch -- purely a reshape of
 * data readiness already returns (Phase 7 Task F).
 *
 * @param {Object|null|undefined} coverageSummary
 */
export function summarizeEvidenceAnchorDiagnostics(coverageSummary) {
  const summary = coverageSummary && typeof coverageSummary === "object" ? coverageSummary : {};
  if (!("evidence_anchor_source" in summary) && !("evidence_rows_with_block_ids" in summary)) {
    return null;
  }
  return {
    withBlockIds: summary.evidence_rows_with_block_ids ?? 0,
    withPolygon: summary.evidence_rows_with_polygon ?? 0,
    withSourceText: summary.evidence_rows_with_source_text ?? 0,
    withoutSourceText: summary.evidence_rows_without_source_text ?? 0,
    anchorSource: summary.evidence_anchor_source ?? "unavailable",
  };
}

function summarizeProfileEnsemble(ensemble) {
  if (!ensemble || typeof ensemble !== "object") return null;
  return {
    selectedProfileKey: ensemble.selected_profile_key ?? null,
    selectedPolicyKey: ensemble.selected_policy_key ?? null,
    confidence: ensemble.confidence ?? null,
    status: ensemble.status ?? "unknown",
    source: ensemble.profile_source ?? "fallback_unknown",
    candidates: Array.isArray(ensemble.candidates) ? ensemble.candidates : [],
    signals: ensemble.signals && typeof ensemble.signals === "object" ? ensemble.signals : {},
    disagreements: Array.isArray(ensemble.disagreements) ? ensemble.disagreements : [],
    fallbackReason: ensemble.fallback_reason ?? null,
  };
}

function summarizeExtractionPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  return {
    profileKey: plan.profile_key ?? null,
    modulesToRun: Array.isArray(plan.modules_to_run) ? plan.modules_to_run : [],
    modulesSkipped: Array.isArray(plan.modules_skipped) ? plan.modules_skipped : [],
    relatedDocumentsNeeded: Array.isArray(plan.related_documents_needed) ? plan.related_documents_needed : [],
    expectedInformationProfile: Array.isArray(plan.expected_information_profile) ? plan.expected_information_profile : [],
    plannerWarnings: Array.isArray(plan.planner_warnings) ? plan.planner_warnings : [],
    status: plan.status ?? "planned",
    diagnosticOnly: plan.diagnostic_only !== false,
  };
}

function summarizeCoverageDiagnostics(coverage) {
  if (!coverage || typeof coverage !== "object") return null;
  return {
    processing: coverage.processing_coverage ?? {},
    evidence: coverage.evidence_coverage ?? {},
    expectedInformation: coverage.expected_information_coverage ?? {},
    module: coverage.module_coverage ?? {},
    field: coverage.field_coverage ?? {},
    relatedDocument: coverage.related_document_coverage ?? {},
    validation: coverage.validation_coverage ?? {},
    overall: coverage.overall_coverage ?? {},
    diagnosticOnly: coverage.diagnostic_only !== false,
  };
}

function summarizeImportanceDiagnostics(readiness) {
  const summary = readiness?.importance_summary && typeof readiness.importance_summary === "object" ? readiness.importance_summary : null;
  if (!summary) return null;
  return {
    summary,
    importantMissingFields: Array.isArray(readiness.important_missing_fields) ? readiness.important_missing_fields : [],
    importantValidationDrops: Array.isArray(readiness.important_validation_drops) ? readiness.important_validation_drops : [],
    highImportanceAdvisories: Array.isArray(readiness.advisories)
      ? readiness.advisories.filter((advisory) => ["critical", "high"].includes(advisory?.importance_level))
      : [],
    unmappedHighImportanceClaims: Array.isArray(readiness.unmapped_high_importance_claims) ? readiness.unmapped_high_importance_claims : [],
    importantRelatedDocumentsMissing: Array.isArray(readiness.important_related_documents_missing) ? readiness.important_related_documents_missing : [],
  };
}
function summarizePackageGraph(readiness) {
  const graph = readiness?.package_graph && typeof readiness.package_graph === "object" ? readiness.package_graph : null;
  const requirements = Array.isArray(readiness?.related_document_requirements)
    ? readiness.related_document_requirements
    : (Array.isArray(graph?.related_document_requirements) ? graph.related_document_requirements : []);
  const candidates = Array.isArray(readiness?.candidate_related_documents)
    ? readiness.candidate_related_documents
    : (Array.isArray(graph?.candidates) ? graph.candidates : []);
  if (!graph && requirements.length === 0 && candidates.length === 0) return null;
  return {
    packageId: graph?.package_id ?? null,
    packageKey: graph?.package_key ?? null,
    graphStatus: readiness?.package_graph_status ?? graph?.graph_status ?? "not_available",
    documents: Array.isArray(graph?.documents) ? graph.documents : [],
    relationships: Array.isArray(graph?.relationships) ? graph.relationships : [],
    requirements,
    candidates,
    diagnosticOnly: graph?.diagnostic_only !== false,
    error: graph?.error ?? null,
  };
}
function summarizeTemporalSupersession(readiness) {
  const temporal = readiness?.temporal_supersession && typeof readiness.temporal_supersession === "object"
    ? readiness.temporal_supersession
    : null;
  if (!temporal) return null;
  return {
    diagnosticOnly: temporal.diagnostic_only !== false,
    temporalStatus: temporal.temporal_status ?? "not_available",
    documentTimeline: Array.isArray(temporal.document_timeline) ? temporal.document_timeline : [],
    effectivePeriods: Array.isArray(temporal.effective_periods) ? temporal.effective_periods : [],
    supersessionCandidates: Array.isArray(temporal.supersession_candidates) ? temporal.supersession_candidates : [],
    currentTruthCandidates: Array.isArray(temporal.current_truth_candidates) ? temporal.current_truth_candidates : [],
    historicalClaims: Array.isArray(temporal.historical_claims) ? temporal.historical_claims : [],
    unresolvedTemporalConflicts: Array.isArray(temporal.unresolved_temporal_conflicts) ? temporal.unresolved_temporal_conflicts : [],
    missingTemporalInputs: Array.isArray(temporal.missing_temporal_inputs) ? temporal.missing_temporal_inputs : [],
    warnings: Array.isArray(temporal.warnings) ? temporal.warnings : [],
  };
}
function summarizeApprovalAdvisory(readiness) {
  const advisory = readiness?.approval_advisory && typeof readiness.approval_advisory === "object"
    ? readiness.approval_advisory
    : null;
  if (!advisory) return null;
  const blockers = Array.isArray(advisory.blockers) ? advisory.blockers : [];
  const countBySeverity = blockers.reduce((acc, item) => {
    const severity = item?.severity || "informational";
    acc[severity] = (acc[severity] || 0) + 1;
    return acc;
  }, {
    blocking_if_enforced: 0,
    needs_review: 0,
    advisory: 0,
    informational: 0,
  });
  return {
    diagnosticOnly: advisory.diagnostic_only !== false,
    advisoryStatus: advisory.advisory_status ?? "advisory_not_available",
    advisoryReason: advisory.advisory_reason ?? null,
    wouldBlockApproval: Boolean(advisory.would_block_approval),
    wouldAllowApproval: Boolean(advisory.would_allow_approval),
    profileKey: advisory.profile_key ?? null,
    policyKey: advisory.policy_key ?? null,
    blockers,
    warnings: Array.isArray(advisory.warnings) ? advisory.warnings : [],
    advisories: Array.isArray(advisory.advisories) ? advisory.advisories : [],
    missingRequiredFields: Array.isArray(advisory.missing_required_fields) ? advisory.missing_required_fields : [],
    missingCriticalFields: Array.isArray(advisory.missing_critical_fields) ? advisory.missing_critical_fields : [],
    evidenceIssues: Array.isArray(advisory.evidence_issues) ? advisory.evidence_issues : [],
    validationIssues: Array.isArray(advisory.validation_issues) ? advisory.validation_issues : [],
    coverageIssues: Array.isArray(advisory.coverage_issues) ? advisory.coverage_issues : [],
    relatedDocumentIssues: Array.isArray(advisory.related_document_issues) ? advisory.related_document_issues : [],
    temporalIssues: Array.isArray(advisory.temporal_issues) ? advisory.temporal_issues : [],
    approvalReadinessSummary: advisory.approval_readiness_summary ?? {},
    futureGateInputs: advisory.future_gate_inputs ?? {},
    blockerCountsBySeverity: advisory.approval_readiness_summary?.blocker_counts_by_severity ?? countBySeverity,
  };
}
export function summarizeAdvisoryAuditBatch(batchAudit) {
  const batch = batchAudit && typeof batchAudit === "object" ? batchAudit : null;
  if (!batch) return null;
  return {
    diagnosticOnly: batch.diagnostic_only !== false,
    total: batch.total ?? 0,
    generatedAt: batch.generated_at ?? null,
    agreementCounts: batch.agreement_counts ?? {},
    discrepancyCounts: batch.discrepancy_counts ?? {},
    advisoryStatusCounts: batch.advisory_status_counts ?? {},
    currentStatusCounts: batch.current_status_counts ?? {},
    riskSummary: batch.risk_summary ?? {},
    results: Array.isArray(batch.results) ? batch.results : [],
    raw: batch,
  };
}
export function summarizeAdvisoryAudit(advisoryAudit) {
  const audit = advisoryAudit && typeof advisoryAudit === "object" ? advisoryAudit : null;
  if (!audit) return null;
  const comparison = audit.comparison && typeof audit.comparison === "object" ? audit.comparison : {};
  return {
    diagnosticOnly: audit.diagnostic_only !== false,
    auditId: audit.audit_id ?? null,
    runId: audit.run_id ?? null,
    uploadedFileId: audit.uploaded_file_id ?? null,
    leaseId: audit.lease_id ?? null,
    generatedAt: audit.generated_at ?? null,
    auditStatus: audit.audit_status ?? "insufficient_data",
    v3Status: comparison.v3_status ?? audit.v3_advisory?.advisory_status ?? "advisory_not_available",
    currentStatus: comparison.current_status ?? audit.current_review_snapshot?.current_status ?? "insufficient_data",
    agreementLevel: comparison.agreement_level ?? "insufficient_data",
    falsePositiveRisks: Array.isArray(comparison.false_positive_risks) ? comparison.false_positive_risks : [],
    falseNegativeRisks: Array.isArray(comparison.false_negative_risks) ? comparison.false_negative_risks : [],
    missingInputs: Array.isArray(comparison.missing_inputs) ? comparison.missing_inputs : [],
    notes: Array.isArray(comparison.notes) ? comparison.notes : [],
    discrepancies: Array.isArray(audit.discrepancies) ? audit.discrepancies : [],
    discrepancyCount: Array.isArray(audit.discrepancies) ? audit.discrepancies.length : 0,
    recommendations: Array.isArray(audit.recommendations) ? audit.recommendations : [],
    v3Advisory: audit.v3_advisory ?? null,
    currentReviewSnapshot: audit.current_review_snapshot ?? null,
    snapshotPersistence: audit.snapshot_persistence ?? null,
    raw: audit,
  };
}
function collectValidationDrops(requiredFields, optionalFields) {
  const drops = [];
  for (const field of [...(requiredFields || []), ...(optionalFields || [])]) {
    if (field?.validation_drop) {
      drops.push({
        field_key: field.field_key,
        required: !!field.required,
        reason: field.validation_drop.reason ?? null,
        bad_value: field.validation_drop.bad_value ?? null,
        action: field.validation_drop.action ?? null,
      });
    }
  }
  return drops;
}

/**
 * Shapes a raw document-intelligence-v3-readiness response (or null/error)
 * into the flat, display-ready object ExtractionDebugPanel.jsx renders.
 * Never throws -- an unrecognized/empty input degrades to the
 * not-available summary.
 *
 * @param {Object|null|undefined} readiness - the `readiness` object from
 *   the edge function response (fetchDocumentIntelligenceV3Readiness's
 *   `{error:false, readiness}` result), or null/undefined.
 */
export function summarizeV3Diagnostics(readiness) {
  if (!readiness || readiness.available === false) {
    return {
      available: false,
      notAvailableMessage: NOT_AVAILABLE_MESSAGE,
      diagnosticOnly: true,
      runId: readiness?.run_id ?? null,
      uploadedFileId: readiness?.uploaded_file_id ?? null,
      leaseId: null,
      profile: { profile_key: null, policy_key: "unknown_cre_document", confidence: null, status: "not_available" },
      readinessStatus: readiness?.readiness?.status ?? "not_available",
      readinessReason: readiness?.readiness?.reason ?? "no_completed_run",
      blockers: [],
      advisories: [],
      requiredFieldsSummary: summarizeFieldList([]),
      optionalFieldsSummary: summarizeFieldList([]),
      validationDrops: [],
      ...emptyCounts(),
      coverageSummary: {},
      layoutSummary: null,
      evidenceAnchorDiagnostics: null,
      evidenceSufficiencySummary: summarizeEvidenceSufficiencyCounts(emptyEvidenceSufficiencyCounts()),
      profileEnsemble: null,
      extractionPlan: null,
      modulesToRunCount: 0,
      modulesSkippedCount: 0,
      relatedDocumentsNeeded: [],
      plannerWarnings: [],
      coverage: null,
      importance: null,
      importantMissingFields: [],
      importantValidationDrops: [],
      unmappedHighImportanceClaims: [],
      importantRelatedDocumentsMissing: [],
      packageGraph: null,
      relatedDocumentRequirements: [],
      candidateRelatedDocuments: [],
      packageGraphStatus: "not_available",
      temporalSupersession: null,
      approvalAdvisory: null,
    };
  }

  const requiredFields = Array.isArray(readiness.required_fields) ? readiness.required_fields : [];
  const optionalFields = Array.isArray(readiness.optional_fields) ? readiness.optional_fields : [];
  const evidenceSufficiencyCounts = readiness.evidence_sufficiency_counts
    || Object.fromEntries(Object.keys(EVIDENCE_SUFFICIENCY_LABELS).map((key) => [key, readiness.coverage_summary?.[key] ?? 0]));
  const profileEnsemble = summarizeProfileEnsemble(readiness.profile_ensemble ?? readiness.coverage_summary?.profile_ensemble);
  const extractionPlan = summarizeExtractionPlan(readiness.extraction_plan ?? readiness.coverage_summary?.extraction_plan);
  const coverage = summarizeCoverageDiagnostics(readiness.coverage);
  const importance = summarizeImportanceDiagnostics(readiness);
  const packageGraph = summarizePackageGraph(readiness);
  const temporalSupersession = summarizeTemporalSupersession(readiness);
  const approvalAdvisory = summarizeApprovalAdvisory(readiness);

  return {
    available: true,
    notAvailableMessage: null,
    diagnosticOnly: readiness.diagnostic_only !== false,
    runId: readiness.run_id ?? null,
    uploadedFileId: readiness.uploaded_file_id ?? null,
    leaseId: readiness.lease_id ?? null,
    profile: {
      profile_key: readiness.profile?.profile_key ?? null,
      policy_key: readiness.profile?.policy_key ?? "unknown_cre_document",
      confidence: readiness.profile?.confidence ?? null,
      status: readiness.profile?.status ?? "unclassified",
    },
    readinessStatus: readiness.readiness?.status ?? "unknown",
    readinessReason: readiness.readiness?.reason ?? null,
    blockers: Array.isArray(readiness.blockers) ? readiness.blockers : [],
    advisories: Array.isArray(readiness.advisories) ? readiness.advisories : [],
    requiredFieldsSummary: summarizeFieldList(requiredFields),
    optionalFieldsSummary: summarizeFieldList(optionalFields),
    validationDrops: collectValidationDrops(requiredFields, optionalFields),
    claimCounts: readiness.claim_counts ?? emptyCounts().claimCounts,
    evidenceCounts: readiness.evidence_counts ?? emptyCounts().evidenceCounts,
    validationDropCounts: readiness.validation_drop_counts ?? emptyCounts().validationDropCounts,
    sourceBackedCounts: readiness.source_backed_counts ?? emptyCounts().sourceBackedCounts,
    evidenceSufficiencyCounts,
    evidenceSufficiencySummary: summarizeEvidenceSufficiencyCounts(evidenceSufficiencyCounts),
    coverageSummary: readiness.coverage_summary ?? {},
    layoutSummary: summarizeLayoutSummary(readiness.layout_summary),
    evidenceAnchorDiagnostics: summarizeEvidenceAnchorDiagnostics(readiness.coverage_summary),
    profileEnsemble,
    extractionPlan,
    modulesToRunCount: readiness.modules_to_run_count ?? extractionPlan?.modulesToRun?.length ?? readiness.coverage_summary?.modules_to_run_count ?? 0,
    modulesSkippedCount: readiness.modules_skipped_count ?? extractionPlan?.modulesSkipped?.length ?? readiness.coverage_summary?.modules_skipped_count ?? 0,
    relatedDocumentsNeeded: readiness.related_documents_needed ?? extractionPlan?.relatedDocumentsNeeded ?? readiness.coverage_summary?.related_documents_needed ?? [],
    plannerWarnings: readiness.planner_warnings ?? extractionPlan?.plannerWarnings ?? readiness.coverage_summary?.planner_warnings ?? [],
    coverage,
    importance,
    importantMissingFields: importance?.importantMissingFields ?? [],
    importantValidationDrops: importance?.importantValidationDrops ?? [],
    unmappedHighImportanceClaims: importance?.unmappedHighImportanceClaims ?? [],
    importantRelatedDocumentsMissing: importance?.importantRelatedDocumentsMissing ?? [],
    packageGraph,
    relatedDocumentRequirements: packageGraph?.requirements ?? [],
    candidateRelatedDocuments: packageGraph?.candidates ?? [],
    packageGraphStatus: readiness.package_graph_status ?? packageGraph?.graphStatus ?? "not_available",
    temporalSupersession,
    approvalAdvisory,
  };
}

/**
 * Filename for the "Download JSON" control.
 * @param {string|null} uploadedFileId
 */
export function buildV3AdvisoryAuditBatchFilename(uploadedFileId) {
  return `document-intelligence-v3-advisory-audit-batch-${uploadedFileId || "unknown"}.json`;
}

export function buildV3AdvisoryAuditFilename(uploadedFileId) {
  return `document-intelligence-v3-advisory-audit-${uploadedFileId || "unknown"}.json`;
}

export function buildV3DiagnosticsFilename(uploadedFileId) {
  return `document-intelligence-v3-diagnostics-${uploadedFileId || "unknown"}.json`;
}

export const DOCUMENT_INTELLIGENCE_V3_NOT_AVAILABLE_MESSAGE = NOT_AVAILABLE_MESSAGE;







