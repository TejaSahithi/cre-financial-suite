// @ts-nocheck
import { getLeaseFieldLabel } from "@/lib/leaseFieldOptions";
import { buildReviewSections, fieldContractByKey } from "../reviewSectionRegistry";
import { normalizeReviewFieldStatus } from "../reviewStatusPresentation";
import { UnsupportedReviewPayloadSchemaError } from "../errors";

const FIELD_CONTRACT = fieldContractByKey();

function hasValue(value) {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function normalizeConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((item, index) => ({
    id: String(item?.evidenceId ?? item?.evidence_id ?? item?.id ?? `evidence-${index}`),
    pageNumber: typeof item?.page === "number" ? item.page : typeof item?.pageNumber === "number" ? item.pageNumber : typeof item?.page_number === "number" ? item.page_number : null,
    text: item?.sourceText ?? item?.source_text ?? item?.text ?? null,
    blockIds: Array.isArray(item?.blockIds) ? item.blockIds : Array.isArray(item?.block_ids) ? item.block_ids : [],
    polygonAvailable: Boolean(item?.polygonAvailable ?? item?.polygon_available ?? (Array.isArray(item?.polygon) && item.polygon.length >= 8)),
    clauseCategory: item?.sourceClauseCategory ?? item?.source_clause_category ?? item?.clauseCategory ?? null,
  }));
}

function normalizeConflict(conflict) {
  if (!conflict || typeof conflict !== "object") return null;
  const rejected = conflict.rejectedCandidateIds ?? conflict.rejected_candidate_ids ?? conflict.rejectedCandidates ?? conflict.rejected_candidates ?? [];
  return {
    selectedCandidateId: conflict.selectedCandidateId ?? conflict.selected_candidate_id ?? null,
    rejectedCandidateIds: Array.isArray(rejected) ? rejected.map((item) => String(item?.id ?? item)).filter(Boolean) : [],
    reasonCodes: Array.isArray(conflict.reasonCodes) ? conflict.reasonCodes : Array.isArray(conflict.reason_codes) ? conflict.reason_codes : [],
    summary: conflict.summary ?? conflict.message ?? null,
  };
}

function reviewerActionFor(field) {
  if (field?.authoritativeSource !== "reviewer_override") return { state: "none", reason: null };
  const action = String(field?.review?.action ?? "overridden");
  const state = action === "accepted" ? "accepted" : action === "cleared" ? "cleared" : action === "marked_not_applicable" ? "not_applicable" : action === "needs_followup" ? "follow_up" : "overridden";
  return { state, reason: field?.review?.reason ?? null };
}

function normalizeSource(source) {
  const normalized = String(source || "none");
  if (["canonical_projection", "legacy", "legacy_fallback", "reviewer_override", "derived", "none"].includes(normalized)) return normalized;
  return "none";
}

function coverageFromPayload(payload, fields) {
  const totals = payload?.coverage?.totals || {};
  const configured = Number(totals.configured ?? Object.keys(fields).length) || 0;
  const resolved = Number(totals.resolved ?? Object.values(fields).filter((field) => field.status === "resolved").length) || 0;
  const warning = Number(totals.warning ?? totals.warnings ?? Object.values(fields).filter((field) => field.status === "resolved_with_warning").length) || 0;
  const needsReview = Number(totals.needsReview ?? totals.needs_review ?? Object.values(fields).filter((field) => field.status === "needs_review").length) || 0;
  const conflicts = Number(totals.conflicts ?? Object.values(fields).filter((field) => field.status === "conflict").length) || 0;
  const missing = Number(totals.missing ?? Object.values(fields).filter((field) => field.status === "missing").length) || 0;
  const missingSourceEvidence = Number(totals.missingSourceEvidence ?? totals.missing_source_evidence ?? Object.values(fields).filter((field) => field.status === "missing_source_evidence").length) || 0;
  const invalid = Number(totals.invalid ?? Object.values(fields).filter((field) => field.status === "invalid").length) || 0;
  const legacyFallbacks = Number(totals.legacyFallbacks ?? totals.legacy_fallbacks ?? Object.values(fields).filter((field) => field.status === "legacy_fallback").length) || 0;
  const blocking = Number(totals.blocking ?? Object.values(fields).filter((field) => field.blocking).length) || 0;
  return {
    configured,
    resolved,
    warning,
    needsReview,
    conflicts,
    missing,
    missingSourceEvidence,
    invalid,
    legacyFallbacks,
    blocking,
    percentage: configured > 0 ? Math.round((resolved / configured) * 100) : 0,
  };
}

