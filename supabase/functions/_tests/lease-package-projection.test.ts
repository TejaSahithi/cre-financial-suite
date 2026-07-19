// @ts-nocheck
// P3.6 -- package-effective claims to compatibility projection.

import { assert, assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildFieldProjection } from "../_shared/extraction/claims/adapters/claims-to-field-projection.ts";
import { buildCompatibilityExtractionDataSlice } from "../_shared/extraction/claims/adapters/compatibility-payload-builder.ts";
import { CLAIM_CONCEPTS } from "../_shared/extraction/claims/concept-registry.ts";
import { buildPackageCompatibilityProjection } from "../_shared/extraction/document-package/projection/package-projection-service.ts";
import { diffPackageCompatibilityFields, summarizePackageDiff } from "../_shared/extraction/document-package/projection/package-projection-diff.ts";
import { validatePackageProjectionInput } from "../_shared/extraction/document-package/projection/package-projection-validator.ts";

const ORG = "org-1";
const PACKAGE = "pkg-1";
const RUN = "run-1";
const GEN = "gen-1";

function fieldGroupMap(): Map<string, string> {
  return new Map(CLAIM_CONCEPTS.map((concept) => [concept.conceptKey, concept.domain]));
}

function doc(id: string, profileKey = "base_lease") {
  return {
    id,
    orgId: ORG,
    packageId: PACKAGE,
    uploadedFileId: `file-${id}`,
    extractionRunId: RUN,
    generationId: GEN,
    activeGenerationId: GEN,
    profileKey,
    membershipRole: profileKey === "base_lease" ? "primary_base_document" : "supporting_document",
    membershipStatus: "confirmed",
  };
}

function claim(id: string, packageDocumentId: string, conceptKey: string, normalizedValue: string | null, overrides = {}) {
  return {
    id,
    orgId: ORG,
    packageDocumentId,
    uploadedFileId: `file-${packageDocumentId}`,
    extractionRunId: RUN,
    generationId: GEN,
    conceptKey,
    scopeKey: "lease",
    instanceKey: "default",
    assertionStatus: normalizedValue === null ? "not_present" : "asserted",
    normalizedValue,
    rawValueText: normalizedValue,
    sourcePage: 2,
    sourceText: `${conceptKey}: ${normalizedValue}`,
    confidence: 90,
    hasEvidence: true,
    producerType: "deterministic_mapper",
    createdAt: "2026-01-01T00:00:00.000Z",
    registryStatus: conceptKey.startsWith("dynamic.") ? "unregistered" : "registered",
    ...overrides,
  };
}

function effective(conceptKey: string, selectedClaimId: string, overrides = {}) {
  return {
    conceptKey,
    scopeKey: "lease",
    instanceKey: "default",
    status: "effective",
    selectedClaimId,
    sourcePackageDocumentId: "base",
    precedenceRule: "base_document_source_claim",
    reasonCodes: ["BASE_CLAIM_EFFECTIVE"],
    relationshipPath: [],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    orgId: ORG,
    packageId: PACKAGE,
    leaseId: "lease-1",
    resolutionRun: { id: "res-run-1", orgId: ORG, packageId: PACKAGE, leaseId: "lease-1", status: "completed" },
    documents: [doc("base")],
    sourceClaims: [claim("base-tenant", "base", "tenant_name", "Old Tenant LLC")],
    effectiveClaims: [effective("tenant_name", "base-tenant")],
    conflicts: [],
    requirements: [],
    ...overrides,
  };
}

Deno.test("1/2/3/4/5: package-only base lease reuses P2 projection and preserves compatibility shape/order", () => {
  const baseClaim = claim("base-rent", "base", "monthly_rent", "6004.00");
  const p2Projection = buildFieldProjection({
    claims: [{
      claimId: baseClaim.id,
      conceptKey: baseClaim.conceptKey,
      scopeKey: "lease",
      instanceKey: "default",
      producerType: baseClaim.producerType,
      assertionStatus: baseClaim.assertionStatus,
      normalizedValue: baseClaim.normalizedValue,
      rawValueText: baseClaim.rawValueText,
      sourcePage: baseClaim.sourcePage,
      sourceText: baseClaim.sourceText,
      confidence: baseClaim.confidence,
      hasEvidence: true,
      createdAt: baseClaim.createdAt,
    }],
    reviewDecisionsByFactSlot: new Map(),
    openConflictFactSlots: new Set(),
  });
  const p2Slice = buildCompatibilityExtractionDataSlice(p2Projection, fieldGroupMap());

  const pkg = buildPackageCompatibilityProjection(input({
    sourceClaims: [baseClaim],
    effectiveClaims: [effective("monthly_rent", "base-rent")],
  }));

  assertEquals(pkg.compatibilitySlice.fields.monthly_rent, p2Slice.fields.monthly_rent);
  assertEquals(pkg.compatibilitySlice.fields, pkg.compatibilitySlice.field_evidence);
  assertEquals(pkg.compatibilitySlice.confidence_scores.monthly_rent, 90);
  assertEquals(Object.keys(pkg.compatibilitySlice.fields), ["monthly_rent"]);
});

