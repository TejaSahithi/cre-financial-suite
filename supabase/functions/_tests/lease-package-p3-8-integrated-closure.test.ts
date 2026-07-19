// @ts-nocheck
// P3.8 -- integrated local package-workflow closure over sanitized fixtures.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildFieldProjection } from "../_shared/extraction/claims/adapters/claims-to-field-projection.ts";
import { buildCompatibilityExtractionDataSlice } from "../_shared/extraction/claims/adapters/compatibility-payload-builder.ts";
import { CLAIM_CONCEPTS } from "../_shared/extraction/claims/concept-registry.ts";
import { getLeaseClaimsLedgerMode } from "../_shared/extraction/claims/feature-mode.ts";
import { getLeaseDocumentPackageMode } from "../_shared/extraction/document-package/feature-mode.ts";
import { computeDecisionKey, computeMembershipKey } from "../_shared/extraction/document-package/package-membership-key.ts";
import { resolvePackageMembership } from "../_shared/extraction/document-package/package-membership-resolver.ts";
import { PACKAGE_KEY_CONTRACT_VERSION } from "../_shared/extraction/document-package/package-membership-key.ts";
import { diffPackageCompatibilityFields } from "../_shared/extraction/document-package/projection/package-projection-diff.ts";
import { buildPackageCompatibilityProjection } from "../_shared/extraction/document-package/projection/package-projection-service.ts";
import { computePackageProjectionFieldKey, hashPackageProjectionInput } from "../_shared/extraction/document-package/projection/package-projection-key.ts";
import { validatePackageProjectionInput } from "../_shared/extraction/document-package/projection/package-projection-validator.ts";
import { detectDocumentRelationships } from "../_shared/extraction/document-package/relationships/relationship-detector.ts";
import { computeRelationshipKey } from "../_shared/extraction/document-package/relationships/relationship-key.ts";
import { resolvePackageClaims } from "../_shared/extraction/document-package/resolution/package-claim-resolver.ts";
import { computePackageConflictKey, computeResolutionSlotKey } from "../_shared/extraction/document-package/resolution/package-resolution-key.ts";
import { validatePackageRuntimeModeCombination } from "../_shared/extraction/document-package/runtime/package-runtime-orchestrator.ts";
import { PACKAGE_RUNTIME_ERROR_CODES, PackageRuntimeError } from "../_shared/extraction/document-package/runtime/package-runtime-errors.ts";

const ORG = "org-p3-8";
const OTHER_ORG = "org-foreign";
const PACKAGE = "pkg-p3-8";
const LEASE = "lease-p3-8";
const GEN = "gen-current";

function roleFor(profileKey: string): string {
  if (profileKey === "base_lease") return "primary_base_document";
  if (profileKey === "lease_assignment" || profileKey === "assignment_and_amendment") return "assignment_document";
  if (profileKey === "lease_amendment") return "amendment_document";
  if (profileKey === "lease_extension") return "extension_document";
  if (profileKey === "lease_renewal") return "renewal_document";
  if (profileKey === "commencement_certificate") return "commencement_document";
  if (profileKey === "guaranty") return "guaranty_document";
  if (profileKey === "work_letter" || profileKey === "exhibit") return "exhibit_document";
  if (profileKey === "unknown_supported_document") return "unknown_document";
  return "addendum_document";
}

function doc(id: string, profileKey = "base_lease", overrides = {}) {
  return {
    id,
    orgId: ORG,
    packageId: PACKAGE,
    uploadedFileId: `file-${id}`,
    extractionRunId: `run-${id}`,
    generationId: GEN,
    activeGenerationId: GEN,
    profileKey,
    membershipRole: roleFor(profileKey),
    membershipStatus: "confirmed",
    ...overrides,
  };
}

