// @ts-nocheck
/**
 * Document Intelligence v3 - Advisory Audit / Comparison Harness (Phase 14)
 *
 * Diagnostic-only comparison between the Phase 13 v3 approval advisory and
 * the current Lease Review readiness signals already persisted on
 * uploaded_files / leases. This module never calls approve_lease_workflow,
 * never mutates approval state, and does not make v3 advisory a hard gate.
 */

const AGREEMENT_LEVELS = new Set([
  "agrees",
  "mostly_agrees",
  "differs_v3_stricter",
  "differs_v3_more_permissive",
  "not_comparable",
  "insufficient_data",
]);

const FULL_LEASE_FALSE_BLOCKER_FIELDS = new Set([
  "monthly_rent",
  "annual_rent",
  "rent_per_sf",
  "lease_type",
  "security_deposit",
  "cam_amount",
  "estimated_annual_cam",
  "estimated_monthly_cam",
  "tenant_pro_rata_share",
  "base_year",
  "expense_stop",
]);

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function compact(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function unique(values: any[]) {
  return [...new Set(values.filter((value) => value != null && String(value).trim()))];
}

function nowIso() {
  return new Date().toISOString();
}

function makeAuditId(parts: any = {}) {
  return [
    "diaudit",
    compact(parts.run_id) ?? "no-run",
    compact(parts.uploaded_file_id) ?? "no-upload",
    compact(parts.lease_id) ?? "no-lease",
    Date.now(),
  ].join(":");
}

function normalizeStatusToken(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function fieldKey(row: any) {
  return compact(row?.field_key ?? row?.key ?? row?.name ?? row?.canonical_key ?? row?.canonicalKey);
}

function rowStatus(row: any) {
  return normalizeStatusToken(
    row?.status
      ?? row?.review_status
      ?? row?.reviewStatus
      ?? row?.extraction_status
      ?? row?.extractionStatus
      ?? row?.field_status
      ?? row?.fieldStatus,
  );
}

function hasValue(value: unknown) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function flattenObjectFields(obj: any) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj).map(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { key, ...value };
    }
    return { key, value };
  });
}

function collectPayloadRows(payload: any) {
  const rows = [
    ...asArray(payload?.records),
    ...asArray(payload?.rows),
    ...asArray(payload?.standard_fields),
    ...asArray(payload?.fields),
    ...asArray(payload?.custom_fields),
    ...flattenObjectFields(payload?.standard_fields),
    ...flattenObjectFields(payload?.fields),
    ...flattenObjectFields(payload?.field_reviews),
  ];

  for (const record of [...asArray(payload?.records), ...asArray(payload?.rows)]) {
    rows.push(
      ...asArray(record?.standard_fields),
      ...asArray(record?.fields),
      ...asArray(record?.custom_fields),
      ...flattenObjectFields(record?.standard_fields),
      ...flattenObjectFields(record?.fields),
      ...flattenObjectFields(record?.custom_fields),
      ...flattenObjectFields(record?.workflow_output?.lease_fields),
    );
  }

  return rows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    return Boolean(
      fieldKey(row)
        || row?.status != null
        || row?.review_status != null
        || row?.reviewStatus != null
        || row?.extraction_status != null
        || row?.value != null
        || row?.normalized_value != null
        || row?.raw_value != null
        || row?.required != null
        || row?.accepted != null,
    );
  });
}

function collectFieldReviewRows(lease: any) {
  return flattenObjectFields(lease?.extraction_data?.field_reviews).map((row) => ({
    ...row,
    status: row.status ?? row.review_status,
    source: "leases.extraction_data.field_reviews",
  }));
}

function collectBlockersFromPayload(uploadedFile: any, lease: any) {
  const payload = uploadedFile?.ui_review_payload ?? {};
  const workflowOutput = payload?.metadata?.workflow_output
    ?? asArray(payload?.records)[0]?.workflow_output
    ?? lease?.extraction_data?.workflow_output
    ?? {};
  return [
    ...asArray(payload?.approval_blockers),
    ...asArray(payload?.metadata?.approval_blockers),
    ...asArray(payload?.metadata?.extractionDebug?.openai_fact_ledger?.approval_blockers),
    ...asArray(payload?.metadata?.extractionDebug?.vertex_fact_ledger?.approval_blockers),
    ...asArray(workflowOutput?.approval_blockers),
    ...asArray(lease?.extraction_data?.approval_blockers),
    ...asArray(lease?.extraction_data?.workflow_output?.approval_blockers),
  ];
}