Deno.test("6/7/8/9/10/11/12/13/14/15: inherited terms and assignment party changes project without erasing base economics", () => {
  const claims = [
    claim("old-tenant", "base", "tenant_name", "Old Tenant LLC"),
    claim("base-rent", "base", "monthly_rent", "1000.00"),
    claim("base-cam", "base", "cam_amount", "250.00"),
    claim("new-tenant", "assignment", "tenant_name", "New Tenant LLC", { sourcePage: 4, sourceText: "Assignee: New Tenant LLC" }),
  ];
  const pkg = buildPackageCompatibilityProjection(input({
    documents: [doc("base"), doc("assignment", "lease_assignment")],
    sourceClaims: claims,
    effectiveClaims: [
      effective("tenant_name", "new-tenant", {
        status: "effective",
        baseClaimId: "old-tenant",
        overridingClaimId: "new-tenant",
        sourcePackageDocumentId: "assignment",
        sourceRelationshipId: "rel-assign",
        precedenceRule: "assignment_party_change",
        relationshipPath: ["rel-assign"],
      }),
      effective("monthly_rent", "base-rent", { status: "inherited", precedenceRule: "base_claim_inherited_unchanged" }),
      effective("cam_amount", "base-cam", { status: "inherited", precedenceRule: "base_claim_inherited_unchanged" }),
    ],
  }));

  assertEquals(pkg.compatibilitySlice.fields.tenant_name.value, "New Tenant LLC");
  assertEquals(pkg.compatibilitySlice.fields.tenant_name.source_text, "Assignee: New Tenant LLC");
  assertEquals(pkg.compatibilitySlice.fields.monthly_rent.value, "1000.00");
  assertEquals(pkg.compatibilitySlice.fields.cam_amount.value, "250.00");
  const tenant = pkg.fieldProjection.find((row) => row.fieldKey === "tenant_name");
  assertEquals(tenant?.packageStatus, "party_role_changed");
  assertEquals(tenant?.baseSourceClaimId, "old-tenant");
  assertEquals(tenant?.overridingSourceClaimId, "new-tenant");
  assertEquals(pkg.metadata.inheritedFieldCount, 2);
});