function claim(id: string, packageDocumentId: string, conceptKey: string, normalizedValue: string | null, overrides = {}) {
  return {
    id,
    claimId: id,
    orgId: ORG,
    packageDocumentId,
    uploadedFileId: `file-${packageDocumentId}`,
    extractionRunId: `run-${packageDocumentId}`,
    generationId: GEN,
    conceptKey,
    scopeKey: "lease",
    instanceKey: "default",
    assertionStatus: normalizedValue === null ? "not_present" : "asserted",
    normalizedValue,
    rawValueText: normalizedValue,
    sourcePage: 1,
    sourceText: `${conceptKey}: ${normalizedValue}`,
    confidence: 91,
    hasEvidence: true,
    registryStatus: conceptKey.startsWith("dynamic.") ? "unregistered" : "registered",
    producerType: "deterministic_mapper",
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function fieldGroupMap(): Map<string, string> {
  return new Map(CLAIM_CONCEPTS.map((concept) => [concept.conceptKey, concept.domain]));
}

function confirmedRelationships(documents: any[], claims: any[]) {
  return detectDocumentRelationships({
    orgId: ORG,
    packageId: PACKAGE,
    packagePrimaryDocumentId: documents.find((item) => item.profileKey === "base_lease")?.id ?? "base",
    documents,
    claims,
  })
    .filter((candidate) => candidate.proposedStatus === "confirmed" && candidate.validationStatus === "valid")
    .map((candidate) => ({
      id: candidate.relationshipKey ?? computeRelationshipKey({ orgId: ORG, packageId: PACKAGE, candidate }),
      orgId: ORG,
      packageId: PACKAGE,
      sourcePackageDocumentId: candidate.sourcePackageDocumentId,
      targetPackageDocumentId: candidate.targetPackageDocumentId,
      relationshipType: candidate.relationshipType,
      relationshipStatus: "confirmed",
      validationStatus: "valid",
      generationId: documents.find((item) => item.id === candidate.sourcePackageDocumentId)?.generationId ?? GEN,
      evidenceClaimId: candidate.evidenceClaimIds?.[0] ?? null,
      evidenceClaimIds: candidate.evidenceClaimIds ?? [],
    }));
}

function projectFixture(params: {
  documents: any[];
  claims: any[];
  requirements?: any[];
  reviewerDecisions?: any[];
  requestedConceptKeys?: string[];
  singleDocumentCompatibility?: any;
}) {
  const relationships = confirmedRelationships(params.documents, params.claims);
  const resolution = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    leaseId: LEASE,
    documents: params.documents,
    claims: params.claims,
    relationships,
    requirements: params.requirements ?? [],
    reviewerDecisions: params.reviewerDecisions ?? [],
    requestedConceptKeys: params.requestedConceptKeys,
  });
  const projection = buildPackageCompatibilityProjection({
    orgId: ORG,
    packageId: PACKAGE,
    leaseId: LEASE,
    resolutionRun: { id: "resolution-run", orgId: ORG, packageId: PACKAGE, leaseId: LEASE, status: "completed" },
    documents: params.documents,
    sourceClaims: params.claims,
    effectiveClaims: resolution.resolutions,
    conflicts: resolution.conflicts,
    requirements: params.requirements ?? [],
  }, {
    singleDocumentCompatibility: params.singleDocumentCompatibility ?? null,
    allowActiveWrites: false,
  });
  return { relationships, resolution, projection };
}

function rowByConcept(result: any, conceptKey: string) {
  const row = result.resolution.resolutions.find((item: any) => item.conceptKey === conceptKey);
  assert(row, `missing ${conceptKey}`);
  return row;
}

function p2CompatibilityFor(claims: any[]) {
  const projection = buildFieldProjection({
    claims: claims.map((item) => ({
      claimId: item.id,
      conceptKey: item.conceptKey,
      scopeKey: item.scopeKey,
      instanceKey: item.instanceKey,
      producerType: item.producerType,
      assertionStatus: item.assertionStatus,
      normalizedValue: item.normalizedValue,
      rawValueText: item.rawValueText,
      sourcePage: item.sourcePage,
      sourceText: item.sourceText,
      confidence: item.confidence,
      hasEvidence: item.hasEvidence,
      createdAt: item.createdAt,
    })),
    reviewDecisionsByFactSlot: new Map(),
    openConflictFactSlots: new Set(),
  });
  return buildCompatibilityExtractionDataSlice(projection, fieldGroupMap());
}

