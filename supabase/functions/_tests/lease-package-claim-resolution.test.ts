// @ts-nocheck
// P3.5 -- pure deterministic package-effective claim resolution.

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolvePackageClaims } from "../_shared/extraction/document-package/resolution/package-claim-resolver.ts";

const ORG = "org-1";
const PACKAGE = "pkg-1";
const RUN = "run-1";
const GEN = "gen-1";

function doc(id: string, profileKey: string, membershipRole: string) {
  return {
    id,
    orgId: ORG,
    packageId: PACKAGE,
    uploadedFileId: `file-${id}`,
    extractionRunId: RUN,
    generationId: GEN,
    activeGenerationId: GEN,
    profileKey,
    membershipRole,
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
    registryStatus: conceptKey.startsWith("dynamic.") ? "unregistered" : "registered",
    hasEvidence: true,
    ...overrides,
  };
}

function rel(id: string, sourcePackageDocumentId: string, targetPackageDocumentId: string, relationshipType: string) {
  return {
    id,
    orgId: ORG,
    packageId: PACKAGE,
    sourcePackageDocumentId,
    targetPackageDocumentId,
    relationshipType,
    relationshipStatus: "confirmed",
    validationStatus: "valid",
    generationId: GEN,
    evidenceClaimId: `evidence-${id}`,
  };
}

function byConcept(result, conceptKey: string) {
  const row = result.resolutions.find((resolution) => resolution.conceptKey === conceptKey);
  assertExists(row, `missing resolution for ${conceptKey}`);
  return row;
}

Deno.test("1/2/3/4/44/47/48/49/65: base claims stay immutable, deterministic, inherited with later docs, and stale/foreign claims are rejected", () => {
  const base = doc("base", "base_lease", "primary_base_document");
  const amendment = doc("amend", "lease_amendment", "amendment_document");
  const result = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [amendment, base],
    relationships: [rel("rel-amend", "amend", "base", "amends")],
    claims: [
      claim("base-rent", "base", "monthly_rent", "1000"),
      claim("stale-rent", "base", "monthly_rent", "999", { generationId: "stale-gen" }),
    ],
  });

  const rent = byConcept(result, "monthly_rent");
  assertEquals(rent.status, "needs_review");
  assertEquals(rent.selectedClaimId, undefined);
  assertEquals(rent.conflict?.type, "stale_generation_candidate");
  assert(result.resolutions.map((row) => row.conceptKey).join(",") === [...result.resolutions.map((row) => row.conceptKey)].sort().join(","));

  const withoutStale = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [amendment, base],
    relationships: [rel("rel-amend", "amend", "base", "amends")],
    claims: [claim("base-rent", "base", "monthly_rent", "1000")],
  });
  const inheritedRent = byConcept(withoutStale, "monthly_rent");
  assertEquals(inheritedRent.status, "inherited");
  assertEquals(inheritedRent.selectedClaimId, "base-rent");
  assertEquals(inheritedRent.baseClaimId, "base-rent");
  assert(!("normalizedValue" in inheritedRent), "resolver must not copy or rewrite source claim values");
});

