/**
 * Enterprise Payload Reader
 *
 * Single, safe adapter between the raw enterprise review payload
 * (stored in document_enterprise_review_payloads.payload JSONB) and the
 * rest of the UI. All components receive normalized data from this module;
 * no other file inspects raw enterprise payload paths.
 *
 * KEY ARCHITECTURAL FACTS (discovered from backend source):
 *
 * 1. EnterpriseReviewPayload is stored in the SEPARATE table
 *    `document_enterprise_review_payloads`. It is NOT embedded inside
 *    uploaded_files.ui_review_payload.
 *
 * 2. uploaded_files.ui_review_payload.metadata.enterprise_review_payload
 *    contains ONLY a detection stub: { schema_version, payload_hash,
 *    coverage_summary }. It is used here only to detect whether an enterprise
 *    payload exists for a file so the UI can query the full row.
 *
 * 3. EnterpriseReviewPayload.fields is a Record<string, EnterpriseReviewField>
 *    (object keyed by canonicalFieldKey), but this reader also handles the
 *    case where a serializer emits it as an array.
 *
 * 4. The reader NEVER throws. Every function returns a safe fallback.
 *
 * 5. FEATURE FLAG: when VITE_ENTERPRISE_LEASE_REVIEW !== "true" the reader
 *    returns the null payload regardless of data, so all downstream panels
 *    remain hidden. The flag defaults OFF.
 */

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * Returns true only when the feature flag is explicitly enabled.
 * Defaults to OFF so no enterprise UI renders on environments that have not
 * opted in.
 */
export function isEnterpriseLeaseReviewEnabled() {
  try {
    return (
      typeof import.meta !== "undefined" &&
      import.meta.env?.VITE_ENTERPRISE_LEASE_REVIEW === "true"
    );
  } catch {
    return false;
  }
}

/**
 * Test-only override: calling this in a test sets a module-level override
 * for the feature flag, bypassing import.meta.env which cannot be stubbed
 * reliably from within Vitest module scope.
 * Set to null to restore default behaviour.
 *
 * @param {boolean|null} value
 */
let _featureFlagOverride = null;
export function _setFeatureFlagOverride(value) {
  _featureFlagOverride = value;
}

function _isFlagEnabled() {
  if (_featureFlagOverride !== null) return _featureFlagOverride === true;
  return isEnterpriseLeaseReviewEnabled();
}

// ---------------------------------------------------------------------------
// Detection: does this uploadedFile have an enterprise payload?
// ---------------------------------------------------------------------------

/**
 * Returns true when uploaded_files.ui_review_payload contains an enterprise
 * payload stub, i.e. the backend successfully built and persisted a payload.
 * Does NOT require the full payload to have been fetched yet.
 *
 * @param {object|null|undefined} uploadedFile - row from uploaded_files query
 */