Deno.test("P3.8 fixture matrix: package membership, relationships, precedence and projection stay integrated over sanitized scenarios", () => {
  const base = doc("base");
  const assignment = doc("assignment", "lease_assignment");
  const amendment = doc("amendment", "lease_amendment");
  const amendment2 = doc("amendment2", "lease_amendment");
  const combined = doc("combined", "assignment_and_amendment");
  const extension = doc("extension", "lease_extension");
  const renewal = doc("renewal", "lease_renewal");
  const cert = doc("cert", "commencement_certificate");
  const guaranty = doc("guaranty", "guaranty");
  const rentAddendum = doc("rent-addendum", "rent_addendum");
  const camAddendum = doc("cam-addendum", "cam_addendum");
  const workLetter = doc("work-letter", "work_letter");

  const baseClaims = [
    claim("base-tenant", "base", "tenant_name", "Original Tenant LLC"),
    claim("base-rent", "base", "monthly_rent", "1000.00"),
    claim("base-cam", "base", "cam_amount", "250.00"),
    claim("base-address", "base", "property_address", "100 Market Street"),
  ];
  const p2Slice = p2CompatibilityFor(baseClaims);
  const baseOnly = projectFixture({ documents: [base], claims: baseClaims, singleDocumentCompatibility: p2Slice });
  assertEquals(baseOnly.projection.compatibilitySlice.fields.monthly_rent.value, "1000.00");
  const baseDiffs = diffPackageCompatibilityFields(p2Slice.fields, baseOnly.projection.compatibilitySlice.fields, baseOnly.projection.fieldProjection);
  assert(baseDiffs.every((item) => !["value_mismatch", "missing_in_package_projection", "extra_in_package_projection"].includes(item.classification)));

  const assignmentOnlyDecision = resolvePackageMembership({
    profileKey: "lease_assignment",
    claims: [claim("assign-reference", "assignment", "original_lease_date", "2020-01-01")],
    leaseLinkage: { leaseId: null, isLegacySourceDocument: false, propertyId: null, unitId: null, tenantId: null },
    candidates: [],
  });
  assertEquals(assignmentOnlyDecision.decision, "requires_related_document");
  assertEquals(assignmentOnlyDecision.relatedDocumentRequirement?.requirementType, "base_lease");

  const assigned = projectFixture({
    documents: [base, assignment],
    claims: [
      ...baseClaims,
      claim("assign-reference", "assignment", "original_lease_date", "2020-01-01"),
      claim("assignor", "assignment", "assignor_name", "Original Tenant LLC"),
      claim("assignee", "assignment", "assignee_name", "Assignee LLC"),
      claim("assigned-tenant", "assignment", "tenant_name", "Assignee LLC"),
      claim("assign-rent", "assignment", "monthly_rent", "9999.00"),
    ],
  });
  assertEquals(rowByConcept(assigned, "tenant_name").selectedClaimId, "assigned-tenant");
  assertEquals(rowByConcept(assigned, "tenant_name").precedenceRule, "assignment_party_change");
  assertEquals(rowByConcept(assigned, "monthly_rent").selectedClaimId, "base-rent");
  assert(assigned.resolution.conflicts.some((item: any) => item.conflictType === "domain_scope_conflict" && item.candidateClaimIds.includes("assign-rent")));
  assertEquals(assigned.projection.compatibilitySlice.fields.tenant_name.value, "Assignee LLC");

  const amended = projectFixture({
    documents: [base, amendment],
    claims: [...baseClaims, claim("amend-rent", "amendment", "monthly_rent", "1200.00"), claim("unchanged", "amendment", "all_other_terms_remain_same", "true")],
  });
  assertEquals(rowByConcept(amended, "monthly_rent").selectedClaimId, "amend-rent");
  assertEquals(rowByConcept(amended, "cam_amount").selectedClaimId, "base-cam");
  assertEquals(amended.projection.compatibilitySlice.fields.monthly_rent.value, "1200.00");

  const twoDistinctAmendments = projectFixture({
    documents: [base, amendment, amendment2],
    claims: [...baseClaims, claim("amend-ref", "amendment", "all_other_terms_remain_same", "true"), claim("amend-ref-2", "amendment2", "all_other_terms_remain_same", "true"), claim("amend-rent", "amendment", "monthly_rent", "1200.00"), claim("amend-cam", "amendment2", "cam_amount", "300.00")],
  });
  assertEquals(rowByConcept(twoDistinctAmendments, "monthly_rent").selectedClaimId, "amend-rent");
  assertEquals(rowByConcept(twoDistinctAmendments, "cam_amount").selectedClaimId, "amend-cam");

  const conflictingAmendments = projectFixture({
    documents: [base, amendment, amendment2],
    claims: [...baseClaims, claim("amend-ref-a", "amendment", "all_other_terms_remain_same", "true"), claim("amend-ref-b", "amendment2", "all_other_terms_remain_same", "true"), claim("amend-rent-a", "amendment", "monthly_rent", "1200.00"), claim("amend-rent-b", "amendment2", "monthly_rent", "1300.00")],
  });
  assertEquals(rowByConcept(conflictingAmendments, "monthly_rent").status, "needs_review");
  assertEquals(conflictingAmendments.projection.compatibilitySlice.fields.monthly_rent.extraction_status, "conflict_detected");

  const combinedFlow = projectFixture({
    documents: [base, combined],
    claims: [
      ...baseClaims,
      claim("combined-reference", "combined", "original_lease_date", "2020-01-01"),
      claim("combined-tenant", "combined", "tenant_name", "Combined Assignee LLC"),
      claim("combined-cam", "combined", "cam_amount", "310.00"),
    ],
  });
  assertEquals(rowByConcept(combinedFlow, "tenant_name").precedenceRule, "assignment_party_change");
  assertEquals(rowByConcept(combinedFlow, "cam_amount").precedenceRule, "explicit_amendment_override");

  const scopedDocs = [base, extension, renewal, cert, guaranty, rentAddendum, camAddendum, workLetter];
  const scoped = projectFixture({
    documents: scopedDocs,
    claims: [
      ...baseClaims,
      claim("extension-option", "extension", "renewal_options", "one five-year extension"),
      claim("renewal-rent", "renewal", "monthly_rent", "1400.00"),
      claim("cert-date", "cert", "commencement_date", "2024-01-01"),
      claim("cert-tenant", "cert", "tenant_name", "Wrong Tenant"),
      claim("rent-addendum-rent", "rent-addendum", "monthly_rent", "1500.00"),
      claim("rent-addendum-cam", "rent-addendum", "cam_amount", "999.00"),
      claim("cam-addendum-cam", "cam-addendum", "cam_amount", "325.00"),
      claim("work-ti", "work-letter", "ti_allowance", "50000.00"),
    ],
  });
  assertEquals(rowByConcept(scoped, "renewal_options").selectedClaimId, "extension-option");
  assertEquals(rowByConcept(scoped, "commencement_date").selectedClaimId, "cert-date");
  assertEquals(rowByConcept(scoped, "tenant_name").selectedClaimId, "base-tenant");
  assert(scoped.resolution.conflicts.some((item: any) => item.candidateClaimIds.includes("cert-tenant")));
  assert(scoped.resolution.conflicts.some((item: any) => item.candidateClaimIds.includes("rent-addendum-cam")));
  assert(!("expiration_date" in scoped.projection.compatibilitySlice.fields), "P3.8 must not synthesize P4 dependent dates");
  assertEquals(scoped.projection.compatibilitySlice.fields.ti_allowance.value, "50000.00");

  const guarantyEdge = detectDocumentRelationships({
    orgId: ORG,
    packageId: PACKAGE,
    packagePrimaryDocumentId: "base",
    documents: [base, guaranty],
    claims: [claim("guaranty-tenant", "guaranty", "tenant_name", "Original Tenant LLC"), claim("guaranty-language", "guaranty", "dynamic.guaranty_language", "Guarantor guarantees tenant obligations")],
  }).find((candidate) => candidate.relationshipType === "guarantees");
  assertEquals(guarantyEdge?.targetPackageDocumentId, "base");
  assert(!("tenantReplacement" in guarantyEdge));

  const unknownDecision = resolvePackageMembership({
    profileKey: "unknown_supported_document",
    claims: [],
    leaseLinkage: { leaseId: null, isLegacySourceDocument: false, propertyId: null, unitId: null, tenantId: null },
    candidates: [],
  });
  assertEquals(unknownDecision.decision, "propose_existing_package");
  assertEquals(unknownDecision.relatedDocumentRequirement, undefined);

  const ambiguousBaseRelationship = detectDocumentRelationships({
    orgId: ORG,
    packageId: PACKAGE,
    packagePrimaryDocumentId: "base-a",
    documents: [doc("base-a"), doc("base-b"), assignment],
    claims: [claim("assign-reference", "assignment", "original_lease_date", "2020-01-01")],
  }).find((candidate) => candidate.relationshipType === "assigns");
  assertEquals(ambiguousBaseRelationship?.proposedStatus, "ambiguous");
  assertEquals(ambiguousBaseRelationship?.candidateTargetDocumentIds, ["base-a", "base-b"]);

  const missingPrior = projectFixture({
    documents: [base, amendment],
    claims: [...baseClaims, claim("prior-ref", "amendment", "dynamic.prior_amendment_reference", "Amendment No. 1")],
    requirements: [{
      id: "req-prior-amendment",
      orgId: ORG,
      packageId: PACKAGE,
      requestingPackageDocumentId: "amendment",
      requirementType: "prior_amendment",
      requirementStatus: "open",
      reasonCode: "PRIOR_AMENDMENT_REFERENCE",
    }],
    requestedConceptKeys: ["renewal_options"],
  });
  assertEquals(rowByConcept(missingPrior, "renewal_options").status, "requires_related_document");

  const supersedes = detectDocumentRelationships({
    orgId: ORG,
    packageId: PACKAGE,
    packagePrimaryDocumentId: "base-a",
    documents: [doc("base-a"), doc("base-b"), amendment],
    claims: [claim("supersedes-language", "amendment", "dynamic.supersedes_language", "supersedes and replaces")],
  }).find((candidate) => candidate.relationshipType === "supersedes");
  assertEquals(supersedes?.proposedStatus, "ambiguous");
});