Deno.test("5/6/7/8/9/10/11: assignment affects only party/assignment concepts, preserves economics, and missing base makes inherited economics require related document", () => {
  const base = doc("base", "base_lease", "primary_base_document");
  const assignment = doc("assignment", "lease_assignment", "assignment_document");
  const result = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, assignment],
    relationships: [rel("rel-assign", "assignment", "base", "assigns")],
    claims: [
      claim("old-tenant", "base", "tenant_name", "Old Tenant LLC"),
      claim("base-rent", "base", "monthly_rent", "1000"),
      claim("base-cam", "base", "cam_amount", "250"),
      claim("base-premises", "base", "property_address", "100 Main"),
      claim("new-tenant", "assignment", "tenant_name", "New Tenant LLC"),
      claim("assign-rent", "assignment", "monthly_rent", "2000"),
      claim("deposit-transfer", "assignment", "security_deposit", "transferred to assignee"),
    ],
  });

  assertEquals(byConcept(result, "tenant_name").selectedClaimId, "new-tenant");
  assertEquals(byConcept(result, "tenant_name").precedenceRule, "assignment_party_change");
  assertEquals(byConcept(result, "monthly_rent").selectedClaimId, "base-rent");
  assertEquals(byConcept(result, "monthly_rent").status, "inherited");
  assertEquals(byConcept(result, "cam_amount").selectedClaimId, "base-cam");
  assertEquals(byConcept(result, "property_address").selectedClaimId, "base-premises");
  assertEquals(byConcept(result, "security_deposit").selectedClaimId, "deposit-transfer");
  assert(result.conflicts.some((conflict) => conflict.conflictType === "domain_scope_conflict" && conflict.candidateClaimIds.includes("assign-rent")));

  const missingBase = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [assignment],
    relationships: [],
    requirements: [{
      id: "req-base",
      orgId: ORG,
      packageId: PACKAGE,
      requestingPackageDocumentId: "assignment",
      requirementType: "base_lease",
      requirementStatus: "open",
      reasonCode: "ASSIGNMENT_REQUIRES_BASE",
    }],
    requestedConceptKeys: ["monthly_rent", "cam_amount", "tenant_name"],
    claims: [claim("new-tenant", "assignment", "tenant_name", "New Tenant LLC")],
  });
  assertEquals(byConcept(missingBase, "tenant_name").selectedClaimId, "new-tenant");
  assertEquals(byConcept(missingBase, "monthly_rent").status, "requires_related_document");
  assertEquals(byConcept(missingBase, "cam_amount").relatedDocumentRequirementId, "req-base");

  const competing = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, assignment, doc("assignment2", "lease_assignment", "assignment_document")],
    relationships: [rel("assign-1", "assignment", "base", "assigns"), rel("assign-2", "assignment2", "base", "assigns")],
    claims: [
      claim("tenant-a", "assignment", "tenant_name", "Tenant A"),
      claim("tenant-b", "assignment2", "tenant_name", "Tenant B"),
    ],
  });
  assertEquals(byConcept(competing, "tenant_name").status, "needs_review");
  assertEquals(byConcept(competing, "tenant_name").conflict?.type, "competing_assignments");
});

Deno.test("12/13/14/15/16/17/18/19: amendments override only explicit concepts and never use amendment number, upload order, filename, or bare value difference", () => {
  const base = doc("base", "base_lease", "primary_base_document");
  const amendment = doc("amend", "lease_amendment", "amendment_document");
  const result = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [amendment, base],
    relationships: [rel("rel-amend", "amend", "base", "amends")],
    claims: [
      claim("base-rent", "base", "monthly_rent", "1000"),
      claim("base-cam", "base", "cam_amount", "250"),
      claim("amended-rent", "amend", "monthly_rent", "1200"),
      claim("all-other", "amend", "all_other_terms_remain_same", "true"),
    ],
  });
  assertEquals(byConcept(result, "monthly_rent").selectedClaimId, "amended-rent");
  assertEquals(byConcept(result, "cam_amount").selectedClaimId, "base-cam");
  assertEquals(byConcept(result, "cam_amount").status, "inherited");
  assert(!result.resolutions.some((row) => /upload|filename|created_at|amendment_number/i.test(row.precedenceRule)));

  const noRelationship = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, amendment],
    relationships: [],
    claims: [claim("base-rent", "base", "monthly_rent", "1000"), claim("amended-rent", "amend", "monthly_rent", "1200")],
  });
  assertEquals(byConcept(noRelationship, "monthly_rent").selectedClaimId, "base-rent");

  const conflict = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, amendment, doc("amend2", "lease_amendment", "amendment_document")],
    relationships: [rel("rel-amend", "amend", "base", "amends"), rel("rel-amend2", "amend2", "base", "amends")],
    claims: [claim("rent-1", "amend", "monthly_rent", "1200"), claim("rent-2", "amend2", "monthly_rent", "1300")],
  });
  assertEquals(byConcept(conflict, "monthly_rent").status, "needs_review");
  assertEquals(byConcept(conflict, "monthly_rent").conflict?.type, "multiple_explicit_overrides");

  const missingPrior = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, amendment],
    relationships: [rel("rel-amend", "amend", "base", "amends")],
    requirements: [{
      id: "req-prior",
      orgId: ORG,
      packageId: PACKAGE,
      requestingPackageDocumentId: "amend",
      requirementType: "prior_amendment",
      requirementStatus: "open",
      reasonCode: "PRIOR_AMENDMENT_REFERENCE",
    }],
    requestedConceptKeys: ["renewal_options"],
    claims: [],
  });
  assertEquals(byConcept(missingPrior, "renewal_options").status, "requires_related_document");
});

