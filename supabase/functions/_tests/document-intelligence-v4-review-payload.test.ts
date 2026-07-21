// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { validateCanonicalReviewFieldRegistry, buildCoverageInventory } from "../_shared/extraction/document-intelligence-v3/canonical-review-field-registry.ts";
import { buildCanonicalCoverageLedger } from "../_shared/extraction/document-intelligence-v3/canonical-coverage-ledger.ts";
import { projectionRowToReadModel } from "../_shared/extraction/document-intelligence-v3/canonical-projection-contract.ts";
import { buildCanonicalLegacyParity } from "../_shared/extraction/document-intelligence-v3/canonical-review-parity.ts";
import { buildEnterpriseReviewPayload, enterpriseReviewPayloadToLegacyShape } from "../_shared/extraction/document-intelligence-v3/enterprise-review-payload.ts";
import { validateCanonicalReviewPayload } from "../_shared/extraction/document-intelligence-v3/canonical-review-validator.ts";

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

function projection(fieldKey, value, status = "auto_populated", extra = {}) {
  return projectionRowToReadModel({
    id: `${fieldKey}-projection`,
    org_id: "org-1",
    uploaded_file_id: "file-1",
    run_id: "run-1",
    field_key: fieldKey,
    value,
    normalized_value: value,
    status,
    confidence: 0.93,
    source_claim_ids: [`${fieldKey}-claim`],
    ...extra,
  });
}

Deno.test("Release 4 registry validator accepts explicit authority configuration", () => {
  assertEquals(validateCanonicalReviewFieldRegistry(REGISTRY), []);
  const inventory = buildCoverageInventory({ registry: REGISTRY, projectionKeys: ["tenant_name"], evidenceByFieldKey: { tenant_name: 1 } });
  assertEquals(inventory[0].migrationStatus, "ready");
  assertEquals(inventory[1].migrationStatus, "missing_projection");
});

Deno.test("Release 4 coverage ledger preserves distinct missing statuses and fallback", () => {
  const resolved = projection("tenant_name", "Acme LLC", "auto_populated");
  const missingEvidence = projection("monthly_rent", 1000, "auto_populated", { source_claim_ids: [] });
  const ledger = buildCanonicalCoverageLedger({ registry: REGISTRY, projections: [resolved, missingEvidence], legacyPayload: legacyPayload({ monthly_rent: 1000 }), legacyValueResolver: (field, payload) => payload.records[0].fields[field.canonicalFieldKey]?.value, strict: false });

  assertEquals(ledger.entries.find((e) => e.canonicalFieldKey === "tenant_name")?.coverageStatus, "resolved");
  assertEquals(ledger.entries.find((e) => e.canonicalFieldKey === "monthly_rent")?.coverageStatus, "resolved");

  const fallbackLedger = buildCanonicalCoverageLedger({ registry: REGISTRY, projections: [], legacyPayload: legacyPayload({ tenant_name: "Legacy Tenant" }), legacyValueResolver: (field, payload) => payload.records[0].fields[field.canonicalFieldKey]?.value, strict: false });
  assertEquals(fallbackLedger.entries.find((e) => e.canonicalFieldKey === "tenant_name")?.coverageStatus, "legacy_fallback");

  const strictLedger = buildCanonicalCoverageLedger({ registry: REGISTRY, projections: [], legacyPayload: legacyPayload({ tenant_name: "Legacy Tenant" }), legacyValueResolver: (field, payload) => payload.records[0].fields[field.canonicalFieldKey]?.value, strict: true });
  assertEquals(strictLedger.entries.find((e) => e.canonicalFieldKey === "tenant_name")?.coverageStatus, "missing");
  assertEquals(strictLedger.approvalReady, false);
});

Deno.test("Release 4 parity reports exact and normalized equivalence", () => {
  const parity = buildCanonicalLegacyParity({
    registry: REGISTRY,
    projections: [projection("tenant_name", "Acme LLC"), projection("monthly_rent", 2500)],
    legacyPayload: legacyPayload({ tenant_name: " Acme LLC ", monthly_rent: "$2,500.00" }),
    legacyValueResolver: (field, payload) => payload.records[0].fields[field.canonicalFieldKey]?.value,
  });

  assertEquals(parity.comparisons.find((c) => c.canonicalFieldKey === "tenant_name")?.status, "equal");
  assertEquals(parity.comparisons.find((c) => c.canonicalFieldKey === "monthly_rent")?.status, "equivalent_after_normalization");
  assertEquals(parity.readiness.ready, true);
});

Deno.test("Release 4 enterprise payload resolves canonical, fallback, coverage, findings, and hash deterministically", async () => {
  const args = {
    orgId: "org-1",
    uploadedFileId: "file-1",
    leaseId: "lease-1",
    run: { id: "run-1", uploaded_file_id: "file-1", lease_id: "lease-1" },
    sourceMode: "canonical_hybrid",
    registry: REGISTRY,
    projectionRows: [{ id: "tenant_name-projection", org_id: "org-1", uploaded_file_id: "file-1", run_id: "run-1", field_key: "tenant_name", value: "Canonical Tenant", normalized_value: "Canonical Tenant", status: "auto_populated", confidence: 0.91, source_claim_ids: ["claim-1"] }],
    evidenceRows: [{ id: "evidence-1", claim_id: "claim-1", page: 1, block_ids: ["b1"], polygon: [0, 0, 1, 0, 1, 1, 0, 1], source_text: "Tenant: Canonical Tenant" }],
    legacyPayload: legacyPayload({ tenant_name: "Legacy Tenant", monthly_rent: 2500 }),
    canonicalDocument: { layoutHash: "hash-1", layoutSchemaVersion: "canonical-layout-v3", layoutSource: "azure_native", geometryAvailable: true },
  };
  const first = await buildEnterpriseReviewPayload(args);
  const second = await buildEnterpriseReviewPayload(args);

  assertEquals(first.payload.payloadHash, second.payload.payloadHash);
  assertEquals(first.payload.fields.tenant_name.authoritativeSource, "canonical_projection");
  assertEquals(first.payload.fields.monthly_rent.authoritativeSource, "legacy_fallback");
  assertEquals(first.payload.coverage.totals.legacyFallbacks, 1);
  assert(first.payload.findings.some((finding) => finding.type === "legacy_fallback_used"));

  const legacy = enterpriseReviewPayloadToLegacyShape(first.payload);
  assertEquals(legacy.records[0].fields.tenant_name.value, "Canonical Tenant");
});

Deno.test("Release 4 validation blocks strict missing approval fields", async () => {
  const built = await buildEnterpriseReviewPayload({
    orgId: "org-1",
    uploadedFileId: "file-1",
    leaseId: null,
    run: { id: "run-1", uploaded_file_id: "file-1" },
    sourceMode: "canonical_strict",
    registry: REGISTRY,
    projectionRows: [],
    evidenceRows: [],
    legacyPayload: legacyPayload({ tenant_name: "Legacy Tenant" }),
    canonicalDocument: { layoutHash: null, layoutSchemaVersion: null, layoutSource: null, geometryAvailable: false },
  });
  const validation = validateCanonicalReviewPayload({ payload: built.payload, fieldRegistry: REGISTRY, parseQuality: null, evidenceFindings: [] });

  assertEquals(built.payload.fields.tenant_name.status, "missing");
  assertEquals(validation.approvalEligible, false);
  assert(validation.blockingIssues.some((issue) => issue.canonicalFieldKey === "tenant_name"));
});