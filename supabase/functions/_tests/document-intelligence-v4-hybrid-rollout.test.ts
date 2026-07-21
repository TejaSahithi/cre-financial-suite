// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveCanonicalReviewRollout } from "../_shared/extraction/document-intelligence-v3/canonical-review-rollout.ts";
import { buildCanonicalReviewReadinessMetrics } from "../_shared/extraction/document-intelligence-v3/canonical-review-readiness-metrics.ts";
import { buildEnterpriseReviewPayload } from "../_shared/extraction/document-intelligence-v3/enterprise-review-payload.ts";

const env = (values = {}) => ({ get: (key: string) => values[key] });

const REGISTRY = [
  {
    canonicalFieldKey: "tenant_name",
    reviewPath: "records[0].fields.tenant_name.value",
    legacyPaths: ["records[0].fields.tenant_name.value"],
    domain: "parties",
    valueType: "string",
    authority: "canonical_with_legacy_fallback",
    requiredForApproval: true,
    requiredForComputation: false,
    reviewerVisible: true,
    allowLegacyFallback: true,
    allowReviewerOverride: true,
    acceptedProjectionStatuses: ["resolved", "resolved_with_warning"],
    blockingProjectionStatuses: ["conflict", "missing", "missing_source_evidence", "invalid"],
    normalizer: "string",
    formatter: "string",
    validator: "non_blank_present_or_null",
    schemaVersion: "canonical-review-field-registry-v1",
  },
  {
    canonicalFieldKey: "monthly_rent",
    reviewPath: "records[0].fields.monthly_rent.value",
    legacyPaths: ["records[0].fields.monthly_rent.value"],
    domain: "rent",
    valueType: "currency",
    authority: "canonical_with_legacy_fallback",
    requiredForApproval: false,
    requiredForComputation: true,
    reviewerVisible: true,
    allowLegacyFallback: true,
    allowReviewerOverride: true,
    acceptedProjectionStatuses: ["resolved", "resolved_with_warning"],
    blockingProjectionStatuses: ["conflict", "invalid"],
    normalizer: "currency",
    formatter: "currency",
    schemaVersion: "canonical-review-field-registry-v1",
  },
];

function legacyPayload(values = {}) {
  return {
    records: [{
      fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
      values,
      standard_fields: Object.entries(values).map(([field_key, value]) => ({ field_key, value })),
    }],
  };
}

function projectionRow(fieldKey, value, extra = {}) {
  return {
    id: `${fieldKey}-projection`,
    org_id: "org-1",
    uploaded_file_id: "file-1",
    run_id: "run-1",
    generation_id: "gen-1",
    field_key: fieldKey,
    value,
    normalized_value: value,
    status: "auto_populated",
    confidence: 0.94,
    source_claim_ids: [`${fieldKey}-claim`],
    ...extra,
  };
}

Deno.test("Release 4B rollout resolver defaults unknown organizations to legacy", () => {
  const decision = resolveCanonicalReviewRollout({ orgId: "org-1", env: env() });
  assertEquals(decision.mode, "legacy");
  assertEquals(decision.source, "default");
  assertEquals(decision.uiAuthority, "legacy");
  assertEquals(decision.builderSourceMode, "legacy");
  assert(decision.diagnostics.reasonCodes.includes("legacy_default_for_unconfigured_organization"));
});

Deno.test("Release 4B rollout resolver keeps shadow legacy-authoritative while building canonical hybrid", () => {
  const decision = resolveCanonicalReviewRollout({ orgId: "org-1", env: env({ ENABLE_CANONICAL_REVIEW_PAYLOAD_SHADOW: "true" }) });
  assertEquals(decision.mode, "shadow");
  assertEquals(decision.source, "environment");
  assertEquals(decision.uiAuthority, "legacy");
  assertEquals(decision.builderSourceMode, "canonical_hybrid");
});

Deno.test("Release 4B org rollout config overrides environment and permits explicit strict", () => {
  const decision = resolveCanonicalReviewRollout({
    orgId: "org-1",
    organizationConfig: { mode: "canonical_strict", enabled: true },
    env: env({ CANONICAL_REVIEW_ROLLOUT_MODE: "legacy" }),
  });
  assertEquals(decision.mode, "canonical_strict");
  assertEquals(decision.source, "organization_config");
  assertEquals(decision.uiAuthority, "canonical");
  assertEquals(decision.builderSourceMode, "canonical_strict");
});

