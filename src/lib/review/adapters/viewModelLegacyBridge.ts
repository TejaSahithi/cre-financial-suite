// @ts-nocheck
import { canonicalStatusToReviewStatus } from "../reviewStatusPresentation";

function toLegacyEvidence(evidence = []) {
  return evidence.map((item) => ({
    evidence_id: item.id,
    page: item.pageNumber,
    page_number: item.pageNumber,
    source_text: item.text,
    block_ids: item.blockIds || [],
    polygon_available: Boolean(item.polygonAvailable),
    source_clause_category: item.clauseCategory,
  }));
}

export function reviewDocumentToLegacyReviewPayload(document, basePayload = null) {
  if (!document) return basePayload;

  const values = {};
  const fields = {};
  const fieldEvidence = {};
  const standardFields = Object.values(document.fields || {}).map((field) => {
    const reviewStatus = canonicalStatusToReviewStatus(field.status);
    values[field.key] = field.value;
    fieldEvidence[field.key] = toLegacyEvidence(field.evidence);
    fields[field.key] = {
      value: field.value,
      display_value: field.displayValue,
      confidence: field.confidence,
      status: reviewStatus,
      canonical_status: field.status,
      extraction_status: reviewStatus,
      evidence: toLegacyEvidence(field.evidence),
      authoritative_source: field.source,
      reason_codes: field.reasonCodes,
      blocking: field.blocking,
      requires_attention: field.requiresAttention,
    };
    return {
      field_key: field.key,
      key: field.key,
      label: field.label,
      value: field.value,
      display_value: field.displayValue,
      status: reviewStatus,
      canonical_status: field.status,
      confidence: field.confidence,
      evidence: toLegacyEvidence(field.evidence),
      authoritative_source: field.source,
      editable: field.editable,
      requires_attention: field.requiresAttention,
      blocking: field.blocking,
      reason_codes: field.reasonCodes,
      extraction_mode: field.source === "derived" ? "calculated" : field.source === "reviewer_override" ? "reviewer_entered" : field.source === "legacy_fallback" ? "legacy_fallback" : field.source === "canonical_family_effective" ? "family_effective" : "canonical_projection",
      source_text: field.evidence?.[0]?.text ?? null,
      source_page: field.evidence?.[0]?.pageNumber ?? null,
    };
  });

  const row = {
    row_index: 0,
    record_index: 0,
    values,
    fields,
    field_evidence: fieldEvidence,
    standard_fields: standardFields,
    custom_fields: [],
    missing_required: standardFields.filter((field) => field.blocking).map((field) => field.field_key),
  };

  return {
    ...(basePayload && typeof basePayload === "object" ? basePayload : {}),
    schema_version: 2,
    review_document_view_model_schema_version: document.schemaVersion,
    file_id: document.uploadedFileId,
    module_type: "lease",
    review_status: "pending",
    source_mode: document.mode,
    records: [row],
    rows: [row],
    metadata: {
      ...((basePayload && typeof basePayload === "object" && basePayload.metadata) || {}),
      review_document_view_model: {
        schema_version: document.schemaVersion,
        payload_hash: document.diagnostics?.payloadHash ?? null,
        backend_schema_version: document.diagnostics?.backendSchemaVersion ?? null,
        registry_version: document.diagnostics?.registryVersion ?? null,
        source_mode: document.mode,
        approval_summary: document.approval,
      },
    },
    coverage: document.coverage,
    approval: document.approval,
    findings: document.findings,
    fields_by_key: document.fields,
  };
}

export function shouldBridgeReviewDocumentToLegacyPayload(document) {
  return Boolean(document && ["canonical_hybrid", "canonical_strict"].includes(document.mode));
}