import { detectDocumentProfile } from "./documentProfile";
import { getFieldContract } from "./leaseFieldContract";
import { REQUIRED_FIELD_KEYS, isMeaningfulValue, readFieldEvidence, readFieldValue } from "./leaseReviewSchema";

const ASSIGNMENT_PROFILE_KEYS = new Set([
  "assignment",
  "lease_assignment",
  "assignment_assumption",
  "assignment_assumption_amendment",
  "assignment_amendment",
  "amendment",
  "consent",
  "estoppel",
]);

const BASE_LEASE_PROFILE_KEYS = new Set(["base_lease", "full_lease", "lease"]);

const ASSIGNMENT_ALWAYS_REQUIRED_KEYS = [
  "assignee_name",
  "assignment_effective_date",
];

const ASSIGNMENT_REQUIRED_IF_PRESENT_KEYS = [
  "landlord_name",
  "assignor_name",
  "original_lease_date",
  "original_lease_reference",
  "assumption_scope",
  "assignment_provisions",
  "all_other_terms_remain_same",
  "amended_base_rent_for_additional_year",
  "tenant_signature_date",
  "landlord_signature_date",
  "tenant_signatory_name",
  "landlord_signatory_name",
];

const ASSIGNMENT_ADVISORY_IF_PRESENT_KEYS = [
  "tenant_name",
  "landlord_consent",
  "landlord_consent_for_transfer",
];

const ORIGINAL_LEASE_REFERENCE_KEYS = [
  "original_lease_date",
  "original_lease_reference",
  "original_lease_name",
  "original_lease_document",
];

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function collectProfileCandidates(lease) {
  const workflow = lease?.extraction_data?.workflow_output || {};
  const workflowRecord = Array.isArray(workflow?.records) ? workflow.records[0] : null;
  const uploadedPayload = lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload || {};
  const uploadedRecord = Array.isArray(uploadedPayload?.records) ? uploadedPayload.records[0] : null;
  const normalizedOutput = lease?.uploaded_files?.normalized_output || lease?.uploaded_file?.normalized_output || lease?.normalized_output || {};

  return [
    lease?.document_profile,
    lease?.document_type,
    lease?.document_subtype,
    lease?.extraction_data?.profile_key,
    lease?.extraction_data?.document_profile?.profile_key,
    lease?.extraction_data?.document_profile?.documentType,
    lease?.extraction_data?.document_profile?.document_type,
    workflow?.profile_key,
    workflow?.document_profile?.profile_key,
    workflow?.document_profile?.documentType,
    workflow?.document_profile?.document_type,
    workflowRecord?.profile_key,
    workflowRecord?.document_profile?.profile_key,
    workflowRecord?.document_profile?.documentType,
    workflowRecord?.document_profile?.document_type,
    uploadedPayload?.profile_key,
    uploadedPayload?.document_subtype,
    uploadedPayload?.metadata?.profile_key,
    uploadedPayload?.metadata?.document_subtype,
    uploadedRecord?.profile_key,
    uploadedRecord?.document_profile?.profile_key,
    uploadedRecord?.document_profile?.documentType,
    uploadedRecord?.document_profile?.document_type,
    normalizedOutput?.profile_key,
    normalizedOutput?.document_subtype,
  ].filter(Boolean);
}

export function normalizeCurrentReviewProfile(profile) {
  const token = normalizeToken(profile);
  if (!token) return "unknown_cre_document";
  if (BASE_LEASE_PROFILE_KEYS.has(token)) return "base_lease";
  if (ASSIGNMENT_PROFILE_KEYS.has(token) || token.includes("assignment")) return "assignment";
  if (token === "unknown" || token === "unknown_cre_document") return "unknown_cre_document";
  return "unknown_cre_document";
}

export function resolveCurrentReviewProfile(lease) {
  const detected = normalizeCurrentReviewProfile(detectDocumentProfile(lease));
  if (detected === "base_lease") return "base_lease";

  for (const candidate of collectProfileCandidates(lease)) {
    const normalized = normalizeCurrentReviewProfile(candidate);
    if (normalized !== "unknown_cre_document") return normalized;
  }

  return detected;
}

