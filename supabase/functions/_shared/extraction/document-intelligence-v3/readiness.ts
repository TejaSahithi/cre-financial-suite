// @ts-nocheck
/**
 * Document Intelligence v3 — Readiness Evaluator (Phase 3)
 *
 * Read-only. Resolves a document_intelligence_runs row (by run_id, or the
 * latest completed run for an uploaded_file_id), reads the durable v3
 * claim/evidence/validation-drop/canonical-field tables Phase 2 wrote, and
 * evaluates them against the profile-aware policy registry
 * (profile-policy.ts). This is diagnostic output only -- every response
 * carries diagnostic_only: true, nothing here writes to the database, and
 * nothing in the current approval path (approve_lease_workflow,
 * LeaseReview.jsx's bulkEvaluation/canApprove) calls this. See
 * docs/lease-extraction-architecture-audit-2026-07-29.md Phase 3 recommendation.
 */

import { getProfilePolicy, resolvePolicyKey } from "./profile-policy.ts";
import { buildExtractionPlan } from "./profile-planner.ts";
import {
  buildCoverageAndImportanceDiagnostics,
  emptyCoverageImportanceDiagnostics,
  scoreFieldImportance,
} from "./coverage-importance.ts";
import {
  buildRelatedDocumentCoverageFromPackageGraph,
  emptyPackageGraph,
  fetchPackageGraphForRun,
} from "./package-graph.ts";
import {
  buildTemporalSupersessionDiagnostics,
  emptyTemporalSupersessionDiagnostics,
} from "./temporal-supersession.ts";
import {
  buildApprovalAdvisoryFromReadiness,
  emptyApprovalAdvisory,
} from "./approval-advisory.ts";
import {
  resolveRun,
  fetchRunClaims,
  fetchClaimEvidence,
  fetchRunValidationDrops,
  fetchRunCanonicalFieldProjections,
} from "./projection-reader.ts";
export const EVIDENCE_SUFFICIENCY_VALUES = [
  "none",
  "text_only",
  "block_anchored",
  "visual_anchored",
  "calculated",
  "cross_reference",
  "insufficient",
] as const;

export type EvidenceSufficiency = typeof EVIDENCE_SUFFICIENCY_VALUES[number];

const VALIDATION_DROP_LIMITING_REASONS = new Set([
  "missing_source_evidence",
  "invalid_markup_value",
  "invalid_signature_date_source",
  "unsupported_inferred_value",
]);

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

export interface EvaluateReadinessInput {
  supabaseAdmin: any;
  orgId: string;
  runId?: string | null;
  uploadedFileId?: string | null;
}

function emptyCounts() {
  return {
    claim_counts: { total: 0, canonical_field: 0, dynamic: 0 },
    evidence_counts: { total: 0 },
    validation_drop_counts: { total: 0, by_reason: {} },
    source_backed_counts: {
      required_total: 0,
      required_source_backed: 0,
      required_missing: 0,
      required_needs_review: 0,
    },
    evidence_sufficiency_counts: emptyEvidenceSufficiencyCounts(),
  };
}

function notAvailableResult(uploadedFileId: string | null, runId: string | null) {
  const counts = emptyCounts();
  const result = {
    diagnostic_only: true,
    available: false,
    run_id: runId,
    uploaded_file_id: uploadedFileId,
    lease_id: null,
    profile: { profile_key: null, policy_key: "unknown_cre_document", confidence: null, status: "not_available" },
    readiness: {
      status: "not_available",
      reason: "no_completed_run",
      note: "No completed Document Intelligence v3 run was found for this document. This is expected when ENABLE_DOCUMENT_INTELLIGENCE_V3 is off, or before the first run completes.",
    },
    blockers: [],
    advisories: [],
    required_fields: [],
    optional_fields: [],
    ...counts,
    coverage_summary: { ...counts.evidence_sufficiency_counts },
    layout_summary: {},
    profile_ensemble: null,
    extraction_plan: null,
    modules_to_run_count: 0,
    modules_skipped_count: 0,
    related_documents_needed: [],
    planner_warnings: [],
    ...emptyCoverageImportanceDiagnostics(),
    package_graph: emptyPackageGraph(),
    related_document_requirements: [],
    candidate_related_documents: [],
    package_graph_status: "not_available",
    temporal_supersession: emptyTemporalSupersessionDiagnostics(),
    document_timeline: [],
    supersession_candidates: [],
    current_truth_candidates: [],
    unresolved_temporal_conflicts: [],
    missing_temporal_inputs: [],
  };
  return {
    ...result,
    approval_advisory: emptyApprovalAdvisory(result),
  };
}

