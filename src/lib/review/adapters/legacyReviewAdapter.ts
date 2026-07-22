// @ts-nocheck
import { getLeaseFieldLabel } from "@/lib/leaseFieldOptions";
import { buildReviewSections, fieldContractByKey } from "../reviewSectionRegistry";
import { normalizeReviewFieldStatus } from "../reviewStatusPresentation";

const FIELD_CONTRACT = fieldContractByKey();

function hasValue(value) {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function readLegacyField(fieldKey, payload) {
  const record = payload?.records?.[0] || payload?.rows?.[0] || payload?.record || {};
  const standard = Array.isArray(record.standard_fields) ? record.standard_fields.find((item) => item?.field_key === fieldKey || item?.key === fieldKey) : null;
  const objectField = record.fields?.[fieldKey] || null;
  return {
    value: objectField?.value ?? record.values?.[fieldKey] ?? standard?.value ?? record[fieldKey] ?? null,
    displayValue: objectField?.display_value ?? objectField?.displayValue ?? standard?.display_value ?? standard?.displayValue ?? null,
    status: objectField?.status ?? standard?.status ?? objectField?.extraction_status ?? standard?.extraction_status ?? null,
    confidence: typeof objectField?.confidence === "number" ? objectField.confidence : typeof standard?.confidence === "number" ? standard.confidence : null,
    evidence: objectField?.evidence ?? standard?.evidence ?? null,
  };
}

function normalizeLegacyEvidence(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((item, index) => ({
    id: String(item?.id ?? item?.evidence_id ?? `legacy-evidence-${index}`),
    pageNumber: typeof item?.page_number === "number" ? item.page_number : typeof item?.source_page === "number" ? item.source_page : typeof item?.page === "number" ? item.page : null,
    text: item?.source_text ?? item?.text ?? null,
    blockIds: Array.isArray(item?.block_ids) ? item.block_ids : Array.isArray(item?.blockIds) ? item.blockIds : [],
    polygonAvailable: Boolean(item?.polygon_available ?? item?.polygonAvailable ?? (Array.isArray(item?.polygon) && item.polygon.length >= 8)),
    clauseCategory: item?.clause_category ?? item?.source_clause_category ?? null,
  }));
}

function coverageFromFields(fields) {
  const values = Object.values(fields);
  const configured = values.length;
  const resolved = values.filter((field) => field.status === "resolved").length;
  const warning = values.filter((field) => field.status === "resolved_with_warning").length;
  const needsReview = values.filter((field) => field.status === "needs_review").length;
  const conflicts = values.filter((field) => field.status === "conflict").length;
  const missing = values.filter((field) => field.status === "missing").length;
  const missingSourceEvidence = values.filter((field) => field.status === "missing_source_evidence").length;
  const invalid = values.filter((field) => field.status === "invalid").length;
  const legacyFallbacks = 0;
  const blocking = values.filter((field) => field.blocking).length;
  return { configured, resolved, warning, needsReview, conflicts, missing, missingSourceEvidence, invalid, legacyFallbacks, blocking, percentage: configured > 0 ? Math.round((resolved / configured) * 100) : 0 };
}

export function adaptLegacyReviewPayload(payload, options = {}) {
  const fields = {};
  for (const [fieldKey, contract] of FIELD_CONTRACT.entries()) {
    const raw = readLegacyField(fieldKey, payload);
    const value = raw.value;
    const status = hasValue(value) ? normalizeReviewFieldStatus(raw.status || "resolved") : normalizeReviewFieldStatus(raw.status || "missing");
    const blocking = Boolean(contract.requiredForApproval && !hasValue(value));
    fields[fieldKey] = {
      key: fieldKey,
      path: `records[0].fields.${fieldKey}.value`,
      label: getLeaseFieldLabel(fieldKey) || fieldKey,
      domain: contract.group || "other_terms",
      value,
      displayValue: raw.displayValue ?? (hasValue(value) ? String(value) : null),
      status,
      source: "legacy",
      confidence: raw.confidence,
      editable: true,
      requiresAttention: status !== "resolved" || blocking,
      blocking,
      reasonCodes: blocking ? ["legacy_missing_required_field"] : [],
      evidence: normalizeLegacyEvidence(raw.evidence),
      conflict: null,
      derivation: null,
      reviewerAction: { state: "none", reason: null },
    };
  }
  const coverage = coverageFromFields(fields);
  const backendReady = payload?.review_readiness === "ready" || payload?.metadata?.review_readiness === "ready" || payload?.core_ready === true;
  return {
    schemaVersion: "review-document-view-model-v1",
    uploadedFileId: options.uploadedFileId || payload?.file_id || payload?.uploaded_file_id || "",
    runId: options.runId || null,
    generationId: options.generationId || payload?.generation_id || null,
    mode: options.mode || "legacy",
    fields,
    sections: buildReviewSections(fields),
    findings: [],
    coverage,
    approval: {
      eligible: Boolean(backendReady),
      blockingCount: coverage.blocking,
      warningCount: coverage.warning,
      conflictCount: coverage.conflicts,
      missingRequiredCount: Object.values(fields).filter((field) => field.blocking).length,
      missingEvidenceCount: coverage.missingSourceEvidence,
      fallbackCount: 0,
      overrideCount: 0,
      reasons: Array.isArray(payload?.review_readiness_reasons) ? payload.review_readiness_reasons : [],
    },
    diagnostics: {
      backendSchemaVersion: payload?.schema_version ? String(payload.schema_version) : "legacy",
      payloadHash: null,
      registryVersion: null,
      fallbackCount: 0,
      stale: Boolean(options.stale),
    },
  };
}