export function hasEnterprisePayloadStub(uploadedFile) {
  try {
    const stub =
      uploadedFile?.ui_review_payload?.metadata?.enterprise_review_payload;
    return (
      stub != null &&
      typeof stub === "object" &&
      typeof stub.schema_version === "string"
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Normalized result type (documented shape, not enforced at runtime)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NormalizedEnterprisePayload
 * @property {string|null}  sourceMode        - "legacy" | "canonical_hybrid" | "canonical_strict" | null
 * @property {string|null}  schemaVersion     - e.g. "enterprise-review-payload-v1"
 * @property {Object}       fieldsByKey       - { [canonicalFieldKey]: NormalizedEnterpriseField }
 * @property {Object|null}  coverage          - CanonicalCoverageLedger or null
 * @property {Array}        findings          - EnterpriseDynamicFinding[], sorted by priority
 * @property {Object|null}  validationSummary - EnterpriseValidationSummary or null
 * @property {Object|null}  canonicalDocument - canonical document metadata or null
 * @property {Object|null}  compatibility     - compatibility block or null
 */

/** Empty, safe normalized payload returned when data is absent or flag is off. */
const NULL_PAYLOAD = Object.freeze({
  sourceMode: null,
  schemaVersion: null,
  fieldsByKey: Object.freeze({}),
  coverage: null,
  findings: Object.freeze([]),
  validationSummary: null,
  canonicalDocument: null,
  compatibility: null,
});

// ---------------------------------------------------------------------------
// Finding sort priority
// ---------------------------------------------------------------------------

const FINDING_PRIORITY = {
  blocking: 0,
  material: 1,
  critical: 2,
  warning: 3,
  informational: 4,
  resolved: 5,
};

function findingSortKey(finding) {
  const severity = String(finding?.severity ?? "informational");
  const resolutionStatus = String(finding?.resolutionStatus ?? "open");
  const basePriority = FINDING_PRIORITY[severity] ?? 4;
  // "resolved" findings always go last regardless of severity.
  return resolutionStatus === "resolved" ? 99 : basePriority;
}

// ---------------------------------------------------------------------------
// Fields normalizer — handles object OR array representation
// ---------------------------------------------------------------------------

/**
 * Normalizes raw payload.fields (which may be a Record<string,...> or an
 * Array<{canonicalFieldKey,...}>) into a stable Record<string, NormalizedEnterpriseField>.
 *
 * @param {unknown} rawFields
 * @returns {Object}
 */
function normalizeFieldsByKey(rawFields) {
  if (!rawFields || typeof rawFields !== "object") return {};

  // Object keyed by fieldKey (canonical shape)
  if (!Array.isArray(rawFields)) {
    const result = {};
    for (const [key, field] of Object.entries(rawFields)) {
      if (!field || typeof field !== "object") continue;
      const canonicalFieldKey = String(
        field.canonicalFieldKey ?? field.canonical_field_key ?? key
      );
      result[canonicalFieldKey] = normalizeField(field);
    }
    return result;
  }

  // Array shape — each item must have a canonicalFieldKey or canonical_field_key
  const result = {};
  for (const field of rawFields) {
    if (!field || typeof field !== "object") continue;
    const canonicalFieldKey = String(
      field.canonicalFieldKey ?? field.canonical_field_key ?? ""
    );
    if (!canonicalFieldKey) continue;
    result[canonicalFieldKey] = normalizeField(field);
  }
  return result;
}

/**
 * Normalizes a single EnterpriseReviewField to a stable shape.
 * Never throws. Unknown enum values are preserved as-is.
 *
 * @param {Object} raw
 * @returns {Object}
 */
function normalizeField(raw) {
  return {
    canonicalFieldKey: String(
      raw.canonicalFieldKey ?? raw.canonical_field_key ?? ""
    ),
    reviewPath: String(raw.reviewPath ?? raw.review_path ?? ""),
    domain: String(raw.domain ?? ""),
    value: raw.value ?? null,
    displayValue: raw.displayValue ?? raw.display_value ?? null,
    status: String(raw.status ?? ""),
    confidence:
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? raw.confidence
        : null,
    authoritativeSource: String(
      raw.authoritativeSource ?? raw.authoritative_source ?? "none"
    ),
    evidence: normalizeEvidenceArray(raw.evidence),
    derivation: normalizeDerivation(raw.derivation ?? raw.derivation_trace),
    conflict: normalizeConflict(raw.conflict),
    review: normalizeReviewMeta(raw.review),
  };
}

/**
 * Normalizes EnterpriseEvidenceReference[].
 * @param {unknown} raw
 * @returns {Array}
 */
function normalizeEvidenceArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((ev) => {
    if (!ev || typeof ev !== "object") return null;
    return {
      evidenceId: ev.evidenceId ?? ev.evidence_id ?? null,
      claimId: ev.claimId ?? ev.claim_id ?? null,
      page:
        typeof ev.page === "number"
          ? ev.page
          : typeof ev.page_number === "number"
          ? ev.page_number
          : null,
      blockIds: Array.isArray(ev.blockIds)
        ? ev.blockIds
        : Array.isArray(ev.block_ids)
        ? ev.block_ids
        : [],
      polygonAvailable:
        ev.polygonAvailable === true ||
        ev.polygon_available === true ||
        (Array.isArray(ev.polygon) && ev.polygon.length >= 8),
      sourceText:
        typeof ev.sourceText === "string"
          ? ev.sourceText
          : typeof ev.source_text === "string"
          ? ev.source_text
          : null,
      sourceClauseCategory:
        ev.sourceClauseCategory ?? ev.source_clause_category ?? null,
      // Additional fields from evidence rows (from fact-mapper.ts)
      section: ev.section ?? null,
      documentId: ev.documentId ?? ev.document_id ?? null,
      documentName: ev.documentName ?? ev.document_name ?? null,
      documentType: ev.documentType ?? ev.document_type ?? null,
      amendmentNumber: ev.amendmentNumber ?? ev.amendment_number ?? null,
    };
  }).filter(Boolean);
}

/**
 * Normalizes CanonicalDerivationTrace.
 * @param {unknown} raw
 * @returns {Object|null}
 */
function normalizeDerivation(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    method: String(raw.method ?? ""),
    inputs:
      raw.inputs && typeof raw.inputs === "object" && !Array.isArray(raw.inputs)
        ? raw.inputs
        : {},
    reasonCodes: Array.isArray(raw.reasonCodes)
      ? raw.reasonCodes.map(String)
      : Array.isArray(raw.reason_codes)
      ? raw.reason_codes.map(String)
      : [],
  };
}

/**
 * Normalizes CanonicalProjectionConflict.
 * @param {unknown} raw
 * @returns {Object|null}
 */
function normalizeConflict(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    conflictId: raw.conflictId ?? raw.conflict_id ?? null,
    selectedCandidateId:
      raw.selectedCandidateId ?? raw.selected_candidate_id ?? null,
    rejectedCandidates: Array.isArray(raw.rejectedCandidates)
      ? raw.rejectedCandidates
      : Array.isArray(raw.rejected_candidates)
      ? raw.rejected_candidates
      : [],
    reasonCodes: Array.isArray(raw.reasonCodes)
      ? raw.reasonCodes.map(String)
      : Array.isArray(raw.reason_codes)
      ? raw.reason_codes.map(String)
      : [],
    summary: raw.summary ?? null,
  };
}