export function isSourceBackedByLegacyEvidence(evidenceRows: any[]): boolean {
  return evidenceRows.some((e) => typeof e?.source_text === "string" && e.source_text.trim().length > 0);
}


function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasSourceText(row: any): boolean {
  return typeof row?.source_text === "string" && row.source_text.trim().length > 0;
}

function hasPage(row: any): boolean {
  return row?.page != null;
}

function supportType(row: any): string {
  return String(row?.support_type ?? "").trim().toLowerCase();
}

function summarizeEvidenceRows(evidenceRows: any[]) {
  const supportTypes = new Set<string>();
  for (const row of evidenceRows) {
    const type = supportType(row);
    if (type) supportTypes.add(type);
  }
  return {
    evidence_rows: evidenceRows.length,
    rows_with_source_text: evidenceRows.filter(hasSourceText).length,
    rows_with_page: evidenceRows.filter(hasPage).length,
    rows_with_block_ids: evidenceRows.filter((row) => hasNonEmptyArray(row?.block_ids)).length,
    rows_with_polygon: evidenceRows.filter((row) => hasNonEmptyArray(row?.polygon)).length,
    support_types: [...supportTypes].sort(),
  };
}

function hasLimitingValidationDrop(drop: any): boolean {
  return !!drop && VALIDATION_DROP_LIMITING_REASONS.has(String(drop.reason ?? ""));
}

function isDroppedClaimEvidence(row: any, limitingDrops: any[]): boolean {
  const droppedClaimIds = limitingDrops
    .map((drop) => drop?.claim_id)
    .filter((id) => id != null)
    .map(String);
  return droppedClaimIds.length > 0 && droppedClaimIds.includes(String(row?.claim_id ?? ""));
}

function validEvidenceRowsForSufficiency(evidenceRows: any[], validationDrops: any[]) {
  const limitingDrops = validationDrops.filter(hasLimitingValidationDrop);
  if (!limitingDrops.length) return evidenceRows;

  const dropsWithClaimId = limitingDrops.filter((drop) => drop?.claim_id != null);
  if (!dropsWithClaimId.length) {
    // A field-level validation drop without a claim_id means the rejected
    // value cannot be tied away from the available evidence. Keep this
    // diagnostic conservative until a future phase has richer graph context.
    return [];
  }

  return evidenceRows.filter((row) => !isDroppedClaimEvidence(row, limitingDrops));
}

