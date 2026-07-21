// @ts-nocheck
import { canonicalStatusToReviewStatus, shouldUseCanonicalReviewPayload as shouldUseCanonicalReviewPayloadForMode } from "./reviewStatusPresentation";

export function enterpriseReviewPayloadToLeaseReviewViewModel(payload, legacyPayload = null) {
  if (!payload || payload.schemaVersion !== "enterprise-review-payload-v1") {
    return {
      sourceMode: "legacy",
      legacyPayload,
      records: legacyPayload?.records || legacyPayload?.rows || [],
      fields: {},
      canonicalMetadataByField: {},
      findings: [],
      coverage: null,
      approvalSummary: null,
    };
  }

  const fields = payload.fields || {};
  const values = {};
  const fieldObjects = {};
  const standardFields = Object.values(fields).map((field) => {
    const reviewStatus = canonicalStatusToReviewStatus(field.status);
    values[field.canonicalFieldKey] = field.value;
    fieldObjects[field.canonicalFieldKey] = {
      value: field.value,
      confidence: field.confidence,
      status: reviewStatus,
      canonical_status: field.status,
      evidence: field.evidence,
      authoritative_source: field.authoritativeSource,
    };
    return {
      field_key: field.canonicalFieldKey,
      value: field.value,
      display_value: field.displayValue,
      status: reviewStatus,
      canonical_status: field.status,
      confidence: field.confidence,
      evidence: field.evidence,
      authoritative_source: field.authoritativeSource,
      editable: field.review?.editable !== false,
      requires_attention: Boolean(field.review?.requiresAttention),
      blocking: Boolean(field.review?.blocking),
      reason_codes: field.review?.reasonCodes || [],
    };
  });

  return {
    sourceMode: payload.sourceMode,
    legacyPayload,
    records: [{
      row_index: 0,
      record_index: 0,
      values,
      fields: fieldObjects,
      standard_fields: standardFields,
      custom_fields: [],
      missing_required: standardFields.filter((field) => field.blocking).map((field) => field.field_key),
    }],
    fields,
    canonicalMetadataByField: Object.fromEntries(Object.values(fields).map((field) => [field.canonicalFieldKey, {
      status: field.status,
      confidence: field.confidence,
      evidence: field.evidence,
      derivation: field.derivation,
      conflict: field.conflict,
      authoritativeSource: field.authoritativeSource,
      review: field.review,
    }])),
    findings: payload.findings || [],
    coverage: payload.coverage || null,
    approvalSummary: {
      approvalEligible: payload.validationSummary?.approvalEligible ?? false,
      blockingIssueCount: payload.validationSummary?.blockingIssueCount ?? 0,
      legacyFallbackCount: payload.compatibility?.fallbackFieldCount ?? 0,
      coverageReady: payload.coverage?.approvalReady ?? false,
      unresolvedConflictCount: payload.unresolvedConflicts?.length ?? 0,
      overrideCount: payload.validationSummary?.overrideCount ?? 0,
    },
  };
}

export function shouldUseEnterpriseReviewPayload(response) {
  return shouldUseCanonicalReviewPayloadForMode(response);
}