Deno.test("16/17/18/19/20/21/22/23: amendments, combined docs, conflicts and requirements preserve package authority", () => {
  const claims = [
    claim("base-tenant", "base", "tenant_name", "Old Tenant LLC"),
    claim("base-rent", "base", "monthly_rent", "1000.00"),
    claim("amended-rent", "amend", "monthly_rent", "1200.00", { sourceText: "Monthly rent is amended to 1200" }),
    claim("combo-tenant", "combo", "tenant_name", "Combo Tenant LLC"),
  ];
  const pkg = buildPackageCompatibilityProjection(input({
    documents: [doc("base"), doc("amend", "lease_amendment"), doc("combo", "assignment_and_amendment")],
    sourceClaims: claims,
    effectiveClaims: [
      effective("tenant_name", "combo-tenant", {
        baseClaimId: "base-tenant",
        overridingClaimId: "combo-tenant",
        sourcePackageDocumentId: "combo",
        sourceRelationshipId: "combo-assign",
        precedenceRule: "assignment_party_change",
        relationshipPath: ["combo-assign"],
      }),
      effective("monthly_rent", "amended-rent", {
        baseClaimId: "base-rent",
        overridingClaimId: "amended-rent",
        sourcePackageDocumentId: "amend",
        sourceRelationshipId: "rel-amend",
        precedenceRule: "explicit_amendment_override",
        relationshipPath: ["rel-amend"],
      }),
      {
        conceptKey: "cam_amount",
        scopeKey: "lease",
        instanceKey: "default",
        status: "needs_review",
        precedenceRule: "package_conflict_requires_review",
        reasonCodes: ["COMPETING_CANDIDATES_NEED_REVIEW"],
        relationshipPath: ["rel-a", "rel-b"],
        conflict: { type: "multiple_explicit_overrides", candidateClaimIds: ["cam-a", "cam-b"], candidateRelationshipIds: ["rel-a", "rel-b"] },
      },
      {
        conceptKey: "renewal_options",
        scopeKey: "lease",
        instanceKey: "default",
        status: "requires_related_document",
        precedenceRule: "missing_related_document",
        reasonCodes: ["MISSING_RELATED_DOCUMENT"],
        relationshipPath: [],
        relatedDocumentRequirementId: "req-prior",
      },
    ],
  }));

  assertEquals(pkg.compatibilitySlice.fields.monthly_rent.value, "1200.00");
  assertEquals(pkg.compatibilitySlice.fields.monthly_rent.source_text, "Monthly rent is amended to 1200");
  assertEquals(pkg.compatibilitySlice.fields.tenant_name.value, "Combo Tenant LLC");
  assertEquals(pkg.compatibilitySlice.fields.cam_amount.extraction_status, "conflict_detected");
  assertEquals(pkg.compatibilitySlice.fields.renewal_options.extraction_status, "requires_related_document");
  assertEquals(pkg.fieldProjection.find((row) => row.fieldKey === "cam_amount")?.selectedSourceClaimId, null);
  assertEquals(pkg.fieldProjection.find((row) => row.fieldKey === "renewal_options")?.relatedDocumentRequirementId, "req-prior");
});

Deno.test("24/25/26/27/28/29/30/31/32/33: extension, certificate, guaranty and addenda project only explicit concepts", () => {
  const claims = [
    claim("base-rent", "base", "monthly_rent", "1000.00"),
    claim("base-cam", "base", "cam_amount", "250.00"),
    claim("base-tenant", "base", "tenant_name", "Tenant LLC"),
    claim("extension-option", "extension", "renewal_options", "one five-year extension"),
    claim("cert-commence", "cert", "commencement_date", "2024-01-01"),
    claim("guarantor", "guaranty", "dynamic.guarantor_name", "Guarantor LLC", { originalFieldKey: "custom_guarantor_name", originalLabel: "Guarantor Name" }),
  ];
  const pkg = buildPackageCompatibilityProjection(input({
    documents: [doc("base"), doc("extension", "lease_extension"), doc("cert", "commencement_certificate"), doc("guaranty", "guaranty")],
    sourceClaims: claims,
    effectiveClaims: [
      effective("monthly_rent", "base-rent", { status: "inherited", precedenceRule: "base_claim_inherited_unchanged" }),
      effective("cam_amount", "base-cam", { status: "inherited", precedenceRule: "base_claim_inherited_unchanged" }),
      effective("tenant_name", "base-tenant", { status: "inherited", precedenceRule: "base_claim_inherited_unchanged" }),
      effective("renewal_options", "extension-option", { sourcePackageDocumentId: "extension", sourceRelationshipId: "extend", precedenceRule: "extension_term_change", relationshipPath: ["extend"] }),
      effective("commencement_date", "cert-commence", { sourcePackageDocumentId: "cert", sourceRelationshipId: "commence", precedenceRule: "commencement_certificate_resolution", relationshipPath: ["commence"] }),
      effective("dynamic.guarantor_name", "guarantor", { sourcePackageDocumentId: "guaranty", sourceRelationshipId: "guarantees", precedenceRule: "guaranty_adds_guarantor_claim", relationshipPath: ["guarantees"] }),
    ],
  }));

  assertEquals(pkg.compatibilitySlice.fields.renewal_options.value, "one five-year extension");
  assertEquals(pkg.compatibilitySlice.fields.commencement_date.value, "2024-01-01");
  assertEquals(pkg.compatibilitySlice.fields.monthly_rent.value, "1000.00");
  assertEquals(pkg.compatibilitySlice.fields.cam_amount.value, "250.00");
  assertEquals(pkg.compatibilitySlice.fields.tenant_name.value, "Tenant LLC");
  assertEquals(pkg.compatibilitySlice.fields.custom_guarantor_name.value, "Guarantor LLC");
  assert(!("expiration_date" in pkg.compatibilitySlice.fields), "P3.6 must not synthesize dependent dates");
  assertEquals(pkg.metadata.dynamicFieldCount, 1);
});