Deno.test("20/21/22/23/24/25/26/27/28/29/30/31: combined documents, extension/renewal and commencement are independently scoped and never calculate dates", () => {
  const base = doc("base", "base_lease", "primary_base_document");
  const combo = doc("combo", "assignment_and_amendment", "assignment_document");
  const extension = doc("extension", "lease_extension", "extension_document");
  const renewal = doc("renewal", "lease_renewal", "renewal_document");
  const cert = doc("cert", "commencement_certificate", "commencement_document");
  const result = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, combo, extension, renewal, cert],
    relationships: [
      rel("combo-assign", "combo", "base", "assigns"),
      rel("combo-amend", "combo", "base", "amends"),
      rel("extend", "extension", "base", "extends"),
      rel("renew", "renewal", "base", "renews"),
      rel("commence", "cert", "base", "resolves_commencement"),
    ],
    claims: [
      claim("base-rent", "base", "monthly_rent", "1000"),
      claim("combo-tenant", "combo", "tenant_name", "New Tenant"),
      claim("combo-cam", "combo", "cam_amount", "300"),
      claim("extension-option", "extension", "renewal_options", "one five-year extension"),
      claim("extension-rent", "extension", "monthly_rent", "1300"),
      claim("renewal-rent", "renewal", "monthly_rent", "1400"),
      claim("cert-commence", "cert", "commencement_date", "2024-01-01"),
      claim("cert-cam", "cert", "cam_amount", "999"),
      claim("cert-tenant", "cert", "tenant_name", "Wrong Tenant"),
    ],
  });
  assertEquals(byConcept(result, "tenant_name").selectedClaimId, "combo-tenant");
  assertEquals(byConcept(result, "cam_amount").selectedClaimId, "combo-cam");
  assertEquals(byConcept(result, "renewal_options").selectedClaimId, "extension-option");
  assertEquals(byConcept(result, "monthly_rent").status, "needs_review");
  assertEquals(byConcept(result, "commencement_date").selectedClaimId, "cert-commence");
  assert(result.conflicts.some((conflict) => conflict.conflictType === "domain_scope_conflict" && conflict.candidateClaimIds.includes("cert-cam")));
  assert(result.conflicts.some((conflict) => conflict.conflictType === "domain_scope_conflict" && conflict.candidateClaimIds.includes("cert-tenant")));
  assert(result.resolutions.every((row) => row.reasonCodes.includes("NO_DATE_CALCULATION") || row.precedenceRule !== "commencement_certificate_resolution"));
});

Deno.test("32/33/34/35/36/37/38/39: guaranty and addenda are domain-limited; cross-domain claims require review", () => {
  const base = doc("base", "base_lease", "primary_base_document");
  const guaranty = doc("guaranty", "guaranty", "guaranty_document");
  const rentAddendum = doc("rentadd", "rent_addendum", "addendum_document");
  const camAddendum = doc("camadd", "cam_addendum", "addendum_document");
  const workLetter = doc("work", "work_letter", "exhibit_document");
  const result = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, guaranty, rentAddendum, camAddendum, workLetter],
    relationships: [
      rel("guarantees", "guaranty", "base", "guarantees"),
      rel("rent-inc", "rentadd", "base", "incorporates"),
      rel("cam-inc", "camadd", "base", "incorporates"),
      rel("work-inc", "work", "base", "incorporates"),
    ],
    claims: [
      claim("base-tenant", "base", "tenant_name", "Tenant"),
      claim("base-rent", "base", "monthly_rent", "1000"),
      claim("guarantor", "guaranty", "dynamic.guarantor_name", "Guarantor LLC"),
      claim("guaranty-rent", "guaranty", "monthly_rent", "0"),
      claim("rent-add", "rentadd", "monthly_rent", "1100"),
      claim("rent-add-cam", "rentadd", "cam_amount", "222"),
      claim("cam-add", "camadd", "cam_amount", "333"),
      claim("cam-add-rent", "camadd", "monthly_rent", "3333"),
      claim("work-ti", "work", "ti_allowance", "50000"),
    ],
  });
  assertEquals(byConcept(result, "dynamic.guarantor_name").selectedClaimId, "guarantor");
  assertEquals(byConcept(result, "tenant_name").selectedClaimId, "base-tenant");
  assertEquals(byConcept(result, "monthly_rent").selectedClaimId, "rent-add");
  assertEquals(byConcept(result, "cam_amount").selectedClaimId, "cam-add");
  assertEquals(byConcept(result, "ti_allowance").selectedClaimId, "work-ti");
  assert(result.conflicts.some((conflict) => conflict.conflictType === "domain_scope_conflict" && conflict.candidateClaimIds.includes("rent-add-cam")));
  assert(result.conflicts.some((conflict) => conflict.conflictType === "domain_scope_conflict" && conflict.candidateClaimIds.includes("cam-add-rent")));
  assert(result.conflicts.some((conflict) => conflict.conflictType === "domain_scope_conflict" && conflict.candidateClaimIds.includes("guaranty-rent")));
});