function countRows(rows: any[]) {
  const counts = {
    total: rows.length,
    accepted: 0,
    edited: 0,
    not_applicable: 0,
    rejected: 0,
    needs_review: 0,
    pending: 0,
    missing: 0,
    manual_required: 0,
    resolved: 0,
  };
  const missingFields = [];
  const needsReviewFields = [];
  const acceptedFields = [];

  for (const row of rows) {
    const key = fieldKey(row);
    const status = rowStatus(row);
    const valuePresent = hasValue(row?.value ?? row?.normalized_value ?? row?.raw_value ?? row?.text);
    const accepted = row?.accepted === true || status === "accepted";
    const edited = status === "edited";
    const notApplicable = ["not_applicable", "n/a", "na"].includes(status);
    const rejected = status === "rejected";
    const manualRequired = status === "manual_required";
    const missing = status === "missing" || status === "not_found" || (!valuePresent && row?.required === true);
    const needsReview = status === "needs_review" || status === "pending" || status === "missing_source_evidence";

    if (accepted) {
      counts.accepted += 1;
      if (key) acceptedFields.push(key);
    }
    if (edited) counts.edited += 1;
    if (notApplicable) counts.not_applicable += 1;
    if (rejected) counts.rejected += 1;
    if (manualRequired) counts.manual_required += 1;
    if (status === "pending") counts.pending += 1;
    if (missing) {
      counts.missing += 1;
      if (key) missingFields.push(key);
    }
    if (needsReview) {
      counts.needs_review += 1;
      if (key) needsReviewFields.push(key);
    }
    if (accepted || edited || notApplicable || manualRequired) counts.resolved += 1;
  }

  return {
    counts,
    missing_fields: unique(missingFields),
    needs_review_fields: unique(needsReviewFields),
    accepted_fields: unique(acceptedFields),
  };
}

function deriveCurrentDecision(snapshot: any) {
  if (snapshot?.current_allows_approval === true) return "allows_approval";
  if (snapshot?.current_blocks_approval === true) return "blocks_approval";
  if (snapshot?.current_status) return snapshot.current_status;

  const reviewStatus = normalizeStatusToken(snapshot?.review_status);
  const approvalStatus = normalizeStatusToken(snapshot?.approval_status);
  if (approvalStatus === "approved" || reviewStatus === "approved") return "allows_approval";

  if ((snapshot?.current_approval_blockers ?? []).length > 0) return "blocks_approval";
  if ((snapshot?.counts?.missing ?? 0) > 0 || (snapshot?.counts?.needs_review ?? 0) > 0) return "blocks_approval";
  if ((snapshot?.counts?.total ?? 0) > 0 && (snapshot?.counts?.resolved ?? 0) >= (snapshot?.counts?.total ?? 0)) return "allows_approval";
  if (["review_required", "pending", "saved", "needs_review"].includes(reviewStatus)) return "needs_review";

  return "insufficient_data";
}