Deno.test("34/35/36/37/38/39/40/41/42/49: dynamic/addendum ordering and cross-domain conflicts stay deterministic", () => {
  const claims = [
    claim("rent-add", "rentadd", "monthly_rent", "1300.00"),
    claim("cam-add", "camadd", "cam_amount", "325.00"),
    claim("work-ti", "work", "ti_allowance", "50000.00"),
    claim("dyn", "base", "dynamic.extra_notice", "Notice text", { originalFieldKey: "custom_extra_notice", originalLabel: "Extra Notice" }),
  ];
  const pkgA = buildPackageCompatibilityProjection(input({
    documents: [doc("base"), doc("rentadd", "rent_addendum"), doc("camadd", "cam_addendum"), doc("work", "work_letter")],
    sourceClaims: [...claims].reverse(),
    effectiveClaims: [
      effective("dynamic.extra_notice", "dyn"),
      effective("ti_allowance", "work-ti", { sourcePackageDocumentId: "work", sourceRelationshipId: "work-inc", precedenceRule: "work_letter_domain_override" }),
      effective("cam_amount", "cam-add", { sourcePackageDocumentId: "camadd", sourceRelationshipId: "cam-inc", precedenceRule: "cam_addendum_domain_override" }),
      effective("monthly_rent", "rent-add", { sourcePackageDocumentId: "rentadd", sourceRelationshipId: "rent-inc", precedenceRule: "rent_addendum_domain_override" }),
      { conceptKey: "insurance_responsibility", scopeKey: "lease", instanceKey: "default", status: "needs_review", precedenceRule: "package_conflict_requires_review", reasonCodes: [], relationshipPath: [], conflict: { type: "domain_scope_conflict", candidateClaimIds: ["bad"], candidateRelationshipIds: ["bad-rel"] } },
    ].reverse(),
  }));
  const pkgB = buildPackageCompatibilityProjection(input({
    documents: [doc("base"), doc("rentadd", "rent_addendum"), doc("camadd", "cam_addendum"), doc("work", "work_letter")],
    sourceClaims: claims,
    effectiveClaims: [
      effective("monthly_rent", "rent-add", { sourcePackageDocumentId: "rentadd", sourceRelationshipId: "rent-inc", precedenceRule: "rent_addendum_domain_override" }),
      effective("cam_amount", "cam-add", { sourcePackageDocumentId: "camadd", sourceRelationshipId: "cam-inc", precedenceRule: "cam_addendum_domain_override" }),
      effective("ti_allowance", "work-ti", { sourcePackageDocumentId: "work", sourceRelationshipId: "work-inc", precedenceRule: "work_letter_domain_override" }),
      effective("dynamic.extra_notice", "dyn"),
      { conceptKey: "insurance_responsibility", scopeKey: "lease", instanceKey: "default", status: "needs_review", precedenceRule: "package_conflict_requires_review", reasonCodes: [], relationshipPath: [], conflict: { type: "domain_scope_conflict", candidateClaimIds: ["bad"], candidateRelationshipIds: ["bad-rel"] } },
    ],
  }));

  assertEquals(pkgA.compatibilitySlice.fields, pkgB.compatibilitySlice.fields);
  assertEquals(pkgA.compatibilitySlice.fields.monthly_rent.value, "1300.00");
  assertEquals(pkgA.compatibilitySlice.fields.cam_amount.value, "325.00");
  assertEquals(pkgA.compatibilitySlice.fields.ti_allowance.value, "50000.00");
  assertEquals(pkgA.compatibilitySlice.fields.insurance_responsibility.extraction_status, "conflict_detected");
  assertEquals(pkgA.compatibilitySlice.fields.custom_extra_notice.value, "Notice text");
});