Deno.test("40/41/42/43/51/52/53/57: supersession and open package conflicts preserve candidates until reviewer selection", () => {
  const base = doc("base", "base_lease", "primary_base_document");
  const restatement1 = doc("restatement1", "lease_amendment", "amendment_document");
  const restatement2 = doc("restatement2", "lease_amendment", "amendment_document");
  const conflicted = {
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, restatement1, restatement2],
    relationships: [rel("super-1", "restatement1", "base", "supersedes"), rel("super-2", "restatement2", "base", "supersedes")],
    claims: [claim("super-rent-1", "restatement1", "monthly_rent", "1500"), claim("super-rent-2", "restatement2", "monthly_rent", "1600")],
  };
  const result = resolvePackageClaims(conflicted);
  assertEquals(byConcept(result, "monthly_rent").status, "needs_review");
  assertEquals(byConcept(result, "monthly_rent").conflict?.type, "supersession_ambiguous");
  assertEquals(byConcept(result, "monthly_rent").conflict?.candidateClaimIds, ["super-rent-1", "super-rent-2"]);

  const reviewerResolved = resolvePackageClaims({
    ...conflicted,
    reviewerDecisions: [{
      conceptKey: "monthly_rent",
      operation: "choose_claim",
      selectedClaimId: "super-rent-2",
    }],
  });
  assertEquals(byConcept(reviewerResolved, "monthly_rent").status, "effective");
  assertEquals(byConcept(reviewerResolved, "monthly_rent").selectedClaimId, "super-rent-2");
  assertEquals(result.conflicts[0].candidateClaimIds, ["super-rent-1", "super-rent-2"]);
});

Deno.test("45/46/50/59/60/61/62/63/64: invalid relationships and scope boundaries do not produce runtime or compatibility side effects", () => {
  const base = doc("base", "base_lease", "primary_base_document");
  const amendment = doc("amend", "lease_amendment", "amendment_document");
  const wrongPackageRelationship = {
    ...rel("wrong-pkg", "amend", "base", "amends"),
    packageId: "foreign-package",
  };
  const staleRelationship = {
    ...rel("stale-rel", "amend", "base", "amends"),
    generationId: "old-generation",
  };
  const result = resolvePackageClaims({
    orgId: ORG,
    packageId: PACKAGE,
    documents: [base, amendment],
    relationships: [wrongPackageRelationship, staleRelationship],
    claims: [claim("base-rent", "base", "monthly_rent", "1000"), claim("amend-rent", "amend", "monthly_rent", "1200")],
  });
  assertEquals(byConcept(result, "monthly_rent").selectedClaimId, "base-rent");
  assertEquals(byConcept(result, "monthly_rent").status, "inherited");
  assertEquals(result.overrides.length, 0);
  assertEquals(result.conflicts.length, 0);
  assert(!("fields" in result));
  assert(!("field_evidence" in result));
  assert(!("extraction_data" in result));
  assert(!("workflow_output" in result));
});