export function buildCurrentReviewSnapshot({
  uploadedFile = null,
  lease = null,
  explicitSnapshot = null,
}: {
  uploadedFile?: any;
  lease?: any;
  explicitSnapshot?: any;
} = {}) {
  if (explicitSnapshot && typeof explicitSnapshot === "object") {
    const currentStatus = deriveCurrentDecision(explicitSnapshot);
    return {
      diagnostic_only: true,
      snapshot_source: "explicit_test_or_caller_snapshot",
      ...explicitSnapshot,
      current_status: currentStatus,
      current_allows_approval: currentStatus === "allows_approval",
      current_blocks_approval: currentStatus === "blocks_approval",
    };
  }

  const payload = uploadedFile?.ui_review_payload ?? null;
  const rows = [...collectPayloadRows(payload), ...collectFieldReviewRows(lease)];
  const rowSummary = countRows(rows);
  const approvalBlockers = collectBlockersFromPayload(uploadedFile, lease);
  const readiness = payload?.readiness ?? payload?.metadata?.readiness ?? payload?.metadata?.review_readiness ?? null;
  const reviewStatus = uploadedFile?.review_status
    ?? payload?.review_status
    ?? lease?.review_status
    ?? lease?.approval_status
    ?? null;
  const approvalStatus = lease?.approval_status ?? payload?.approval_status ?? null;
  const completionState = payload?.review_completion_state
    ?? payload?.metadata?.review_completion_state
    ?? lease?.extraction_data?.review_completion_state
    ?? null;

  const snapshot = {
    diagnostic_only: true,
    snapshot_source: "uploaded_files_and_lease_payloads",
    uploaded_file_id: uploadedFile?.id ?? lease?.source_file_id ?? lease?.extraction_data?.source_file_id ?? null,
    lease_id: lease?.id ?? uploadedFile?.lease_id ?? payload?.lease_id ?? asArray(payload?.records)[0]?.lease_id ?? null,
    uploaded_file_status: uploadedFile?.status ?? null,
    uploaded_file_processing_status: uploadedFile?.processing_status ?? null,
    review_status: reviewStatus,
    approval_status: approvalStatus,
    review_completion_state: completionState,
    ui_review_payload_readiness: readiness,
    current_approval_blockers: approvalBlockers,
    current_approval_blocker_count: approvalBlockers.length,
    lease_review_schema_client_inputs_available: rows.length > 0,
    counts: rowSummary.counts,
    missing_fields: rowSummary.missing_fields,
    needs_review_fields: rowSummary.needs_review_fields,
    accepted_fields: rowSummary.accepted_fields,
    missing_required: unique([
      ...asArray(payload?.missing_required),
      ...asArray(payload?.metadata?.missing_required),
      ...asArray(readiness?.missing_required),
      ...rowSummary.missing_fields,
    ]),
    notes: [
      "Snapshot is read-only and inferred from persisted upload/lease payloads.",
      "It does not execute the mounted LeaseReview.jsx client evaluator or call approval RPCs.",
    ],
  };
  const currentStatus = deriveCurrentDecision(snapshot);
  return {
    ...snapshot,
    current_status: currentStatus,
    current_allows_approval: currentStatus === "allows_approval",
    current_blocks_approval: currentStatus === "blocks_approval",
  };
}

function v3Decision(advisory: any) {
  const status = advisory?.advisory_status ?? "advisory_not_available";
  if (status === "advisory_ready") return "allows_approval";
  if (status === "advisory_blocked") return "blocks_approval";
  if (status === "advisory_needs_review") return "needs_review";
  if (status === "advisory_not_applicable") return "not_applicable";
  return "insufficient_data";
}

function blockerFields(items: any[]) {
  return unique(asArray(items).map((item) => item?.field_key ?? item?.key));
}

function hasProfileUnknown(advisory: any) {
  return asArray(advisory?.blockers).some((item) => item?.blocker_type === "profile_unknown")
    || advisory?.policy_key === "unknown_cre_document";
}

function hasAssignmentPolicy(advisory: any) {
  return String(advisory?.policy_key ?? advisory?.profile_key ?? "").includes("assignment");
}

function discrepancy(type: string, severity: string, message: string, evidence: any = {}) {
  return { type, severity, message, evidence };
}