Deno.test("P3.8 mode matrix: all package/claims feature-mode combinations resolve explicitly and fail closed where required", () => {
  const env = (claimsMode?: string, packageMode?: string) => ({
    get(key: string) {
      if (key === "LEASE_CLAIMS_LEDGER_MODE") return claimsMode;
      if (key === "LEASE_DOCUMENT_PACKAGE_MODE") return packageMode;
      return undefined;
    },
  });
  const cases = [
    ["off", "off", true, undefined],
    ["shadow", "off", true, undefined],
    ["active", "off", true, undefined],
    ["off", "shadow", false, PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_MODE_REQUIRES_CLAIMS_LEDGER],
    ["shadow", "shadow", true, undefined],
    ["active", "shadow", true, undefined],
    ["off", "active", false, PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_ACTIVE_REQUIRES_CLAIMS_ACTIVE],
    ["shadow", "active", false, PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_ACTIVE_REQUIRES_CLAIMS_ACTIVE],
    ["active", "active", true, undefined],
    [undefined, undefined, true, undefined],
    ["garbage", "garbage", true, undefined],
  ];

  for (const [claimsRaw, packageRaw, valid, errorCode] of cases) {
    const modes = {
      claimsMode: getLeaseClaimsLedgerMode(env(claimsRaw, packageRaw)),
      packageMode: getLeaseDocumentPackageMode(env(claimsRaw, packageRaw)),
    };
    if (valid) {
      validatePackageRuntimeModeCombination(modes);
      if (!claimsRaw && !packageRaw) assertEquals(modes, { claimsMode: "off", packageMode: "off" });
      if (claimsRaw === "garbage") assertEquals(modes, { claimsMode: "off", packageMode: "off" });
    } else {
      let caught: PackageRuntimeError | null = null;
      try {
        validatePackageRuntimeModeCombination(modes);
      } catch (error) {
        caught = error;
      }
      assertEquals(caught?.errorCode, errorCode);
    }
  }
});