function approvalFromPayload(payload, coverage) {
  const summary = payload?.validationSummary || {};
  return {
    eligible: Boolean(summary.approvalEligible ?? payload?.coverage?.approvalReady ?? false),
    blockingCount: Number(summary.blockingIssueCount ?? coverage.blocking) || 0,
    warningCount: Number(summary.warningCount ?? coverage.warning) || 0,
    conflictCount: Number(summary.conflictCount ?? coverage.conflicts) || 0,
    missingRequiredCount: Number(summary.missingRequiredCount ?? 0) || 0,
    missingEvidenceCount: Number(summary.missingEvidenceCount ?? coverage.missingSourceEvidence) || 0,
    fallbackCount: Number(summary.fallbackCount ?? coverage.legacyFallbacks) || 0,
    overrideCount: Number(summary.overrideCount ?? 0) || 0,
    reasons: Array.isArray(summary.reasonCodes) ? summary.reasonCodes : [],
  };
}

function normalizeFinding(finding, index) {
  return {
    id: String(finding?.findingId ?? finding?.id ?? `finding-${index}`),
    type: String(finding?.type ?? "unknown"),
    fieldKey: finding?.canonicalFieldKey ?? finding?.canonical_field_key ?? null,
    domain: finding?.domain ?? null,
    severity: finding?.severity ?? "informational",
    title: finding?.title ?? finding?.type ?? "Review finding",
    summary: finding?.summary ?? null,
    reasonCodes: Array.isArray(finding?.reasonCodes) ? finding.reasonCodes : Array.isArray(finding?.reason_codes) ? finding.reason_codes : [],
    reviewerActionRequired: Boolean(finding?.reviewerActionRequired ?? finding?.reviewer_action_required),
    resolutionStatus: String(finding?.resolutionStatus ?? finding?.resolution_status ?? "open"),
  };
}

function adaptEnterpriseV1(payload, mode = payload?.sourceMode || "canonical_hybrid") {
  const fields = {};
  const rawFields = payload?.fields || {};
  for (const [key, rawField] of Object.entries(rawFields)) {
    const fieldKey = rawField?.canonicalFieldKey ?? rawField?.canonical_field_key ?? key;
    const contract = FIELD_CONTRACT.get(fieldKey) || {};
    const status = normalizeReviewFieldStatus(rawField?.status);
    fields[fieldKey] = {
      key: fieldKey,
      path: rawField?.reviewPath ?? rawField?.review_path ?? contract.canonicalKey ?? fieldKey,
      label: getLeaseFieldLabel(fieldKey) || fieldKey,
      domain: rawField?.domain ?? contract.group ?? "other_terms",
      value: rawField?.value ?? null,
      displayValue: rawField?.displayValue ?? rawField?.display_value ?? (hasValue(rawField?.value) ? String(rawField.value) : null),
      status,
      source: normalizeSource(rawField?.authoritativeSource ?? rawField?.authoritative_source),
      confidence: normalizeConfidence(rawField?.confidence),
      editable: rawField?.review?.editable !== false,
      requiresAttention: Boolean(rawField?.review?.requiresAttention ?? rawField?.review?.requires_attention ?? rawField?.review?.blocking),
      blocking: Boolean(rawField?.review?.blocking),
      reasonCodes: Array.isArray(rawField?.review?.reasonCodes) ? rawField.review.reasonCodes : Array.isArray(rawField?.review?.reason_codes) ? rawField.review.reason_codes : [],
      evidence: normalizeEvidence(rawField?.evidence),
      conflict: normalizeConflict(rawField?.conflict),
      derivation: rawField?.derivation ?? null,
      reviewerAction: reviewerActionFor(rawField),
    };
  }
  const coverage = coverageFromPayload(payload, fields);
  return {
    schemaVersion: "review-document-view-model-v1",
    uploadedFileId: payload?.uploadedFileId ?? payload?.uploaded_file_id ?? "",
    runId: payload?.runId ?? payload?.run_id ?? null,
    generationId: payload?.generationId ?? payload?.generation_id ?? null,
    mode,
    fields,
    sections: buildReviewSections(fields),
    findings: (Array.isArray(payload?.findings) ? payload.findings : []).map(normalizeFinding),
    coverage,
    approval: approvalFromPayload(payload, coverage),
    diagnostics: {
      backendSchemaVersion: payload?.schemaVersion ?? null,
      payloadHash: payload?.payloadHash ?? payload?.payload_hash ?? null,
      registryVersion: payload?.registryVersion ?? payload?.registry_version ?? null,
      fallbackCount: coverage.legacyFallbacks,
      stale: false,
    },
  };
}

