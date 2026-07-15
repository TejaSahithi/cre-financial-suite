// @ts-nocheck
/**
 * Document Intelligence v3 - Approval Advisory Simulation (Phase 13)
 *
 * Diagnostic-only simulation of a future profile-aware approval gate. This
 * module never writes, never calls approve_lease_workflow, and must not be
 * used as a real approval blocker until a later phase explicitly promotes it.
 */

const ADVISORY_STATUSES = new Set([
  "advisory_ready",
  "advisory_needs_review",
  "advisory_blocked",
  "advisory_not_available",
  "advisory_not_applicable",
]);

const BLOCKING_VALIDATION_REASONS = new Set([
  "invalid_markup_value",
  "invalid_signature_date_source",
  "unsupported_inferred_value",
  "missing_source_evidence",
]);

const INSUFFICIENT_EVIDENCE = new Set(["none", "insufficient"]);
const LOW_COVERAGE_LEVELS = new Set(["unavailable", "minimal", "low"]);

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function uniqueByKey(rows: any[], keyFn: (row: any) => string) {
  const seen = new Set<string>();
  const out = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function isImportant(level: string | null | undefined) {
  return level === "critical" || level === "high";
}

function isCritical(level: string | null | undefined) {
  return level === "critical";
}

function normalizePolicyKey(readiness: any) {
  return readiness?.profile?.policy_key ?? readiness?.profile_ensemble?.selected_policy_key ?? "unknown_cre_document";
}

function baseAdvisory(readiness: any, status = "advisory_not_available", reason = "v3 diagnostic run not available") {
  return {
    diagnostic_only: true,
    advisory_status: status,
    advisory_reason: reason,
    would_block_approval: false,
    would_allow_approval: false,
    profile_key: readiness?.profile?.profile_key ?? null,
    policy_key: normalizePolicyKey(readiness),
    run_id: readiness?.run_id ?? null,
    uploaded_file_id: readiness?.uploaded_file_id ?? null,
    lease_id: readiness?.lease_id ?? null,
    blockers: [],
    warnings: [],
    advisories: [],
    missing_required_fields: [],
    missing_critical_fields: [],
    evidence_issues: [],
    validation_issues: [],
    coverage_issues: [],
    related_document_issues: [],
    temporal_issues: [],
    approval_readiness_summary: {
      required_fields_total: 0,
      required_fields_source_backed: 0,
      required_fields_missing: 0,
      required_fields_needs_review: 0,
      critical_blockers: 0,
      needs_review_items: 0,
      advisory_items: 0,
      coverage_level: "unavailable",
      profile_status: readiness?.profile?.status ?? "not_available",
    },
    future_gate_inputs: {
      readiness_status: readiness?.readiness?.status ?? "not_available",
      readiness_reason: readiness?.readiness?.reason ?? "no_completed_run",
      profile: readiness?.profile ?? null,
      coverage: readiness?.coverage ?? null,
      importance_summary: readiness?.importance_summary ?? null,
      package_graph_status: readiness?.package_graph_status ?? "not_available",
      temporal_status: readiness?.temporal_supersession?.temporal_status ?? "not_available",
    },
  };
}

export function emptyApprovalAdvisory(readiness: any = null) {
  return baseAdvisory(readiness);
}

function blocker({
  blocker_type,
  severity,
  field_key = null,
  claim_id = null,
  reason,
  source,
  importance_level = null,
  evidence_sufficiency = null,
  validation_drop_reason = null,
  profile_key = null,
  recommended_action,
}) {
  return {
    blocker_type,
    severity,
    field_key,
    claim_id,
    reason,
    source,
    importance_level,
    evidence_sufficiency,
    validation_drop_reason,
    profile_key,
    recommended_action,
  };
}

function missingFieldBlocker(field: any, profileKey: string) {
  const critical = isCritical(field?.importance_level);
  return blocker({
    blocker_type: critical ? "missing_critical_field" : "missing_required_field",
    severity: critical ? "blocking_if_enforced" : "needs_review",
    field_key: field?.field_key ?? null,
    reason: field?.missing_reason ?? "missing_required_field",
    source: "required_fields",
    importance_level: field?.importance_level ?? null,
    evidence_sufficiency: field?.evidence_sufficiency ?? null,
    profile_key: profileKey,
    recommended_action: critical
      ? "Capture or reviewer-enter the critical required field with evidence before approval."
      : "Review the missing profile-required field.",
  });
}

function evidenceBlocker(field: any, profileKey: string) {
  const critical = isCritical(field?.importance_level);
  const insufficient = INSUFFICIENT_EVIDENCE.has(String(field?.evidence_sufficiency ?? ""));
  return blocker({
    blocker_type: insufficient ? "insufficient_evidence" : "missing_source_evidence",
    severity: critical ? "blocking_if_enforced" : "needs_review",
    field_key: field?.field_key ?? null,
    claim_id: asArray(field?.source_claim_ids)[0] ?? null,
    reason: field?.missing_reason ?? (insufficient ? "insufficient_evidence" : "missing_source_evidence"),
    source: "evidence_sufficiency",
    importance_level: field?.importance_level ?? null,
    evidence_sufficiency: field?.evidence_sufficiency ?? null,
    profile_key: profileKey,
    recommended_action: "Attach source evidence or reviewer-confirm the value before relying on it for approval.",
  });
}

function validationBlocker(drop: any, field: any, profileKey: string) {
  const level = field?.importance_level ?? drop?.importance_level ?? null;
  return blocker({
    blocker_type: "validation_drop",
    severity: isCritical(level) ? "blocking_if_enforced" : isImportant(level) ? "needs_review" : "advisory",
    field_key: drop?.field_key ?? field?.field_key ?? null,
    claim_id: drop?.claim_id ?? null,
    reason: drop?.reason ?? "validation_drop",
    source: "validation_drops",
    importance_level: level,
    evidence_sufficiency: field?.evidence_sufficiency ?? null,
    validation_drop_reason: drop?.reason ?? null,
    profile_key: profileKey,
    recommended_action: "Resolve the validation drop or document a reviewer override.",
  });
}

function coverageBlocker(coverage: any, reason: string, severity = "needs_review") {
  return blocker({
    blocker_type: "coverage_too_low",
    severity,
    reason,
    source: "coverage",
    recommended_action: "Review extraction coverage before treating the v3 record as approval-ready.",
  });
}

function relatedDocumentBlocker(issue: any, profileKey: string) {
  const doc = issue?.document_type ?? issue;
  return blocker({
    blocker_type: "missing_related_document",
    severity: "needs_review",
    reason: `missing_related_document:${doc}`,
    source: "package_graph",
    importance_level: issue?.importance_level ?? "high",
    profile_key: profileKey,
    recommended_action: "Link or inspect the related document before relying on current-truth completeness.",
  });
}

function temporalBlocker(issue: any, profileKey: string) {
  const reason = typeof issue === "string" ? issue : (issue?.reason ?? issue?.status ?? "temporal_conflict");
  const type = String(reason).includes("supersession") || String(reason).includes("blocked_missing_related_document")
    ? "unresolved_supersession"
    : "temporal_conflict";
  return blocker({
    blocker_type: type,
    severity: "needs_review",
    field_key: issue?.field_key ?? null,
    claim_id: issue?.claim_id ?? null,
    reason,
    source: "temporal_supersession",
    importance_level: issue?.importance_level ?? null,
    profile_key: profileKey,
    recommended_action: "Resolve temporal ordering or related-document dependency before enforcing approval.",
  });
}

function summarizeBlockers(blockers: any[]) {
  const bySeverity: Record<string, number> = {
    blocking_if_enforced: 0,
    needs_review: 0,
    advisory: 0,
    informational: 0,
  };
  for (const item of blockers) {
    const severity = item?.severity ?? "informational";
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
  }
  return bySeverity;
}

export function buildApprovalAdvisoryFromReadiness(readiness: any) {
  if (!readiness || readiness.available === false) {
    return baseAdvisory(readiness, "advisory_not_available", "v3 diagnostic run not available");
  }

  const policyKey = normalizePolicyKey(readiness);
  const profileKey = readiness?.profile?.profile_key ?? null;
  const advisory = baseAdvisory(readiness, "advisory_ready", "v3 advisory simulation found no enforced blockers");
  advisory.profile_key = profileKey;
  advisory.policy_key = policyKey;

  if (policyKey === "non_cre_document") {
    advisory.advisory_status = "advisory_not_applicable";
    advisory.advisory_reason = "document is not a CRE review document";
    advisory.would_allow_approval = false;
    advisory.advisories.push("Document is not applicable to CRE Lease Review approval.");
    return advisory;
  }

  if (policyKey === "unknown_cre_document") {
    const issue = blocker({
      blocker_type: "profile_unknown",
      severity: "needs_review",
      reason: "document type needs review",
      source: "profile_policy",
      profile_key: profileKey,
      recommended_action: "Classify the document profile before applying approval policy.",
    });
    advisory.blockers.push(issue);
    advisory.advisories.push(issue);
  }

  const requiredFields = asArray(readiness.required_fields);
  const optionalFields = asArray(readiness.optional_fields);
  const allFields = [...requiredFields, ...optionalFields];
  const fieldByKey = new Map(allFields.map((field) => [field?.field_key, field]));

  const missingRequired = requiredFields.filter((field) => field?.status === "missing");
  const missingCritical = missingRequired.filter((field) => isCritical(field?.importance_level));
  advisory.missing_required_fields = missingRequired.map((field) => ({
    field_key: field.field_key,
    importance_level: field.importance_level,
    missing_reason: field.missing_reason,
  }));
  advisory.missing_critical_fields = missingCritical.map((field) => ({
    field_key: field.field_key,
    importance_level: field.importance_level,
    missing_reason: field.missing_reason,
  }));

  for (const field of missingRequired) {
    const item = missingFieldBlocker(field, profileKey);
    advisory.blockers.push(item);
    if (isCritical(field?.importance_level)) advisory.blockers.push({ ...item, blocker_type: "missing_critical_field" });
  }

  const evidenceIssues = requiredFields
    .filter((field) => field?.value_present && field?.status !== "source_backed")
    .map((field) => evidenceBlocker(field, profileKey));
  for (const item of evidenceIssues) advisory.blockers.push(item);
  advisory.evidence_issues = uniqueByKey(evidenceIssues, (item) => `${item.blocker_type}:${item.field_key}:${item.reason}`);

  const readinessDrops = [
    ...asArray(readiness.important_validation_drops),
    ...allFields.map((field) => field?.validation_drop ? { ...field.validation_drop, field_key: field.field_key } : null).filter(Boolean),
  ];
  const validationIssues = uniqueByKey(
    readinessDrops
      .filter((drop) => BLOCKING_VALIDATION_REASONS.has(String(drop?.reason ?? "")))
      .map((drop) => validationBlocker(drop, fieldByKey.get(drop?.field_key) ?? drop, profileKey)),
    (item) => `${item.field_key}:${item.validation_drop_reason}`,
  );
  for (const item of validationIssues) advisory.blockers.push(item);
  advisory.validation_issues = validationIssues;

  const relatedMissing = [
    ...asArray(readiness.important_related_documents_missing),
    ...asArray(readiness.related_document_coverage?.related_documents_missing).map((doc) => ({ document_type: doc, importance_level: "high" })),
    ...asArray(readiness.coverage?.related_document_coverage?.related_documents_missing).map((doc) => ({ document_type: doc, importance_level: "high" })),
  ];
  const relatedIssues = uniqueByKey(relatedMissing.map((issue) => relatedDocumentBlocker(issue, profileKey)), (item) => String(item.reason));
  advisory.related_document_issues = relatedIssues;
  for (const item of relatedIssues) advisory.blockers.push(item);

  const temporal = readiness.temporal_supersession ?? {};
  const temporalRaw = [
    ...asArray(readiness.unresolved_temporal_conflicts),
    ...asArray(temporal.unresolved_temporal_conflicts),
    ...(String(temporal.temporal_status ?? "").includes("blocked") ? [{ reason: temporal.temporal_status }] : []),
    ...asArray(temporal.current_truth_candidates).filter((item) => String(item?.status ?? "").includes("blocked")),
  ];
  const temporalIssues = uniqueByKey(temporalRaw.map((issue) => temporalBlocker(issue, profileKey)), (item) => `${item.blocker_type}:${item.field_key}:${item.reason}`);
  advisory.temporal_issues = temporalIssues;
  for (const item of temporalIssues) advisory.blockers.push(item);

  const coverage = readiness.coverage ?? {};
  const overall = coverage.overall_coverage ?? {};
  const processing = coverage.processing_coverage ?? {};
  const evidence = coverage.evidence_coverage ?? {};
  const expected = coverage.expected_information_coverage ?? {};
  const coverageIssues = [];
  if (LOW_COVERAGE_LEVELS.has(String(overall.coverage_level ?? ""))) {
    coverageIssues.push(coverageBlocker(coverage, `coverage_level:${overall.coverage_level}`));
  }
  if (processing.layout_available === false || processing.page_coverage_percent === 0) {
    coverageIssues.push(coverageBlocker(coverage, "processing_coverage_unavailable"));
  }
  if ((evidence.claims_total ?? 0) > 0 && (evidence.claims_with_evidence ?? 0) === 0) {
    coverageIssues.push(coverageBlocker(coverage, "claims_have_no_evidence"));
  }
  if ((expected.expected_required_fields ?? 0) > 0 && (expected.required_field_coverage_percent ?? 100) <= 25) {
    coverageIssues.push(coverageBlocker(coverage, "required_field_coverage_minimal"));
  }
  advisory.coverage_issues = uniqueByKey(coverageIssues, (item) => item.reason);
  for (const item of advisory.coverage_issues) advisory.blockers.push(item);

  advisory.blockers = uniqueByKey(advisory.blockers, (item) =>
    `${item.blocker_type}:${item.severity}:${item.field_key ?? ""}:${item.reason}`,
  );
  advisory.warnings = [
    ...asArray(readiness.planner_warnings),
    ...asArray(readiness.temporal_supersession?.warnings),
    ...asArray(readiness.coverage?.overall_coverage?.coverage_warnings),
  ];
  advisory.advisories = [
    ...asArray(readiness.advisories),
    ...advisory.blockers.filter((item) => item.severity === "advisory" || item.severity === "informational"),
  ];

  const blockingIfEnforced = advisory.blockers.filter((item) => item.severity === "blocking_if_enforced");
  const needsReview = advisory.blockers.filter((item) => item.severity === "needs_review");
  if (blockingIfEnforced.length > 0) {
    advisory.advisory_status = "advisory_blocked";
    advisory.advisory_reason = "future v3 gate would block approval";
  } else if (needsReview.length > 0 || advisory.coverage_issues.length > 0 || policyKey === "unknown_cre_document") {
    advisory.advisory_status = "advisory_needs_review";
    advisory.advisory_reason = "future v3 gate would require human review";
  } else if (!ADVISORY_STATUSES.has(advisory.advisory_status)) {
    advisory.advisory_status = "advisory_ready";
  }

  advisory.would_block_approval = advisory.advisory_status === "advisory_blocked";
  advisory.would_allow_approval = advisory.advisory_status === "advisory_ready";
  advisory.approval_readiness_summary = {
    required_fields_total: requiredFields.length,
    required_fields_source_backed: requiredFields.filter((field) => field?.status === "source_backed").length,
    required_fields_missing: missingRequired.length,
    required_fields_needs_review: requiredFields.filter((field) => field?.status === "needs_review").length,
    blocker_counts_by_severity: summarizeBlockers(advisory.blockers),
    critical_blockers: blockingIfEnforced.length,
    needs_review_items: needsReview.length,
    advisory_items: advisory.blockers.filter((item) => item.severity === "advisory").length,
    coverage_level: overall.coverage_level ?? "unavailable",
    profile_status: readiness.profile?.status ?? "unclassified",
  };
  advisory.future_gate_inputs = {
    readiness_status: readiness.readiness?.status ?? null,
    readiness_reason: readiness.readiness?.reason ?? null,
    profile: readiness.profile ?? null,
    profile_ensemble: readiness.profile_ensemble ?? null,
    coverage: readiness.coverage ?? null,
    importance_summary: readiness.importance_summary ?? null,
    package_graph_status: readiness.package_graph_status ?? null,
    temporal_status: readiness.temporal_supersession?.temporal_status ?? null,
    related_document_requirements: readiness.related_document_requirements ?? [],
  };

  return advisory;
}