Deno.test("P3.8 generation, retry and reviewer invariants: stale rows are fenced and deterministic keys converge", async () => {
  const base = doc("base");
  const amendment = doc("amendment", "lease_amendment");
  const staleBase = doc("base", "base_lease", { activeGenerationId: GEN, generationId: "gen-stale" });
  const baseClaim = claim("base-rent", "base", "monthly_rent", "1000.00");
  const staleClaim = claim("stale-rent", "base", "monthly_rent", "999.00", { generationId: "gen-stale" });
  const amendedClaim = claim("amend-rent", "amendment", "monthly_rent", "1200.00");

  const staleResolution = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [staleBase, amendment],
    claims: [staleClaim, amendedClaim],
    relationships: [],
    requestedConceptKeys: ["monthly_rent"],
  });
  assertEquals(staleResolution.resolutions.find((row) => row.conceptKey === "monthly_rent")?.status, "needs_review");
  assert(staleResolution.conflicts.some((row) => row.conflictType === "stale_generation_candidate"));

  assertThrows(() => {
    validatePackageProjectionInput({
      orgId: ORG,
      packageId: PACKAGE,
      leaseId: LEASE,
      resolutionRun: { id: "resolution-run", orgId: ORG, packageId: PACKAGE, leaseId: LEASE, status: "completed" },
      documents: [base],
      sourceClaims: [staleClaim],
      effectiveClaims: [{
        conceptKey: "monthly_rent",
        scopeKey: "lease",
        instanceKey: "default",
        status: "effective",
        selectedClaimId: "stale-rent",
        sourcePackageDocumentId: "base",
        precedenceRule: "base_document_source_claim",
        reasonCodes: [],
        relationshipPath: [],
      }],
      conflicts: [],
      requirements: [],
    });
  }, Error, "PACKAGE_SELECTED_CLAIM_STALE");

  const relationshipCandidate = detectDocumentRelationships({
    orgId: ORG,
    packageId: PACKAGE,
    packagePrimaryDocumentId: "base",
    documents: [base, amendment],
    claims: [claim("amend-reference", "amendment", "all_other_terms_remain_same", "true")],
  }).find((row) => row.relationshipType === "amends");
  assert(relationshipCandidate);
  assertEquals(
    computeRelationshipKey({ orgId: ORG, packageId: PACKAGE, candidate: relationshipCandidate }),
    computeRelationshipKey({ orgId: ORG, packageId: PACKAGE, candidate: { ...relationshipCandidate, evidenceClaimIds: [...relationshipCandidate.evidenceClaimIds].reverse() } }),
  );
  assert(
    computeRelationshipKey({ orgId: ORG, packageId: PACKAGE, candidate: relationshipCandidate }) !==
      computeRelationshipKey({ orgId: ORG, packageId: PACKAGE, candidate: { ...relationshipCandidate, sourcePackageDocumentId: "amendment-new-gen" } }),
  );

  assertEquals(
    computeMembershipKey({ orgId: ORG, packageId: PACKAGE, uploadedFileId: "file-base", generationId: GEN, membershipRole: "primary_base_document" }),
    computeMembershipKey({ orgId: ORG, packageId: PACKAGE, uploadedFileId: "file-base", generationId: GEN, membershipRole: "primary_base_document" }),
  );
  assert(
    computeDecisionKey({ orgId: ORG, uploadedFileId: "file-base", extractionRunId: "run-base", generationId: GEN }) !==
      computeDecisionKey({ orgId: ORG, uploadedFileId: "file-base", extractionRunId: "run-base-2", generationId: "gen-new" }),
  );
  assertEquals(
    computeResolutionSlotKey({ orgId: ORG, packageId: PACKAGE, conceptKey: "monthly_rent" }),
    computeResolutionSlotKey({ orgId: ORG, packageId: PACKAGE, conceptKey: "monthly_rent", scopeKey: "lease", instanceKey: "default" }),
  );
  assertEquals(
    computePackageProjectionFieldKey({ orgId: ORG, packageId: PACKAGE, projectionRunId: "projection-run", fieldKey: "monthly_rent" }),
    computePackageProjectionFieldKey({ orgId: ORG, packageId: PACKAGE, projectionRunId: "projection-run", fieldKey: "monthly_rent", instanceKey: "default" }),
  );

  const conflictA = computePackageConflictKey({
    orgId: ORG,
    packageId: PACKAGE,
    conceptKey: "monthly_rent",
    conflictType: "multiple_explicit_overrides",
    candidateClaimIds: ["b", "a"],
    candidateRelationshipIds: ["rel-2", "rel-1"],
  });
  const conflictB = computePackageConflictKey({
    orgId: ORG,
    packageId: PACKAGE,
    conceptKey: "monthly_rent",
    conflictType: "multiple_explicit_overrides",
    candidateClaimIds: ["a", "b"],
    candidateRelationshipIds: ["rel-1", "rel-2"],
  });
  assertEquals(conflictA, conflictB);

  const inputHashA = await hashPackageProjectionInput([[baseClaim, amendedClaim], ["rel-b", "rel-a"]]);
  const inputHashB = await hashPackageProjectionInput([[amendedClaim, baseClaim], ["rel-a", "rel-b"]]);
  assertEquals(inputHashA, inputHashB);

  const reviewerResolved = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, amendment, doc("amendment2", "lease_amendment")],
    claims: [baseClaim, amendedClaim, claim("amend-rent-2", "amendment2", "monthly_rent", "1300.00")],
    relationships: [
      { id: "rel-1", orgId: ORG, packageId: PACKAGE, sourcePackageDocumentId: "amendment", targetPackageDocumentId: "base", relationshipType: "amends", relationshipStatus: "confirmed", validationStatus: "valid", generationId: GEN },
      { id: "rel-2", orgId: ORG, packageId: PACKAGE, sourcePackageDocumentId: "amendment2", targetPackageDocumentId: "base", relationshipType: "amends", relationshipStatus: "confirmed", validationStatus: "valid", generationId: GEN },
    ],
    reviewerDecisions: [{ operation: "choose_claim", conceptKey: "monthly_rent", selectedClaimId: "amend-rent-2" }],
  });
  const rent = reviewerResolved.resolutions.find((row) => row.conceptKey === "monthly_rent");
  assertEquals(rent?.selectedClaimId, "amend-rent-2");
  assertEquals(rent?.precedenceRule, "reviewer_confirmed_package_resolution");
  assertEquals(reviewerResolved.conflicts.length, 0);
});

