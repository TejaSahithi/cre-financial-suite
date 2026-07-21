/**
 * Unit tests for enterprisePayloadReader.js
 *
 * Covers all required cases from the spec:
 *   - enterprise payload stub detection (hasEnterprisePayloadStub)
 *   - enterprise payload at the root (normalizeEnterprisePayload)
 *   - fields as an object (keyed by fieldKey)
 *   - fields as an array (with canonicalFieldKey property)
 *   - missing enterprise payload
 *   - malformed payload
 *   - missing coverage
 *   - empty findings
 *   - unknown sourceMode
 *   - legacy payload (sourceMode === "legacy")
 *
 * Feature flag is controlled via _setFeatureFlagOverride so tests are
 * independent of import.meta.env (which cannot be stubbed reliably inside
 * the Vitest module scope for static import.meta.env reads).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeEnterprisePayload,
  hasEnterprisePayloadStub,
  getEnterpriseField,
  isNullPayload,
  _setFeatureFlagOverride,
} from "@/lib/enterprisePayloadReader";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MINIMAL_FIELDS_OBJECT = {
  monthly_rent: {
    canonicalFieldKey: "monthly_rent",
    reviewPath: "records[0].fields.monthly_rent.value",
    domain: "rent",
    value: 20000,
    displayValue: "20000",
    status: "resolved",
    confidence: 0.97,
    authoritativeSource: "canonical_projection",
    evidence: [
      {
        evidenceId: "ev-1",
        claimId: "claim-1",
        page: 4,
        blockIds: ["block-a"],
        polygonAvailable: true,
        sourceText: "Monthly rent shall be $20,000.",
        sourceClauseCategory: "rent_clause",
      },
    ],
    derivation: null,
    conflict: null,
    review: { editable: true, requiresAttention: false, blocking: false, reasonCodes: [] },
  },
};

const MINIMAL_FIELDS_ARRAY = [
  {
    canonicalFieldKey: "monthly_rent",
    domain: "rent",
    value: 20000,
    status: "resolved",
    confidence: 0.97,
    authoritativeSource: "canonical_projection",
    evidence: [],
    derivation: null,
    conflict: null,
    review: { editable: true, requiresAttention: false, blocking: false, reasonCodes: [] },
  },
];

const COVERAGE_OBJECT = {
  version: "canonical-coverage-ledger-v1",
  totals: {
    configured: 40,
    resolved: 32,
    needsReview: 3,
    conflicts: 1,
    missing: 2,
    missingSourceEvidence: 1,
    invalid: 0,
    legacyFallbacks: 1,
    blocking: 3,
  },
  approvalReady: false,
  computationReady: true,
  entries: [],
};

const VALIDATION_SUMMARY = {
  valid: false,
  approvalEligible: false,
  blockingIssueCount: 3,
  warningCount: 2,
  reasonCodes: ["missing_required_field", "conflict"],
};

const FINDING_BLOCKING = {
  findingId: "projection_conflict:monthly_rent",
  type: "projection_conflict",
  canonicalFieldKey: "monthly_rent",
  domain: "rent",
  severity: "blocking",
  title: "Projection conflict",
  summary: "monthly_rent has unresolved canonical candidates.",
  reasonCodes: ["conflict"],
  claimIds: ["claim-1"],
  evidenceIds: ["ev-1"],
  resolutionStatus: "open",
  reviewerActionRequired: true,
};

const FINDING_WARNING = {
  findingId: "low_confidence_projection:tenant_name",
  type: "low_confidence_projection",
  canonicalFieldKey: "tenant_name",
  domain: "parties",
  severity: "warning",
  title: "Low confidence projection",
  summary: "tenant_name has low canonical confidence.",
  reasonCodes: ["low_confidence_projection"],
  claimIds: [],
  evidenceIds: [],
  resolutionStatus: "open",
  reviewerActionRequired: false,
};

function makeFullPayload(overrides = {}) {
  return {
    schemaVersion: "enterprise-review-payload-v1",
    uploadedFileId: "file-123",
    leaseId: "lease-456",
    orgId: "org-789",
    runId: "run-001",
    generationId: null,
    sourceMode: "canonical_hybrid",
    canonicalDocument: {
      layoutHash: "abc123",
      layoutSchemaVersion: "v1",
      layoutSource: "azure_native",
      geometryAvailable: true,
    },
    fields: MINIMAL_FIELDS_OBJECT,
    coverage: COVERAGE_OBJECT,
    findings: [FINDING_BLOCKING, FINDING_WARNING],
    unresolvedConflicts: [],
    validationSummary: VALIDATION_SUMMARY,
    compatibility: {
      legacyPayloadAvailable: true,
      fallbackFieldCount: 1,
      paritySummary: null,
    },
    payloadHash: "deadbeef",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enterprisePayloadReader", () => {
  beforeEach(() => {
    // Enable flag by default for all tests in this suite.
    _setFeatureFlagOverride(true);
  });

  afterEach(() => {
    // Restore to default (reads real import.meta.env).
    _setFeatureFlagOverride(null);
  });

  // ── Feature flag ──────────────────────────────────────────────────────────
  it("returns null payload when feature flag is disabled", () => {
    _setFeatureFlagOverride(false);
    const result = normalizeEnterprisePayload(makeFullPayload());
    expect(isNullPayload(result)).toBe(true);
    expect(result.schemaVersion).toBe(null);
    expect(result.findings).toHaveLength(0);
  });

  // ── hasEnterprisePayloadStub (ui_review_payload metadata detection) ───────
  it("detects enterprise payload stub in ui_review_payload metadata", () => {
    const file = {
      ui_review_payload: {
        metadata: {
          enterprise_review_payload: {
            schema_version: "enterprise-review-payload-v1",
            payload_hash: "abc",
            coverage_summary: { resolved: 10 },
          },
        },
      },
    };
    expect(hasEnterprisePayloadStub(file)).toBe(true);
  });

  it("returns false for stub detection when ui_review_payload has no enterprise key", () => {
    expect(hasEnterprisePayloadStub({ ui_review_payload: { metadata: {} } })).toBe(false);
    expect(hasEnterprisePayloadStub(null)).toBe(false);
    expect(hasEnterprisePayloadStub({})).toBe(false);
  });

  // ── normalizeEnterprisePayload: missing / null ────────────────────────────
  it("returns null payload for null input", () => {
    expect(isNullPayload(normalizeEnterprisePayload(null))).toBe(true);
    expect(isNullPayload(normalizeEnterprisePayload(undefined))).toBe(true);
    expect(isNullPayload(normalizeEnterprisePayload("not-an-object"))).toBe(true);
  });

  it("returns null payload for malformed payload (wrong schema version)", () => {
    const result = normalizeEnterprisePayload({ schemaVersion: "legacy-v1", fields: {} });
    expect(isNullPayload(result)).toBe(true);
  });

  it("returns null payload for missing schemaVersion", () => {
    expect(isNullPayload(normalizeEnterprisePayload({}))).toBe(true);
  });

  it("does not throw for a malformed fields object inside a valid payload", () => {
    const payload = makeFullPayload({ fields: { monthly_rent: null } });
    expect(() => normalizeEnterprisePayload(payload)).not.toThrow();
  });

  it("does not throw for completely malformed input object", () => {
    expect(() =>
      normalizeEnterprisePayload({
        schemaVersion: "enterprise-review-payload-v1",
        fields: "invalid",
        coverage: 42,
        findings: "no",
      })
    ).not.toThrow();
  });

  // ── fields as an object ──────────────────────────────────────────────────
  it("normalizes fields when represented as an object keyed by fieldKey", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ fields: MINIMAL_FIELDS_OBJECT }));
    expect(result.fieldsByKey).toHaveProperty("monthly_rent");
    expect(result.fieldsByKey.monthly_rent.value).toBe(20000);
    expect(result.fieldsByKey.monthly_rent.status).toBe("resolved");
    expect(result.fieldsByKey.monthly_rent.confidence).toBe(0.97);
    expect(result.fieldsByKey.monthly_rent.authoritativeSource).toBe("canonical_projection");
  });

  // ── fields as an array ───────────────────────────────────────────────────
  it("normalizes fields when represented as an array with canonicalFieldKey properties", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ fields: MINIMAL_FIELDS_ARRAY }));
    expect(result.fieldsByKey).toHaveProperty("monthly_rent");
    expect(result.fieldsByKey.monthly_rent.value).toBe(20000);
  });

  it("skips array items without a canonicalFieldKey", () => {
    const arrayWithGarbage = [
      { value: 99 }, // no canonicalFieldKey
      {
        canonicalFieldKey: "annual_rent",
        value: 240000,
        status: "resolved",
        evidence: [],
        review: {},
      },
    ];
    const result = normalizeEnterprisePayload(makeFullPayload({ fields: arrayWithGarbage }));
    expect(Object.keys(result.fieldsByKey)).toEqual(["annual_rent"]);
  });

  // ── evidence references ──────────────────────────────────────────────────
  it("normalizes evidence references inside a field", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ fields: MINIMAL_FIELDS_OBJECT }));
    const ev = result.fieldsByKey.monthly_rent.evidence[0];
    expect(ev.evidenceId).toBe("ev-1");
    expect(ev.page).toBe(4);
    expect(ev.polygonAvailable).toBe(true);
    expect(ev.sourceText).toBe("Monthly rent shall be $20,000.");
    expect(ev.sourceClauseCategory).toBe("rent_clause");
  });

  it("returns empty evidence array when evidence is missing from field", () => {
    const fields = {
      lease_date: { canonicalFieldKey: "lease_date", status: "resolved", value: "2024-01-01" },
    };
    const result = normalizeEnterprisePayload(makeFullPayload({ fields }));
    expect(result.fieldsByKey.lease_date.evidence).toEqual([]);
  });

  // ── conflict ─────────────────────────────────────────────────────────────
  it("normalizes conflict on a field", () => {
    const conflictField = {
      canonicalFieldKey: "monthly_rent",
      value: 20000,
      status: "conflict",
      evidence: [],
      conflict: {
        conflictId: "conflict-1",
        selectedCandidateId: null,
        rejectedCandidates: [
          { value: 25000, confidence: 0.7, reasonCodes: ["lower_confidence"] },
        ],
        reasonCodes: ["multiple_canonical_candidates"],
        summary: "Two projection candidates disagree.",
      },
      review: { blocking: true, reasonCodes: ["conflict"] },
    };
    const result = normalizeEnterprisePayload(
      makeFullPayload({ fields: { monthly_rent: conflictField } })
    );
    const conflict = result.fieldsByKey.monthly_rent.conflict;
    expect(conflict).not.toBeNull();
    expect(conflict.summary).toBe("Two projection candidates disagree.");
    expect(conflict.reasonCodes).toContain("multiple_canonical_candidates");
  });

  // ── derivation ───────────────────────────────────────────────────────────
  it("normalizes derivation trace on a field", () => {
    const derivedField = {
      canonicalFieldKey: "annual_rent",
      value: 240000,
      status: "resolved",
      evidence: [],
      derivation: {
        method: "monthly_x_12",
        inputs: { monthly_rent: 20000 },
        reasonCodes: ["derived_from_monthly"],
      },
      conflict: null,
      review: {},
    };
    const result = normalizeEnterprisePayload(
      makeFullPayload({ fields: { annual_rent: derivedField } })
    );
    const derivation = result.fieldsByKey.annual_rent.derivation;
    expect(derivation).not.toBeNull();
    expect(derivation.method).toBe("monthly_x_12");
    expect(derivation.inputs.monthly_rent).toBe(20000);
    expect(derivation.reasonCodes).toContain("derived_from_monthly");
  });

  // ── coverage ─────────────────────────────────────────────────────────────
  it("normalizes coverage totals", () => {
    const result = normalizeEnterprisePayload(makeFullPayload());
    expect(result.coverage.totals.resolved).toBe(32);
    expect(result.coverage.totals.blocking).toBe(3);
    expect(result.coverage.approvalReady).toBe(false);
  });

  it("returns null coverage when coverage key is missing", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ coverage: null }));
    expect(result.coverage).toBeNull();
  });

  it("returns null totals when coverage has no totals key", () => {
    const result = normalizeEnterprisePayload(
      makeFullPayload({ coverage: { version: "v1", entries: [] } })
    );
    expect(result.coverage.totals).toBeNull();
  });

  it("preserves undefined metric when a coverage total metric is absent", () => {
    const partialCoverage = { ...COVERAGE_OBJECT, totals: { resolved: 10 } };
    const result = normalizeEnterprisePayload(makeFullPayload({ coverage: partialCoverage }));
    expect(result.coverage.totals.resolved).toBe(10);
    expect(result.coverage.totals.configured).toBeUndefined();
  });

  // ── findings ─────────────────────────────────────────────────────────────
  it("returns empty findings array when findings is missing", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ findings: undefined }));
    expect(result.findings).toEqual([]);
  });

  it("sorts findings: blocking before warning", () => {
    // Deliberately provide warning first, blocking second.
    const result = normalizeEnterprisePayload(
      makeFullPayload({ findings: [FINDING_WARNING, FINDING_BLOCKING] })
    );
    expect(result.findings[0].severity).toBe("blocking");
    expect(result.findings[1].severity).toBe("warning");
  });

  it("normalizes finding fields correctly", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ findings: [FINDING_BLOCKING] }));
    const f = result.findings[0];
    expect(f.findingId).toBe("projection_conflict:monthly_rent");
    expect(f.type).toBe("projection_conflict");
    expect(f.canonicalFieldKey).toBe("monthly_rent");
    expect(f.reviewerActionRequired).toBe(true);
    expect(f.resolutionStatus).toBe("open");
  });

  // ── unknown sourceMode ───────────────────────────────────────────────────
  it("still returns data for unknown sourceMode (does not throw or return null)", () => {
    // Unknown source mode: should warn in DEV but still parse the payload.
    const result = normalizeEnterprisePayload(
      makeFullPayload({ sourceMode: "unknown_future_mode" })
    );
    // schemaVersion is valid, so we should get real data back.
    expect(isNullPayload(result)).toBe(false);
    expect(result.sourceMode).toBe("unknown_future_mode");
  });

  // ── legacy payload ───────────────────────────────────────────────────────
  it("normalizes a legacy sourceMode payload without errors", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ sourceMode: "legacy" }));
    expect(isNullPayload(result)).toBe(false);
    expect(result.sourceMode).toBe("legacy");
  });

  // ── validationSummary ────────────────────────────────────────────────────
  it("normalizes validationSummary correctly", () => {
    const result = normalizeEnterprisePayload(makeFullPayload());
    expect(result.validationSummary.approvalEligible).toBe(false);
    expect(result.validationSummary.blockingIssueCount).toBe(3);
    expect(result.validationSummary.reasonCodes).toContain("conflict");
  });

  it("returns null validationSummary when missing", () => {
    const result = normalizeEnterprisePayload(makeFullPayload({ validationSummary: null }));
    expect(result.validationSummary).toBeNull();
  });

  // ── getEnterpriseField ───────────────────────────────────────────────────
  it("getEnterpriseField returns normalized field for known key", () => {
    const payload = normalizeEnterprisePayload(makeFullPayload());
    const field = getEnterpriseField(payload, "monthly_rent");
    expect(field).not.toBeNull();
    expect(field.value).toBe(20000);
  });

  it("getEnterpriseField returns null for unknown key", () => {
    const payload = normalizeEnterprisePayload(makeFullPayload());
    expect(getEnterpriseField(payload, "nonexistent_field")).toBeNull();
  });

  it("getEnterpriseField returns null when payload is null", () => {
    expect(getEnterpriseField(null, "monthly_rent")).toBeNull();
  });

  // ── isNullPayload ────────────────────────────────────────────────────────
  it("isNullPayload returns true for null and undefined", () => {
    expect(isNullPayload(null)).toBe(true);
    expect(isNullPayload(undefined)).toBe(true);
  });

  it("isNullPayload returns true when flag is disabled", () => {
    _setFeatureFlagOverride(false);
    const result = normalizeEnterprisePayload(makeFullPayload());
    expect(isNullPayload(result)).toBe(true);
  });

  it("isNullPayload returns false for a valid normalized payload", () => {
    const result = normalizeEnterprisePayload(makeFullPayload());
    expect(isNullPayload(result)).toBe(false);
  });

  // ── camelCase ↔ snake_case tolerance ────────────────────────────────────
  it("accepts snake_case field keys from alternate serializers", () => {
    const snakeCaseField = {
      canonical_field_key: "monthly_rent",
      domain: "rent",
      value: 18000,
      status: "resolved",
      confidence: null,
      authoritative_source: "legacy_fallback",
      evidence: [],
      review: { editable: true, requires_attention: false, blocking: false, reason_codes: [] },
    };
    const result = normalizeEnterprisePayload(
      makeFullPayload({ fields: { monthly_rent: snakeCaseField } })
    );
    expect(result.fieldsByKey.monthly_rent.value).toBe(18000);
    expect(result.fieldsByKey.monthly_rent.authoritativeSource).toBe("legacy_fallback");
  });
});