Deno.test("43/44/45/46/47/48: validation fails closed for stale, foreign, incomplete, duplicate, conflict and requirement errors", () => {
  assertRejects(async () => validatePackageProjectionInput(input({ resolutionRun: { id: "res-run-1", status: "running" } })), Error, "PACKAGE_RESOLUTION_NOT_COMPLETED");
  assertRejects(async () => validatePackageProjectionInput(input({ effectiveClaims: [effective("tenant_name", "base-tenant"), effective("tenant_name", "base-tenant", { precedenceRule: "duplicate" })] })), Error, "PACKAGE_EFFECTIVE_CLAIM_DUPLICATE");
  assertRejects(async () => validatePackageProjectionInput(input({ effectiveClaims: [{ conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default", status: "needs_review", precedenceRule: "bad", reasonCodes: [], relationshipPath: [] }] })), Error, "PACKAGE_CONFLICT_STATUS_MISMATCH");
  assertRejects(async () => validatePackageProjectionInput(input({ effectiveClaims: [{ conceptKey: "monthly_rent", scopeKey: "lease", instanceKey: "default", status: "requires_related_document", precedenceRule: "missing", reasonCodes: [], relationshipPath: [] }] })), Error, "PACKAGE_RELATED_DOCUMENT_LINK_MISSING");
  assertRejects(async () => validatePackageProjectionInput(input({ sourceClaims: [claim("foreign", "other", "tenant_name", "Other")], effectiveClaims: [effective("tenant_name", "foreign")] })), Error, "PACKAGE_SELECTED_CLAIM_OUTSIDE_PACKAGE");
  assertRejects(async () => validatePackageProjectionInput(input({ documents: [{ ...doc("base"), activeGenerationId: "gen-2" }], sourceClaims: [claim("base-tenant", "base", "tenant_name", "Old Tenant LLC")], effectiveClaims: [effective("tenant_name", "base-tenant")] })), Error, "PACKAGE_SELECTED_CLAIM_STALE");
});

Deno.test("51/52/53/54/55/56/57: package-aware diff classifies expected package differences", () => {
  const legacy = {
    tenant_name: { value: "Old Tenant LLC", raw_value: null, raw: null, source_page: 1, page: 1, source_text: "Tenant: Old", exact_source_text: "Tenant: Old", snippet: "Tenant: Old", source_clause: "Tenant: Old", confidence: 90, confidence_score: 90, extraction_status: "extracted", field_group: "parties" },
    monthly_rent: { value: "$1,000.00", raw_value: null, raw: null, source_page: 2, page: 2, source_text: "Rent: 1000", exact_source_text: "Rent: 1000", snippet: "Rent: 1000", source_clause: "Rent: 1000", confidence: 90, confidence_score: 90, extraction_status: "extracted", field_group: "rent" },
  };
  const pkg = buildPackageCompatibilityProjection(input({
    documents: [doc("base"), doc("assignment", "lease_assignment")],
    sourceClaims: [
      claim("new-tenant", "assignment", "tenant_name", "New Tenant LLC", { sourceText: "Assignee: New" }),
      claim("base-rent", "base", "monthly_rent", "1000.00", { sourceText: "Rent: 1000" }),
    ],
    effectiveClaims: [
      effective("tenant_name", "new-tenant", { baseClaimId: "old-tenant", overridingClaimId: "new-tenant", sourcePackageDocumentId: "assignment", sourceRelationshipId: "assigns", precedenceRule: "assignment_party_change" }),
      effective("monthly_rent", "base-rent", { status: "inherited", precedenceRule: "base_claim_inherited_unchanged" }),
      { conceptKey: "cam_amount", scopeKey: "lease", instanceKey: "default", status: "needs_review", precedenceRule: "package_conflict_requires_review", reasonCodes: [], relationshipPath: [], conflict: { type: "multiple_explicit_overrides", candidateClaimIds: ["a", "b"], candidateRelationshipIds: ["r1", "r2"] } },
    ],
  }));
  const diffs = diffPackageCompatibilityFields(legacy, pkg.compatibilitySlice.fields, pkg.fieldProjection);
  const byField = Object.fromEntries(diffs.map((diff) => [diff.fieldKey, diff.classification]));
  assertEquals(byField.tenant_name, "assignment_party_change");
  assertEquals(byField.monthly_rent, "inherited_from_base");
  assertEquals(byField.cam_amount, "package_conflict");
  const summary = summarizePackageDiff(diffs);
  assertEquals(summary.assignment_party_change, 1);
  assertEquals(summary.inherited_from_base, 1);
  assertEquals(summary.package_conflict, 1);
});