export function classifyEvidenceSufficiency(
  evidenceRows: any[] = [],
  validationDrops: any[] = [],
): {
  evidence_sufficiency: EvidenceSufficiency;
  evidence_summary: Record<string, unknown>;
  evidence_warnings: string[];
} {
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];
  const drops = Array.isArray(validationDrops) ? validationDrops : [];
  const evidenceSummary = summarizeEvidenceRows(rows);
  const warnings = new Set<string>();

  if (rows.length === 0) {
    return {
      evidence_sufficiency: "none",
      evidence_summary: evidenceSummary,
      evidence_warnings: [],
    };
  }

  for (const row of rows) {
    const type = supportType(row);
    if (!hasSourceText(row) && type !== "calculated" && type !== "cross_reference" && type !== "multi_source" && type !== "visual") {
      warnings.add("missing_source_text");
    }
    if (hasSourceText(row) && !hasPage(row)) warnings.add("missing_page");
    if (type === "calculated" && !hasSourceText(row)) warnings.add("calculated_without_formula");
    if ((type === "cross_reference" || type === "multi_source") && !row?.document_id && !row?.uploaded_file_id) {
      warnings.add("cross_reference_missing_related_document");
    }
    if (type === "visual" && !hasNonEmptyArray(row?.polygon)) warnings.add("visual_anchor_unavailable");
  }

  const validRows = validEvidenceRowsForSufficiency(rows, drops);
  if (rows.length > 0 && validRows.length === 0) {
    warnings.add("missing_source_text");
    return {
      evidence_sufficiency: "insufficient",
      evidence_summary: evidenceSummary,
      evidence_warnings: [...warnings].sort(),
    };
  }

  const validSummary = summarizeEvidenceRows(validRows);
  const hasVisual = validRows.some((row) =>
    (hasSourceText(row) && hasNonEmptyArray(row?.polygon)) || supportType(row) === "visual"
  );
  const hasBlockAnchored = validRows.some((row) => hasSourceText(row) && hasNonEmptyArray(row?.block_ids));
  const hasCalculated = validRows.some((row) => supportType(row) === "calculated");
  const hasCrossReference = validRows.some((row) => supportType(row) === "cross_reference" || supportType(row) === "multi_source");
  const hasTextOnly = validRows.some((row) => hasSourceText(row));

  let evidenceSufficiency: EvidenceSufficiency = "insufficient";
  if (hasVisual) {
    evidenceSufficiency = "visual_anchored";
  } else if (hasBlockAnchored) {
    evidenceSufficiency = "block_anchored";
  } else if (hasCalculated) {
    evidenceSufficiency = "calculated";
  } else if (hasCrossReference) {
    evidenceSufficiency = "cross_reference";
  } else if (hasTextOnly) {
    evidenceSufficiency = "text_only";
    if (validSummary.rows_with_block_ids === 0 && validSummary.rows_with_polygon === 0) {
      warnings.add("text_only_no_block_anchor");
    }
  } else {
    warnings.add("missing_source_text");
  }

  return {
    evidence_sufficiency: evidenceSufficiency,
    evidence_summary: evidenceSummary,
    evidence_warnings: [...warnings].sort(),
  };
}

export function buildEvidenceSufficiencyCounts(fields: any[] = []) {
  const counts = emptyEvidenceSufficiencyCounts();
  for (const field of Array.isArray(fields) ? fields : []) {
    switch (field?.evidence_sufficiency) {
      case "none":
        counts.fields_with_no_evidence += 1;
        break;
      case "text_only":
        counts.fields_with_text_only_evidence += 1;
        break;
      case "block_anchored":
        counts.fields_with_block_anchored_evidence += 1;
        break;
      case "visual_anchored":
        counts.fields_with_visual_anchored_evidence += 1;
        break;
      case "calculated":
        counts.fields_with_calculated_evidence += 1;
        break;
      case "cross_reference":
        counts.fields_with_cross_reference_evidence += 1;
        break;
      case "insufficient":
      default:
        counts.fields_with_insufficient_evidence += 1;
        break;
    }
  }
  return counts;
}