Deno.test("P3.8 write-back, finalizer, security and scope contracts remain narrow after P3.7", async () => {
  const runtimeMigration = await Deno.readTextFile("supabase/migrations/20260847000000_lease_package_runtime_p3_7.sql");
  const packageGraphSecurity = await Deno.readTextFile("supabase/migrations/20260840000000_lease_document_package_graph_security.sql");
  const membershipReviewer = await Deno.readTextFile("supabase/migrations/20260843000000_lease_package_membership_reviewer_rpc.sql");
  const resolutionMigration = await Deno.readTextFile("supabase/migrations/20260845000000_lease_package_resolution_p3_5.sql");
  const projectionMigration = await Deno.readTextFile("supabase/migrations/20260846000000_lease_package_projection_p3_6.sql");
  const normalize = await Deno.readTextFile("supabase/functions/normalize-pdf-output/index.ts");
  const worker = await Deno.readTextFile("supabase/functions/lease-extraction-worker/index.ts");
  const saveDraft = await Deno.readTextFile("supabase/functions/save-lease-review-draft/index.ts");
  const runtime = await Deno.readTextFile("supabase/functions/_shared/extraction/document-package/runtime/package-runtime-orchestrator.ts");

  assert(runtimeMigration.includes("DROP FUNCTION IF EXISTS public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT);"));
  assertEquals([...runtimeMigration.matchAll(/CREATE OR REPLACE FUNCTION public\.finalize_lease_extraction_for_review\(/g)].length, 1);
  assert(runtimeMigration.includes("p_package_mode TEXT DEFAULT 'off'"));
  assert(runtimeMigration.includes("v_generation_id := v_file.active_generation_id"));
  assert(runtimeMigration.includes("app.allow_review_readiness_ready"));
  assert(runtimeMigration.includes("review_readiness = 'ready'"));

  for (const code of [
    "PACKAGE_COMPATIBILITY_NOT_PERSISTED",
    "PACKAGE_REQUIRED_CONFLICT_OPEN",
    "PACKAGE_REQUIRED_RELATED_DOCUMENT_MISSING",
    "PACKAGE_EFFECTIVE_CLAIM_INVALID",
    "PACKAGE_MODE_CONFIGURATION_INVALID",
  ]) {
    assert(runtimeMigration.includes(code));
  }

  assert(runtimeMigration.includes("CREATE OR REPLACE FUNCTION public.persist_lease_package_claim_projection"));
  assert(runtimeMigration.includes("IF auth.uid() IS NOT NULL"));
  assert(runtimeMigration.includes("GRANT EXECUTE ON FUNCTION public.persist_lease_package_claim_projection"));
  assert(runtimeMigration.includes("TO service_role"));
  assert(runtimeMigration.includes("jsonb_object_keys(p_compatibility_patch)"));
  assert(runtimeMigration.includes("key NOT IN ('fields', 'field_evidence', 'confidence_scores', 'custom_fields', 'discovered_fields', 'rejected_fields')"));
  for (const rejected of ["raw_claims", "relationships", "workflow_output", "expense_rules", "cam_profile", "budget_preview", "provider_metadata", "artifact_path"]) {
    assert(runtimeMigration.includes(`'${rejected}'`));
  }
  assert(!runtimeMigration.includes("leases.source_file_id ="));
  assert(!runtimeMigration.includes("workflow_output ="));

  for (const sql of [runtimeMigration, membershipReviewer, resolutionMigration, projectionMigration]) {
    assert(sql.includes("SECURITY DEFINER"));
    assert(/search_path\s*=\s*public,\s*(extensions|pg_temp)/i.test(sql) || /SET\s+search_path\s*=\s*public,\s*(extensions|pg_temp)/i.test(sql) || /search_path\s+TO\s+public,\s*(extensions|pg_temp)/i.test(sql));
  }
  assert(packageGraphSecurity.includes("No GRANT SELECT ... TO authenticated"));
  assert(!/GRANT\\s+(INSERT|UPDATE|DELETE|ALL)/i.test(packageGraphSecurity));
  assert(membershipReviewer.includes("auth.uid()"));
  assert(!membershipReviewer.includes("p_actor_id"));

  const packageCallIndex = normalize.indexOf('maybeRunLeaseDocumentPackagePipeline(');
  const finalizerIndex = normalize.indexOf("finalize_lease_extraction_for_review", packageCallIndex);
  assert(packageCallIndex > normalize.indexOf("maybeRunClaimsLedgerForStage"));
  assert(finalizerIndex > packageCallIndex);
  assert(worker.includes("p_package_mode: getLeaseDocumentPackageMode()"));
  assert(saveDraft.includes("package-active review draft saves must use package reviewer decision routes"));
  assert(!runtime.includes("fetch("));
  assert(!runtime.includes("Azure"));
  assert(!runtime.includes("Vertex"));
  assert(!runtime.includes("Docling"));
  assert(!runtime.includes("Gemini"));
  assert(!runtime.includes("calculateRent"));
  assert(!runtime.includes("expense_rules"));
  assertEquals(PACKAGE_KEY_CONTRACT_VERSION, "v1");

  const crossOrgProjection = {
    orgId: ORG,
    packageId: PACKAGE,
    leaseId: LEASE,
    resolutionRun: { id: "resolution-run", orgId: ORG, packageId: PACKAGE, leaseId: LEASE, status: "completed" },
    documents: [doc("base")],
    sourceClaims: [claim("foreign-claim", "base", "monthly_rent", "999.00", { orgId: OTHER_ORG })],
    effectiveClaims: [{
      conceptKey: "monthly_rent",
      scopeKey: "lease",
      instanceKey: "default",
      status: "effective",
      selectedClaimId: "foreign-claim",
      sourcePackageDocumentId: "base",
      precedenceRule: "base_document_source_claim",
      reasonCodes: [],
      relationshipPath: [],
    }],
    conflicts: [],
    requirements: [],
  };
  assertThrows(() => validatePackageProjectionInput(crossOrgProjection), Error, "PACKAGE_SELECTED_CLAIM_OUTSIDE_PACKAGE");
});