function rowHasSignal(row) {
  if (!row) return false;
  if (isMeaningfulValue(row.value ?? row.normalized_value ?? row.normalizedValue)) return true;
  if (isMeaningfulValue(row.source_text ?? row.sourceText ?? row.source_clause ?? row.sourceClause)) return true;
  if (row.source_page || row.sourcePage || row.page_number) return true;
  const status = normalizeToken(row.status ?? row.extraction_status ?? row.review_status);
  return Boolean(status && !["missing", "not_found", "pending"].includes(status));
}

function reviewHasSignal(review) {
  if (!review) return false;
  if (isMeaningfulValue(review.value ?? review.normalized_value ?? review.raw_value)) return true;
  const status = normalizeToken(review.status);
  return Boolean(status && status !== "pending");
}

function buildRowMap(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    for (const key of [row.key, row.field_key, row.fieldKey, row.canonicalKey, row.canonical_key]) {
      if (key && !map.has(key)) map.set(key, row);
    }
  }
  return map;
}

function fieldHasSignal(key, rowMap, fieldReviews, lease) {
  const directValue = readFieldValue(lease, key);
  const directEvidence = readFieldEvidence(lease, key);
  return (
    rowHasSignal(rowMap.get(key)) ||
    reviewHasSignal(fieldReviews?.[key]) ||
    isMeaningfulValue(directValue) ||
    isMeaningfulValue(directEvidence?.sourceText) ||
    Boolean(directEvidence?.sourcePage)
  );
}

function uniqueKeys(keys) {
  return [...new Set(keys.filter(Boolean))];
}

export function getFieldPolicyLabel(key) {
  return getFieldContract(key)?.label || String(key || "").replace(/_/g, " ");
}

export function buildCurrentReviewPolicy(lease, {
  rows = [],
  fieldReviews = {},
  legacyRequiredFieldKeys = REQUIRED_FIELD_KEYS,
} = {}) {
  const profile = resolveCurrentReviewProfile(lease);
  const rowMap = buildRowMap(rows);

  if (profile === "base_lease") {
    return {
      profile,
      policy: "base_lease",
      requiredFieldKeys: uniqueKeys(legacyRequiredFieldKeys),
      advisoryGaps: [],
      applyBaseLeaseBlockers: true,
    };
  }

  if (profile === "assignment") {
    const requiredFieldKeys = [
      ...ASSIGNMENT_ALWAYS_REQUIRED_KEYS,
      ...ASSIGNMENT_REQUIRED_IF_PRESENT_KEYS.filter((key) => fieldHasSignal(key, rowMap, fieldReviews, lease)),
    ];
    const hasOriginalLeaseReference = ORIGINAL_LEASE_REFERENCE_KEYS.some((key) => fieldHasSignal(key, rowMap, fieldReviews, lease));
    const advisoryGaps = [];

    if (!hasOriginalLeaseReference) {
      advisoryGaps.push({
        key: "original_lease_missing",
        title: "Original lease missing",
        detail: "Original lease is needed for full CAM, budget, and current-truth analysis. This is advisory and does not create base-lease field blockers.",
        severity: "advisory",
      });
    }

    for (const key of ASSIGNMENT_ADVISORY_IF_PRESENT_KEYS) {
      if (!fieldHasSignal(key, rowMap, fieldReviews, lease)) continue;
      advisoryGaps.push({
        key: `${key}_assignment_advisory`,
        title: getFieldPolicyLabel(key),
        detail: `${getFieldPolicyLabel(key)} should be reviewed in assignment context but does not create a hard approval blocker.`,
        severity: "needs_review",
      });
    }

    return {
      profile,
      policy: "assignment_document",
      requiredFieldKeys: uniqueKeys(requiredFieldKeys),
      advisoryGaps,
      applyBaseLeaseBlockers: false,
    };
  }

  return {
    profile,
    policy: "unknown_cre_document",
    requiredFieldKeys: [],
    advisoryGaps: [{
      key: "unknown_profile_needs_review",
      title: "Document profile needs review",
      detail: "Unknown CRE document profiles do not inherit base-lease blockers by default.",
      severity: "advisory",
    }],
    applyBaseLeaseBlockers: false,
  };
}