function evaluateField(
  fieldKey: string,
  opts: {
    required: boolean;
    projectionsByKey: Map<string, any>;
    evidenceByClaimId: Map<string, any[]>;
    dropsByFieldKey: Map<string, any[]>;
  },
) {
  const { required, projectionsByKey, evidenceByClaimId, dropsByFieldKey } = opts;
  const projection = projectionsByKey.get(fieldKey) ?? null;
  const present = !!projection;
  const valuePresent = present && projection.value != null;
  const sourceClaimIds: string[] = present ? (projection.source_claim_ids ?? []) : [];
  const evidenceRows = sourceClaimIds.flatMap((id) => evidenceByClaimId.get(id) ?? []);
  const fieldDrops = dropsByFieldKey.get(fieldKey) ?? [];
  const evidenceGrade = classifyEvidenceSufficiency(evidenceRows, fieldDrops);
  const sourceBacked =
    valuePresent &&
    sourceClaimIds.length > 0 &&
    sourceClaimIds.some((id) => isSourceBackedByLegacyEvidence(evidenceByClaimId.get(id) ?? []));

  let status: "source_backed" | "needs_review" | "missing";
  let missingReason: string | null = null;
  if (!valuePresent) {
    status = "missing";
    missingReason = present ? "value_missing" : "not_attempted";
  } else if (sourceBacked) {
    status = "source_backed";
  } else {
    status = "needs_review";
    missingReason = "missing_source_evidence";
  }

  const drop = fieldDrops[0] ?? null;

  return {
    field_key: fieldKey,
    required,
    present,
    value_present: valuePresent,
    source_backed: sourceBacked,
    status,
    confidence: present ? projection.confidence ?? null : null,
    source_claim_ids: sourceClaimIds,
    validation_status: present ? projection.validation_status ?? "pending" : "pending",
    missing_reason: missingReason,
    validation_drop: drop ? { reason: drop.reason, bad_value: drop.bad_value, action: drop.action } : null,
    ...evidenceGrade,
  };
}