export function compareAdvisoryToCurrentReview({
  v3Advisory,
  currentReviewSnapshot,
}: {
  v3Advisory: any;
  currentReviewSnapshot: any;
}) {
  const v3Status = v3Advisory?.advisory_status ?? "advisory_not_available";
  const currentStatus = currentReviewSnapshot?.current_status ?? "insufficient_data";
  const v3Path = v3Decision(v3Advisory);
  const currentAllows = currentReviewSnapshot?.current_allows_approval === true || currentStatus === "allows_approval";
  const currentBlocks = currentReviewSnapshot?.current_blocks_approval === true || currentStatus === "blocks_approval";
  const discrepancies = [];
  const falsePositiveRisks = [];
  const falseNegativeRisks = [];
  const missingInputs = [];
  const notes = [];

  if (!v3Advisory || v3Status === "advisory_not_available") {
    missingInputs.push("v3_approval_advisory");
  }
  if (!currentReviewSnapshot || currentStatus === "insufficient_data") {
    missingInputs.push("current_review_snapshot");
  }

  if (v3Status === "advisory_blocked" && currentAllows) {
    discrepancies.push(discrepancy(
      "current_path_may_be_too_permissive",
      "high",
      "v3 advisory would block if enforced, while current review appears to allow approval.",
      { v3_status: v3Status, current_status: currentStatus },
    ));
    falseNegativeRisks.push("current_approval_may_miss_v3_blockers");
  }

  if (v3Status === "advisory_ready" && currentBlocks) {
    discrepancies.push(discrepancy(
      "current_path_may_be_too_strict",
      "medium",
      "v3 advisory is ready, while current review appears blocked.",
      { v3_status: v3Status, current_status: currentStatus },
    ));
    falsePositiveRisks.push("current_approval_may_block_ready_document");
  }

  if (hasProfileUnknown(v3Advisory) && currentBlocks) {
    discrepancies.push(discrepancy(
      "profile_policy_mismatch",
      "medium",
      "v3 has an unknown profile, but the current path appears to apply blocking review policy.",
      { policy_key: v3Advisory?.policy_key, current_blockers: currentReviewSnapshot?.current_approval_blockers ?? [] },
    ));
  }

  const currentMissing = new Set([
    ...asArray(currentReviewSnapshot?.missing_required),
    ...asArray(currentReviewSnapshot?.missing_fields),
    ...blockerFields(currentReviewSnapshot?.current_approval_blockers),
  ].map(String));
  const falseFullLeaseFields = [...currentMissing].filter((field) => FULL_LEASE_FALSE_BLOCKER_FIELDS.has(field));
  if (hasAssignmentPolicy(v3Advisory) && falseFullLeaseFields.length > 0) {
    discrepancies.push(discrepancy(
      "assignment_false_full_lease_blocker",
      "medium",
      "Current review appears to require full-lease fields for an assignment profile.",
      { fields: falseFullLeaseFields },
    ));
    falsePositiveRisks.push("assignment_document_may_be_blocked_by_full_lease_requirements");
  }

  if (asArray(v3Advisory?.evidence_issues).length > 0 && currentAllows) {
    discrepancies.push(discrepancy(
      "evidence_requirement_mismatch",
      "high",
      "v3 reports missing or insufficient evidence, while current review appears acceptable.",
      { evidence_issues: v3Advisory.evidence_issues },
    ));
    falseNegativeRisks.push("current_approval_may_accept_fields_without_v3_evidence");
  }

  const hasMissingRelated = asArray(v3Advisory?.related_document_issues)
    .some((issue) => String(issue?.reason ?? "").includes("missing_related_document"));
  const currentBudgetBlocked = [...currentMissing].some((field) =>
    ["budget", "monthly_rent", "annual_rent", "lease_type", "cam_amount", "estimated_annual_cam"].includes(field)
  );
  if (hasMissingRelated && currentBudgetBlocked) {
    discrepancies.push(discrepancy(
      "related_document_policy_mismatch",
      "medium",
      "v3 treats a missing related document as advisory, while current review appears to block full budget inputs.",
      { related_document_issues: v3Advisory.related_document_issues },
    ));
  }

  if (asArray(v3Advisory?.temporal_issues).length > 0 && currentAllows) {
    discrepancies.push(discrepancy(
      "temporal_policy_mismatch",
      "high",
      "v3 reports temporal or supersession issues, while current review appears acceptable.",
      { temporal_issues: v3Advisory.temporal_issues },
    ));
    falseNegativeRisks.push("current_approval_may_accept_unresolved_temporal_issues");
  }

  if (asArray(v3Advisory?.coverage_issues).length > 0 && currentAllows) {
    discrepancies.push(discrepancy(
      "coverage_mismatch",
      "medium",
      "v3 reports low coverage or missing coverage inputs, while current review appears acceptable.",
      { coverage_issues: v3Advisory.coverage_issues },
    ));
    falseNegativeRisks.push("current_approval_may_accept_low_v3_coverage");
  }

  let agreementLevel = "insufficient_data";
  if (missingInputs.length > 0) {
    agreementLevel = missingInputs.length === 2 ? "insufficient_data" : "not_comparable";
  } else if (discrepancies.some((item) => item.type === "current_path_may_be_too_permissive")) {
    agreementLevel = "differs_v3_stricter";
  } else if (discrepancies.some((item) => item.type === "current_path_may_be_too_strict" || item.type === "assignment_false_full_lease_blocker")) {
    agreementLevel = "differs_v3_more_permissive";
  } else if (v3Path === "allows_approval" && currentAllows) {
    agreementLevel = "agrees";
  } else if (v3Path === "blocks_approval" && currentBlocks) {
    agreementLevel = "agrees";
  } else if (v3Path === "needs_review" && (currentBlocks || currentStatus === "needs_review")) {
    agreementLevel = "mostly_agrees";
  } else if (v3Path === "not_applicable") {
    agreementLevel = "not_comparable";
  } else {
    agreementLevel = "not_comparable";
  }

  if (!AGREEMENT_LEVELS.has(agreementLevel)) agreementLevel = "not_comparable";
  if (currentReviewSnapshot?.snapshot_source === "uploaded_files_and_lease_payloads") {
    notes.push("Current review status is inferred from persisted payloads, not from executing the live React component.");
  }

  return {
    v3_status: v3Status,
    current_status: currentStatus,
    agreement_level: agreementLevel,
    false_positive_risks: unique(falsePositiveRisks),
    false_negative_risks: unique(falseNegativeRisks),
    missing_inputs: unique(missingInputs),
    notes,
    discrepancies,
  };
}