/**
 * Normalizes the field-level review metadata block.
 * @param {unknown} raw
 * @returns {Object}
 */
function normalizeReviewMeta(raw) {
  if (!raw || typeof raw !== "object") {
    return { editable: false, requiresAttention: false, blocking: false, reasonCodes: [] };
  }
  return {
    editable: raw.editable === true,
    requiresAttention: raw.requiresAttention === true || raw.requires_attention === true,
    blocking: raw.blocking === true,
    reasonCodes: Array.isArray(raw.reasonCodes)
      ? raw.reasonCodes.map(String)
      : Array.isArray(raw.reason_codes)
      ? raw.reason_codes.map(String)
      : [],
  };
}

/**
 * Normalizes EnterpriseDynamicFinding and sorts by severity priority.
 * @param {unknown} raw
 * @returns {Array}
 */
function normalizeFindingsArray(raw) {
  if (!Array.isArray(raw)) return [];
  const result = raw
    .filter((f) => f && typeof f === "object")
    .map((f) => ({
      findingId: String(f.findingId ?? f.finding_id ?? ""),
      type: String(f.type ?? ""),
      canonicalFieldKey: f.canonicalFieldKey ?? f.canonical_field_key ?? null,
      domain: f.domain ?? null,
      severity: String(f.severity ?? "informational"),
      title: String(f.title ?? ""),
      summary: String(f.summary ?? ""),
      reasonCodes: Array.isArray(f.reasonCodes)
        ? f.reasonCodes.map(String)
        : Array.isArray(f.reason_codes)
        ? f.reason_codes.map(String)
        : [],
      claimIds: Array.isArray(f.claimIds)
        ? f.claimIds
        : Array.isArray(f.claim_ids)
        ? f.claim_ids
        : [],
      evidenceIds: Array.isArray(f.evidenceIds)
        ? f.evidenceIds
        : Array.isArray(f.evidence_ids)
        ? f.evidence_ids
        : [],
      resolutionStatus: String(f.resolutionStatus ?? f.resolution_status ?? "open"),
      reviewerActionRequired: f.reviewerActionRequired === true || f.reviewer_action_required === true,
    }));

  // Sort: blocking → material → critical → warning → informational → resolved
  return result.sort((a, b) => findingSortKey(a) - findingSortKey(b));
}

/**
 * Normalizes CanonicalCoverageLedger.
 * @param {unknown} raw
 * @returns {Object|null}
 */