export async function evaluateDocumentIntelligenceV3Readiness(input: EvaluateReadinessInput) {
  const { supabaseAdmin, orgId } = input;
  const runId = input.runId ?? null;
  const uploadedFileId = input.uploadedFileId ?? null;

  const run = await resolveRun({ supabaseAdmin, orgId, runId, uploadedFileId });
  if (!run) {
    return notAvailableResult(uploadedFileId, runId);
  }

  const resolvedRunId = run.id as string;

  const [claims, drops, projections] = await Promise.all([
    fetchRunClaims({ supabaseAdmin, orgId, runId: resolvedRunId }),
    fetchRunValidationDrops({ supabaseAdmin, orgId, runId: resolvedRunId }),
    fetchRunCanonicalFieldProjections({ supabaseAdmin, orgId, runId: resolvedRunId }),
  ]);

  const claimIds = claims.map((c: any) => c.id);
  const evidence = await fetchClaimEvidence({ supabaseAdmin, orgId, claimIds });

  const evidenceByClaimId = new Map<string, any[]>();
  for (const row of evidence) {
    const list = evidenceByClaimId.get(row.claim_id) ?? [];
    list.push(row);
    evidenceByClaimId.set(row.claim_id, list);
  }

  const projectionsByKey = new Map<string, any>();
  for (const row of projections) projectionsByKey.set(row.field_key, row);

  const dropsByFieldKey = new Map<string, any[]>();
  for (const row of drops) {
    if (!row.field_key) continue;
    const list = dropsByFieldKey.get(row.field_key) ?? [];
    list.push(row);
    dropsByFieldKey.set(row.field_key, list);
  }

  const policyKey = resolvePolicyKey(run.profile_key);
  const policy = getProfilePolicy(run.profile_key);
  const persistedCoverage = run.coverage ?? {};
  const fallbackPlan = buildExtractionPlan(policyKey);
  const profileEnsemble = persistedCoverage.profile_ensemble ?? {
    selected_profile_key: run.profile_key ?? null,
    selected_policy_key: policyKey,
    confidence: run.profile_confidence ?? null,
    status: run.profile_status ?? "unclassified",
    candidates: run.profile_key ? [{ profile_key: policyKey, confidence: run.profile_confidence ?? 0, signals: run.profile_signals ?? {}, source: "existing_payload" }] : [],
    signals: run.profile_signals ?? {},
    disagreements: [],
    fallback_reason: policyKey === "unknown_cre_document" ? "no_profile_ensemble_persisted" : null,
    profile_source: run.profile_key ? "existing_payload" : "fallback_unknown",
  };
  const extractionPlan = persistedCoverage.extraction_plan ?? fallbackPlan;

  const requiredFieldKeys = [...policy.required_fields];
  for (const fieldKey of policy.required_if_present_fields) {
    if (projectionsByKey.has(fieldKey)) requiredFieldKeys.push(fieldKey);
  }

  const requiredFields = requiredFieldKeys.map((fieldKey) => {
    const field = evaluateField(fieldKey, { required: true, projectionsByKey, evidenceByClaimId, dropsByFieldKey });
    return { ...field, ...scoreFieldImportance(field, policyKey) };
  });
  const optionalFields = policy.advisory_fields.map((fieldKey) => {
    const field = evaluateField(fieldKey, { required: false, projectionsByKey, evidenceByClaimId, dropsByFieldKey });
    return { ...field, ...scoreFieldImportance(field, policyKey) };
  });
  const allEvaluatedFields = [...requiredFields, ...optionalFields];
  const evidenceSufficiencyCounts = buildEvidenceSufficiencyCounts(allEvaluatedFields);

  const blockers = requiredFields
    .filter((f) => f.status !== "source_backed")
    .map((f) => ({
      field_key: f.field_key,
      reason: f.status === "missing" ? "missing" : "unverified",
      importance_level: f.importance_level,
      importance_score: f.importance_score,
      importance_reasons: f.importance_reasons,
    }));

  const phase10Diagnostics = buildCoverageAndImportanceDiagnostics({
    run,
    policyKey,
    policy,
    claims,
    evidence,
    validationDrops: drops,
    requiredFields,
    optionalFields,
    extractionPlan,
    layoutSummary: run.layout_summary ?? {},
    evidenceSufficiencyCounts,
  });

  const packageGraph = await fetchPackageGraphForRun({
    supabaseAdmin,
    orgId,
    runId: resolvedRunId,
    uploadedFileId: run.uploaded_file_id,
  });
  const graphRelatedDocumentCoverage = buildRelatedDocumentCoverageFromPackageGraph(
    packageGraph,
    phase10Diagnostics.related_document_coverage.related_documents_needed,
  );
  const coverageWithPackageGraph = {
    ...phase10Diagnostics.coverage,
    related_document_coverage: graphRelatedDocumentCoverage,
  };
  const importantRelatedDocumentsMissing = graphRelatedDocumentCoverage.related_documents_missing.map((doc: string) => ({
    document_type: doc,
    importance_level: "high",
    importance_score: 70,
    importance_reasons: ["missing_related_document_dependency", doc === "original_lease" ? "original_lease_required" : "related_document_required"],
  }));
  const temporalSupersession = buildTemporalSupersessionDiagnostics({
    run,
    claims,
    projections,
    packageGraph,
    profileKey: policyKey,
    extractionPlan,
  });

  const advisories = policy.advisory_message
    ? [{ message: policy.advisory_message, fields: policy.advisory_fields, ...(phase10Diagnostics.high_importance_advisories[0] ?? {}) }]
    : [];

  const readinessStatus =
    policy.profile_status === "not_applicable"
      ? "not_applicable"
      : policy.profile_status === "needs_review"
        ? "needs_review"
        : blockers.length > 0
          ? "needs_review"
          : "ready";
  const readinessReason =
    policy.profile_status === "not_applicable"
      ? "profile_not_applicable"
      : policy.profile_status === "needs_review"
        ? "profile_not_classified"
        : blockers.length > 0
          ? "blockers_present"
          : null;

  const canonicalCount = claims.filter((c: any) => c.claim_type === "canonical_field").length;

  const dropsByReason: Record<string, number> = {};
  for (const drop of drops) {
    const reason = drop.reason ?? "unknown";
    dropsByReason[reason] = (dropsByReason[reason] ?? 0) + 1;
  }

  const readinessResult = {
    diagnostic_only: true,
    available: true,
    run_id: resolvedRunId,
    uploaded_file_id: run.uploaded_file_id,
    lease_id: run.lease_id ?? null,
    profile: {
      profile_key: run.profile_key ?? null,
      policy_key: policyKey,
      confidence: run.profile_confidence ?? null,
      status: run.profile_status ?? "unclassified",
    },
    readiness: {
      status: readinessStatus,
      reason: readinessReason,
      note: "Advisory diagnostic only -- does not gate approval. See approve_lease_workflow for the actual approval path.",
    },
    blockers,
    advisories,
    required_fields: requiredFields,
    optional_fields: optionalFields,
    claim_counts: { total: claims.length, canonical_field: canonicalCount, dynamic: claims.length - canonicalCount },
    evidence_counts: { total: evidence.length },
    validation_drop_counts: { total: drops.length, by_reason: dropsByReason },
    source_backed_counts: {
      required_total: requiredFields.length,
      required_source_backed: requiredFields.filter((f) => f.status === "source_backed").length,
      required_missing: requiredFields.filter((f) => f.status === "missing").length,
      required_needs_review: requiredFields.filter((f) => f.status === "needs_review").length,
    },
    evidence_sufficiency_counts: evidenceSufficiencyCounts,
    profile_ensemble: profileEnsemble,
    extraction_plan: extractionPlan,
    modules_to_run_count: extractionPlan?.modules_to_run?.length ?? persistedCoverage.modules_to_run_count ?? 0,
    modules_skipped_count: extractionPlan?.modules_skipped?.length ?? persistedCoverage.modules_skipped_count ?? 0,
    related_documents_needed: extractionPlan?.related_documents_needed ?? persistedCoverage.related_documents_needed ?? [],
    planner_warnings: extractionPlan?.planner_warnings ?? persistedCoverage.planner_warnings ?? [],
    coverage: coverageWithPackageGraph,
    importance_summary: phase10Diagnostics.importance_summary,
    important_missing_fields: phase10Diagnostics.important_missing_fields,
    important_validation_drops: phase10Diagnostics.important_validation_drops,
    unmapped_claims_count: phase10Diagnostics.unmapped_claims_count,
    unmapped_high_importance_claims: phase10Diagnostics.unmapped_high_importance_claims,
    important_related_documents_missing: importantRelatedDocumentsMissing,
    related_document_coverage: graphRelatedDocumentCoverage,
    coverage_summary: { ...persistedCoverage, ...evidenceSufficiencyCounts, package_graph: packageGraph, package_graph_status: packageGraph.graph_status, temporal_supersession: temporalSupersession, temporal_status: temporalSupersession.temporal_status },
    package_graph: packageGraph,
    related_document_requirements: packageGraph.related_document_requirements ?? [],
    candidate_related_documents: packageGraph.candidates ?? [],
    package_graph_status: packageGraph.graph_status ?? "not_available",
    temporal_supersession: temporalSupersession,
    document_timeline: temporalSupersession.document_timeline ?? [],
    supersession_candidates: temporalSupersession.supersession_candidates ?? [],
    current_truth_candidates: temporalSupersession.current_truth_candidates ?? [],
    unresolved_temporal_conflicts: temporalSupersession.unresolved_temporal_conflicts ?? [],
    missing_temporal_inputs: temporalSupersession.missing_temporal_inputs ?? [],
    // Phase 5: the canonical-layout audit summary side-write.ts computed
    // from docling_raw, if any (empty object when unavailable -- never
    // fetched fresh here, matching Phase 5 constraint 6/Task F's "use only
    // data already returned").
    layout_summary: run.layout_summary ?? {},
  };
  return {
    ...readinessResult,
    approval_advisory: buildApprovalAdvisoryFromReadiness(readinessResult),
  };
}