export function adaptEnterpriseReviewPayload(payload, options = {}) {
  switch (payload?.schemaVersion) {
    case "enterprise-review-payload-v1":
      return adaptEnterpriseV1(payload, options.mode);
    default:
      throw new UnsupportedReviewPayloadSchemaError(payload?.schemaVersion);
  }
}

export function enterpriseReviewPayloadToLegacyShape(payload) {
  const document = adaptEnterpriseReviewPayload(payload, { mode: payload?.sourceMode || "canonical_hybrid" });
  const values = {};
  const fieldObjects = {};
  const standardFields = Object.values(document.fields).map((field) => {
    values[field.key] = field.value;
    fieldObjects[field.key] = {
      value: field.value,
      confidence: field.confidence,
      status: field.status,
      canonical_status: field.status,
      evidence: field.evidence,
      authoritative_source: field.source,
    };
    return {
      field_key: field.key,
      value: field.value,
      display_value: field.displayValue,
      status: field.status,
      canonical_status: field.status,
      confidence: field.confidence,
      evidence: field.evidence,
      authoritative_source: field.source,
      editable: field.editable,
      requires_attention: field.requiresAttention,
      blocking: field.blocking,
      reason_codes: field.reasonCodes,
    };
  });
  return {
    schema_version: 2,
    review_document_view_model_schema_version: document.schemaVersion,
    file_id: document.uploadedFileId,
    module_type: "lease",
    review_status: "pending",
    source_mode: document.mode,
    records: [{ row_index: 0, record_index: 0, values, fields: fieldObjects, standard_fields: standardFields, custom_fields: [], missing_required: standardFields.filter((field) => field.blocking).map((field) => field.field_key) }],
    rows: [{ row_index: 0, record_index: 0, values, fields: fieldObjects, standard_fields: standardFields, custom_fields: [], missing_required: standardFields.filter((field) => field.blocking).map((field) => field.field_key) }],
    metadata: { review_document_view_model: { schema_version: document.schemaVersion, payload_hash: document.diagnostics.payloadHash, source_mode: document.mode, approval_summary: document.approval } },
  };
}

export function enterpriseReviewPayloadToLeaseReviewViewModel(payload, legacyPayload = null) {
  if (!payload || payload.schemaVersion !== "enterprise-review-payload-v1") {
    return { sourceMode: "legacy", legacyPayload, records: legacyPayload?.records || legacyPayload?.rows || [], fields: {}, canonicalMetadataByField: {}, findings: [], coverage: null, approvalSummary: null, document: null };
  }
  const document = adaptEnterpriseReviewPayload(payload);
  const legacyShape = enterpriseReviewPayloadToLegacyShape(payload);
  return {
    sourceMode: document.mode,
    legacyPayload,
    records: legacyShape.records,
    fields: document.fields,
    canonicalMetadataByField: Object.fromEntries(Object.values(document.fields).map((field) => [field.key, field])),
    findings: document.findings,
    coverage: document.coverage,
    approvalSummary: document.approval,
    document,
  };
}

export function shouldUseEnterpriseReviewPayload(response) {
  return Boolean(response?.enterpriseReviewPayload && ["canonical_hybrid", "canonical_strict"].includes(response?.mode));
}