Deno.test("Release 4B enterprise payload applies active reviewer overrides without mutating projections", async () => {
  const built = await buildEnterpriseReviewPayload({
    orgId: "org-1",
    uploadedFileId: "file-1",
    leaseId: "lease-1",
    run: { id: "run-1", uploaded_file_id: "file-1", lease_id: "lease-1", generation_id: "gen-1" },
    generationId: "gen-1",
    sourceMode: "canonical_hybrid",
    registry: REGISTRY,
    projectionRows: [projectionRow("tenant_name", "Canonical Tenant"), projectionRow("monthly_rent", 2500)],
    evidenceRows: [],
    legacyPayload: legacyPayload({ tenant_name: "Legacy Tenant", monthly_rent: 2500 }),
    activeOverrides: [{
      is_active: true,
      canonical_field_key: "tenant_name",
      action: "overridden",
      override_value: "Reviewer Tenant",
    }],
  });

  assertEquals(built.payload.fields.tenant_name.value, "Reviewer Tenant");
  assertEquals(built.payload.fields.tenant_name.authoritativeSource, "reviewer_override");
  assertEquals(built.payload.fields.tenant_name.review.blocking, false);
  assertEquals(built.payload.validationSummary.overrideCount, 1);
});

Deno.test("Release 4B readiness metrics are derived from backend payload rows", () => {
  const payload = {
    generationId: "gen-1",
    coverage: {
      entries: [
        { canonicalFieldKey: "tenant_name", domain: "parties", coverageStatus: "resolved", requiredForApproval: true, evidencePresent: true },
        { canonicalFieldKey: "monthly_rent", domain: "rent", coverageStatus: "legacy_fallback", requiredForApproval: false, evidencePresent: false, legacyFallbackUsed: true },
        { canonicalFieldKey: "expiration_date", domain: "dates", coverageStatus: "conflict", requiredForApproval: true, evidencePresent: true },
      ],
    },
    findings: [{ severity: "blocking", resolutionStatus: "open" }],
    compatibility: { paritySummary: { comparisons: [{ material: true }] } },
  };
  const metrics = buildCanonicalReviewReadinessMetrics({
    runs: [{ id: "run-1" }],
    payloadRows: [{ payload, payload_hash: "hash-1", generation_id: "gen-1", integrity_violation_count: 2 }],
    overrideRows: [{ id: "override-1" }],
  });

  assertEquals(metrics.totalRuns, 1);
  assertEquals(metrics.payloadBuildSuccessRate, 1);
  assertEquals(metrics.configuredFieldCount, 3);
  assertEquals(metrics.legacyFallbackRate, 1 / 3);
  assertEquals(metrics.conflictRate, 1 / 3);
  assertEquals(metrics.materialMismatchRate, 1 / 3);
  assertEquals(metrics.reviewerOverrideRate, 1 / 3);
  assertEquals(metrics.unresolvedBlockingFindingRate, 1 / 3);
  assertEquals(metrics.crossRunIntegrityViolationCount, 2);
  assertEquals(metrics.byDomain.parties.canonicalCoverageRate, 1);
});

Deno.test("Release 4B clearing a required canonical field blocks approval readiness", async () => {
  const built = await buildEnterpriseReviewPayload({
    orgId: "org-1",
    uploadedFileId: "file-1",
    leaseId: "lease-1",
    run: { id: "run-1", uploaded_file_id: "file-1", lease_id: "lease-1", generation_id: "gen-1" },
    generationId: "gen-1",
    sourceMode: "canonical_hybrid",
    registry: REGISTRY,
    projectionRows: [projectionRow("tenant_name", "Canonical Tenant")],
    evidenceRows: [],
    legacyPayload: legacyPayload({ tenant_name: "Legacy Tenant" }),
    activeOverrides: [{
      is_active: true,
      canonical_field_key: "tenant_name",
      action: "cleared",
    }],
  });

  assertEquals(built.payload.fields.tenant_name.status, "missing");
  assertEquals(built.payload.fields.tenant_name.review.blocking, true);
  assertEquals(built.payload.validationSummary.approvalEligible, false);
  assertEquals(built.payload.validationSummary.missingRequiredCount, 1);
});