export function buildAdvisoryAudit({
  readiness = null,
  v3Advisory = null,
  currentReviewSnapshot = null,
  uploadedFile = null,
  lease = null,
  generatedAt = null,
  auditId = null,
}: {
  readiness?: any;
  v3Advisory?: any;
  currentReviewSnapshot?: any;
  uploadedFile?: any;
  lease?: any;
  generatedAt?: string | null;
  auditId?: string | null;
} = {}) {
  const advisory = v3Advisory ?? readiness?.approval_advisory ?? null;
  const snapshot = currentReviewSnapshot ?? buildCurrentReviewSnapshot({ uploadedFile, lease });
  const comparison = compareAdvisoryToCurrentReview({
    v3Advisory: advisory,
    currentReviewSnapshot: snapshot,
  });
  const discrepancies = comparison.discrepancies;
  const recommendations = [];
  if (comparison.missing_inputs.length > 0) {
    recommendations.push("Load or generate the missing diagnostic inputs before comparing approval paths.");
  }
  if (discrepancies.some((item) => item.type === "current_path_may_be_too_permissive")) {
    recommendations.push("Review v3 blockers against the current approval checklist before considering a future gate.");
  }
  if (discrepancies.some((item) => item.type === "current_path_may_be_too_strict" || item.type === "assignment_false_full_lease_blocker")) {
    recommendations.push("Inspect current required-field policy for profile-aware false blockers.");
  }
  if (discrepancies.some((item) => item.type === "evidence_requirement_mismatch")) {
    recommendations.push("Compare current accepted fields with v3 evidence sufficiency before promoting evidence requirements.");
  }
  if (discrepancies.some((item) => item.type === "related_document_policy_mismatch")) {
    recommendations.push("Separate related-document advisory completeness from full-lease/budget blockers in the future policy design.");
  }

  const audit = {
    diagnostic_only: true,
    audit_id: auditId ?? makeAuditId({
      run_id: advisory?.run_id ?? readiness?.run_id,
      uploaded_file_id: advisory?.uploaded_file_id ?? readiness?.uploaded_file_id ?? snapshot?.uploaded_file_id,
      lease_id: advisory?.lease_id ?? readiness?.lease_id ?? snapshot?.lease_id,
    }),
    run_id: advisory?.run_id ?? readiness?.run_id ?? null,
    uploaded_file_id: advisory?.uploaded_file_id ?? readiness?.uploaded_file_id ?? snapshot?.uploaded_file_id ?? null,
    lease_id: advisory?.lease_id ?? readiness?.lease_id ?? snapshot?.lease_id ?? null,
    generated_at: generatedAt ?? nowIso(),
    v3_advisory: advisory,
    current_review_snapshot: snapshot,
    comparison: {
      v3_status: comparison.v3_status,
      current_status: comparison.current_status,
      agreement_level: comparison.agreement_level,
      false_positive_risks: comparison.false_positive_risks,
      false_negative_risks: comparison.false_negative_risks,
      missing_inputs: comparison.missing_inputs,
      notes: comparison.notes,
    },
    discrepancies,
    recommendations: unique(recommendations),
    audit_status: comparison.missing_inputs.length > 0
      ? "insufficient_data"
      : discrepancies.length > 0
        ? "discrepancies_found"
        : "no_discrepancies",
  };

  return audit;
}

export function buildBatchAdvisoryAuditSummary(audits: any[] = []) {
  const results = asArray(audits);
  const agreementCounts: Record<string, number> = {};
  const discrepancyCounts: Record<string, number> = {};

  for (const audit of results) {
    const agreement = audit?.comparison?.agreement_level ?? "insufficient_data";
    agreementCounts[agreement] = (agreementCounts[agreement] ?? 0) + 1;
    for (const item of asArray(audit?.discrepancies)) {
      const type = item?.type ?? "unknown";
      discrepancyCounts[type] = (discrepancyCounts[type] ?? 0) + 1;
    }
  }

  return {
    diagnostic_only: true,
    total: results.length,
    agreement_counts: agreementCounts,
    discrepancy_counts: discrepancyCounts,
    results,
  };
}