function normalizeCoverage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : null;
  return {
    version: String(raw.version ?? ""),
    totals: totals
      ? {
          // Each metric is left as undefined when absent — components must
          // differentiate "unavailable" from "zero" and "complete".
          configured: typeof totals.configured === "number" ? totals.configured : undefined,
          resolved: typeof totals.resolved === "number" ? totals.resolved : undefined,
          needsReview: typeof totals.needsReview === "number" ? totals.needsReview : undefined,
          conflicts: typeof totals.conflicts === "number" ? totals.conflicts : undefined,
          missing: typeof totals.missing === "number" ? totals.missing : undefined,
          missingSourceEvidence:
            typeof totals.missingSourceEvidence === "number"
              ? totals.missingSourceEvidence
              : undefined,
          invalid: typeof totals.invalid === "number" ? totals.invalid : undefined,
          legacyFallbacks:
            typeof totals.legacyFallbacks === "number"
              ? totals.legacyFallbacks
              : undefined,
          blocking: typeof totals.blocking === "number" ? totals.blocking : undefined,
        }
      : null,
    // Explicit booleans only — undefined when not present.
    approvalReady:
      typeof raw.approvalReady === "boolean"
        ? raw.approvalReady
        : typeof raw.approval_ready === "boolean"
        ? raw.approval_ready
        : undefined,
    computationReady:
      typeof raw.computationReady === "boolean"
        ? raw.computationReady
        : typeof raw.computation_ready === "boolean"
        ? raw.computation_ready
        : undefined,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

/**
 * Normalizes EnterpriseValidationSummary.
 * @param {unknown} raw
 * @returns {Object|null}
 */
function normalizeValidationSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    valid: raw.valid === true,
    approvalEligible:
      typeof raw.approvalEligible === "boolean"
        ? raw.approvalEligible
        : typeof raw.approval_eligible === "boolean"
        ? raw.approval_eligible
        : null,
    blockingIssueCount:
      typeof raw.blockingIssueCount === "number"
        ? raw.blockingIssueCount
        : typeof raw.blocking_issue_count === "number"
        ? raw.blocking_issue_count
        : null,
    warningCount:
      typeof raw.warningCount === "number"
        ? raw.warningCount
        : typeof raw.warning_count === "number"
        ? raw.warning_count
        : null,
    reasonCodes: Array.isArray(raw.reasonCodes)
      ? raw.reasonCodes.map(String)
      : Array.isArray(raw.reason_codes)
      ? raw.reason_codes.map(String)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Primary normalization entry point
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw EnterpriseReviewPayload object (the full payload row from
 * document_enterprise_review_payloads) into a stable NormalizedEnterprisePayload.
 *
 * This is the ONLY function that should receive raw payload data. All other
 * functions in this module receive already-normalized data.
 *
 * Returns NULL_PAYLOAD when:
 * - The feature flag is disabled
 * - rawPayload is null / undefined / not an object
 * - rawPayload.schemaVersion is not a string beginning with "enterprise-review-payload"
 *
 * Never throws.
 *
 * @param {unknown} rawPayload - The full payload object from document_enterprise_review_payloads.payload
 * @returns {NormalizedEnterprisePayload}
 */
export function normalizeEnterprisePayload(rawPayload) {
  if (!_isFlagEnabled()) return NULL_PAYLOAD;

  try {
    if (!rawPayload || typeof rawPayload !== "object") return NULL_PAYLOAD;

    const schema = String(rawPayload.schemaVersion ?? rawPayload.schema_version ?? "");
    if (!schema.startsWith("enterprise-review-payload")) {
      if (import.meta.env?.DEV) {
        console.warn("[EnterprisePayloadReader] Unsupported payload schema version:", schema || "(missing)");
      }
      return NULL_PAYLOAD;
    }

    const sourceMode = String(rawPayload.sourceMode ?? rawPayload.source_mode ?? "");
    if (!["legacy", "canonical_hybrid", "canonical_strict"].includes(sourceMode)) {
      if (import.meta.env?.DEV) {
        console.warn("[EnterprisePayloadReader] Unknown sourceMode:", sourceMode || "(missing)");
      }
      // Treat as legacy — do not throw, still return data
    }

    return {
      sourceMode: sourceMode || null,
      schemaVersion: schema || null,
      fieldsByKey: normalizeFieldsByKey(rawPayload.fields),
      coverage: normalizeCoverage(rawPayload.coverage),
      findings: normalizeFindingsArray(rawPayload.findings),
      validationSummary: normalizeValidationSummary(rawPayload.validationSummary ?? rawPayload.validation_summary),
      canonicalDocument:
        rawPayload.canonicalDocument && typeof rawPayload.canonicalDocument === "object"
          ? rawPayload.canonicalDocument
          : null,
      compatibility:
        rawPayload.compatibility && typeof rawPayload.compatibility === "object"
          ? rawPayload.compatibility
          : null,
    };
  } catch {
    // Structural parse failure — degrade silently, never crash the page.
    if (import.meta.env?.DEV) {
      console.warn("[EnterprisePayloadReader] Malformed enterprise payload — degrading to null.");
    }
    return NULL_PAYLOAD;
  }
}

// ---------------------------------------------------------------------------
// Field-level accessors (receive already-normalized payload)
// ---------------------------------------------------------------------------

/**
 * Returns the normalized EnterpriseReviewField for a given fieldKey, or null.
 *
 * @param {NormalizedEnterprisePayload|null} payload
 * @param {string} fieldKey
 * @returns {Object|null}
 */
export function getEnterpriseField(payload, fieldKey) {
  if (!payload || !fieldKey) return null;
  return payload.fieldsByKey?.[fieldKey] ?? null;
}

/**
 * Returns true when the normalized payload is the null/empty payload
 * (i.e. no enterprise data is available).
 *
 * @param {NormalizedEnterprisePayload|null} payload
 * @returns {boolean}
 */
export function isNullPayload(payload) {
  return !payload || payload === NULL_PAYLOAD || payload.schemaVersion === null;
}
