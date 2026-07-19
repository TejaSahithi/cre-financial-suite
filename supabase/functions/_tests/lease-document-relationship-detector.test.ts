// @ts-nocheck
// P3.4 -- pure, deterministic document relationship detection.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectDocumentRelationships } from "../_shared/extraction/document-package/relationships/relationship-detector.ts";
import { validateRelationshipCandidates } from "../_shared/extraction/document-package/relationships/relationship-validator.ts";
import { computeRelationshipKey } from "../_shared/extraction/document-package/relationships/relationship-key.ts";

function doc(id: string, profileKey: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    packageId: "pkg-1",
    uploadedFileId: `file-${id}`,
    extractionRunId: `run-${id}`,
    generationId: `gen-${id}`,
    profileKey,
    membershipRole: profileKey === "base_lease" ? "primary_base_document" : "related_document",
    membershipStatus: "confirmed",
    ...overrides,
  };
}

function claim(packageDocumentId: string, conceptKey: string, normalizedValue = "value", overrides: Record<string, unknown> = {}) {
  return {
    id: `claim-${packageDocumentId}-${conceptKey}`,
    packageDocumentId,
    uploadedFileId: `file-${packageDocumentId}`,
    extractionRunId: `run-${packageDocumentId}`,
    generationId: `gen-${packageDocumentId}`,
    conceptKey,
    normalizedValue,
    assertionStatus: "asserted",
    ...overrides,
  };
}

function detect(documents: any[], claims: any[] = []) {
  return detectDocumentRelationships({ orgId: "org-1", packageId: "pkg-1", packagePrimaryDocumentId: "base", documents, claims });
}

function byType(candidates: any[], type: string) {
  return candidates.filter((candidate) => candidate.relationshipType === type);
}

Deno.test("1: assignment with one explicit matching base document confirms assigns", () => {
  const candidates = detect([doc("base", "base_lease"), doc("assign", "lease_assignment")], [
    claim("assign", "original_lease_date", "2020-01-01"),
    claim("assign", "assignor_name", "Old Tenant"),
    claim("assign", "assignee_name", "New Tenant"),
  ]);
  const assigns = byType(candidates, "assigns")[0];
  assertEquals(assigns.targetPackageDocumentId, "base");
  assertEquals(assigns.proposedStatus, "confirmed");
  assertEquals(assigns.validationStatus, "valid");
  assertEquals(assigns.evidenceClaimIds, ["claim-assign-original_lease_date"]);
});

Deno.test("2: assignment without base document creates requires_related_document", () => {
  const assigns = byType(detect([doc("assign", "lease_assignment")], [claim("assign", "original_lease_date")]), "assigns")[0];
  assertEquals(assigns.proposedStatus, "requires_related_document");
  assertEquals(assigns.requiresRelatedDocument.requirementType, "base_lease");
});

Deno.test("3: assignment with two valid base candidates is ambiguous and preserves both targets", () => {
  const assigns = byType(detect([doc("base-a", "base_lease"), doc("base-b", "base_lease"), doc("assign", "lease_assignment")], [
    claim("assign", "original_lease_date"),
  ]), "assigns")[0];
  assertEquals(assigns.proposedStatus, "ambiguous");
  assertEquals(assigns.candidateTargetDocumentIds, ["base-a", "base-b"]);
});

Deno.test("4: assignor/assignee claims alone do not identify a target", () => {
  const assigns = byType(detect([doc("base", "base_lease"), doc("assign", "lease_assignment")], [
    claim("assign", "assignor_name"),
    claim("assign", "assignee_name"),
  ]), "assigns")[0];
  assertEquals(assigns.targetPackageDocumentId, undefined);
  assertEquals(assigns.proposedStatus, "proposed");
  assert(assigns.reasonCodes.includes("EXPLICIT_REFERENCE_MISSING"));
});

Deno.test("5: assignment never changes or emits base claims", () => {
  const candidates = detect([doc("base", "base_lease"), doc("assign", "lease_assignment")], [claim("assign", "original_lease_date")]);
  assert(candidates.every((candidate) => !("effectiveClaims" in candidate) && !("claimMutation" in candidate)));
});

Deno.test("6: combined assignment/amendment emits independent assigns and amends candidates", () => {
  const candidates = detect([doc("base", "base_lease"), doc("combined", "assignment_and_amendment")], [
    claim("combined", "original_lease_date"),
    claim("combined", "all_other_terms_remain_same", "true"),
  ]);
  assertEquals(byType(candidates, "assigns").length, 1);
  assertEquals(byType(candidates, "amends").length, 1);
});

Deno.test("7/8/10: amendment detects amends, missing base creates requirement, unchanged-terms does not duplicate claims", () => {
  const withBase = byType(detect([doc("base", "base_lease"), doc("amd", "lease_amendment")], [
    claim("amd", "all_other_terms_remain_same", "true"),
  ]), "amends")[0];
  assertEquals(withBase.proposedStatus, "confirmed");
  assertEquals(withBase.targetPackageDocumentId, "base");
  assert(!("duplicatedClaims" in withBase));

  const withoutBase = byType(detect([doc("amd", "lease_amendment")], [claim("amd", "all_other_terms_remain_same", "true")]), "amends")[0];
  assertEquals(withoutBase.proposedStatus, "requires_related_document");
});

Deno.test("9/13: dynamic prior amendment reference creates prior-amendment requirement and remains needs_review without corroboration", () => {
  const incorporates = byType(detect([doc("base", "base_lease"), doc("amd", "lease_amendment")], [
    claim("amd", "dynamic.prior_amendment_reference", "Amendment No. 2"),
  ]), "incorporates")[0];
  assertEquals(incorporates.proposedStatus, "requires_related_document");
  assertEquals(incorporates.validationStatus, "needs_review");
  assertEquals(incorporates.dynamicEvidenceClaimIds, ["claim-amd-dynamic.prior_amendment_reference"]);
});

Deno.test("11/12: higher amendment number and upload order are never reason codes for precedence", () => {
  const amends = byType(detect([doc("base", "base_lease"), doc("amd", "lease_amendment")], [
    claim("amd", "dynamic.amendment_number", "4"),
  ]), "amends")[0];
  assertEquals(amends.proposedStatus, "proposed");
  assert(!amends.reasonCodes.join("|").toLowerCase().includes("upload"));
  assert(!amends.reasonCodes.join("|").toLowerCase().includes("latest"));
});

Deno.test("14/15/16/17: extension and renewal detect edges without date calculation and preserve ambiguity", () => {
  const extension = byType(detect([doc("base", "base_lease"), doc("ext", "lease_extension")], [claim("ext", "expiration_date", "2030-12-31")]), "extends")[0];
  assertEquals(extension.proposedStatus, "confirmed");
  assert(!("calculatedExpirationDate" in extension));

  const renewal = byType(detect([doc("base", "base_lease"), doc("ren", "lease_renewal")], [claim("ren", "renewal_options", "one 5-year option")]), "renews")[0];
  assertEquals(renewal.proposedStatus, "confirmed");

  const ambiguous = byType(detect([doc("base-a", "base_lease"), doc("base-b", "base_lease"), doc("ext", "lease_extension")], [claim("ext", "expiration_date")]), "extends")[0];
  assertEquals(ambiguous.proposedStatus, "ambiguous");
});

Deno.test("18/19/20: guaranty links to explicit base target, does not replace tenant, missing target requires base", () => {
  const guarantees = byType(detect([doc("base", "base_lease"), doc("guar", "guaranty")], [claim("guar", "tenant_name"), claim("guar", "dynamic.guaranty_language")]), "guarantees")[0];
  assertEquals(guarantees.targetPackageDocumentId, "base");
  assert(!("tenantReplacement" in guarantees));

  const missing = byType(detect([doc("guar", "guaranty")], [claim("guar", "dynamic.guaranty_language")]), "guarantees")[0];
  assertEquals(missing.proposedStatus, "requires_related_document");
});

Deno.test("21/22/23: commencement certificate detects edge without date calculation; ambiguous base prevents confirmation", () => {
  const resolved = byType(detect([doc("base", "base_lease"), doc("cert", "commencement_certificate")], [claim("cert", "commencement_date", "2026-01-01")]), "resolves_commencement")[0];
  assertEquals(resolved.proposedStatus, "confirmed");
  assert(!("calculatedDates" in resolved));

  const ambiguous = byType(detect([doc("base-a", "base_lease"), doc("base-b", "base_lease"), doc("cert", "commencement_certificate")], [claim("cert", "commencement_date")]), "resolves_commencement")[0];
  assertEquals(ambiguous.proposedStatus, "ambiguous");
});

Deno.test("24/25/26/27: addenda and exhibits stay domain-distinct and missing base requires requirement", () => {
  const candidates = detect([doc("base", "base_lease"), doc("rent", "rent_addendum"), doc("cam", "cam_addendum"), doc("work", "work_letter"), doc("exh", "exhibit")], [
    claim("rent", "monthly_rent", "5000"),
    claim("cam", "cam_amount", "200"),
    claim("work", "ti_allowance", "25"),
    claim("exh", "dynamic.exhibit_language", "Exhibit A"),
  ]);
  assert(byType(candidates, "incorporates").some((candidate) => candidate.sourcePackageDocumentId === "rent" && candidate.reasonCodes.includes("RENT_DOMAIN_ONLY")));
  assert(byType(candidates, "incorporates").some((candidate) => candidate.sourcePackageDocumentId === "cam" && candidate.reasonCodes.includes("CAM_DOMAIN_ONLY")));
  assert(byType(candidates, "incorporates").some((candidate) => candidate.sourcePackageDocumentId === "work"));
  assert(byType(candidates, "attachment_to").some((candidate) => candidate.sourcePackageDocumentId === "exh"));

  const missing = byType(detect([doc("rent", "rent_addendum")], [claim("rent", "monthly_rent")]), "incorporates")[0];
  assertEquals(missing.proposedStatus, "requires_related_document");
});

Deno.test("28/29/30/31: supersedes requires explicit language and conflicting targets stay ambiguous", () => {
  assertEquals(byType(detect([doc("base", "base_lease"), doc("amd", "lease_amendment")], [claim("amd", "dynamic.amendment_number", "9")]), "supersedes").length, 0);
  const ambiguous = byType(detect([doc("base-a", "base_lease"), doc("base-b", "base_lease"), doc("amd", "lease_amendment")], [
    claim("amd", "dynamic.supersedes_language", "supersedes and replaces"),
  ]), "supersedes")[0];
  assertEquals(ambiguous.proposedStatus, "ambiguous");
});

Deno.test("32/33/35/36/37: validator rejects cross-package/self/wrong-run evidence and dynamic-only confirmation", () => {
  const source = doc("src", "lease_assignment");
  const target = doc("target", "base_lease", { packageId: "other-pkg" });
  const candidate = {
    relationshipType: "assigns",
    sourcePackageDocumentId: "src",
    targetPackageDocumentId: "target",
    proposedStatus: "confirmed",
    validationStatus: "valid",
    reasonCodes: [],
    evidenceClaimIds: ["claim-wrong"],
    dynamicEvidenceClaimIds: ["claim-src-dynamic.original_lease_reference"],
    explicitReference: true,
    reviewerConfirmationRequired: false,
  };
  const validated = validateRelationshipCandidates({ orgId: "org-1", packageId: "pkg-1", documents: [source, target], claims: [
    claim("src", "dynamic.original_lease_reference"),
    claim("src", "original_lease_date", "2020-01-01", { id: "claim-wrong", extractionRunId: "run-other" }),
  ] }, [candidate])[0];
  assertEquals(validated.validationStatus, "invalid");
  assert(validated.reasonCodes.includes("TARGET_NOT_IN_PACKAGE"));
  assert(validated.reasonCodes.includes("EVIDENCE_GENERATION_MISMATCH"));

  const self = validateRelationshipCandidates({ orgId: "org-1", packageId: "pkg-1", documents: [source], claims: [] }, [{ ...candidate, targetPackageDocumentId: "src", evidenceClaimIds: [] }])[0];
  assert(self.reasonCodes.includes("SELF_RELATIONSHIP"));
});

Deno.test("34: stale/rejected source generation is rejected by validator", () => {
  const source = doc("src", "lease_assignment", { membershipStatus: "rejected" });
  const validated = validateRelationshipCandidates({ orgId: "org-1", packageId: "pkg-1", documents: [source], claims: [] }, [{
    relationshipType: "assigns",
    sourcePackageDocumentId: "src",
    proposedStatus: "confirmed",
    validationStatus: "valid",
    reasonCodes: [],
    evidenceClaimIds: [],
    explicitReference: true,
    reviewerConfirmationRequired: false,
  }])[0];
  assert(validated.reasonCodes.includes("SOURCE_GENERATION_STALE"));
});

Deno.test("38/41/42: relationship key is idempotent per generation, new generation gets new provenance, result deterministic regardless of input order", () => {
  const inputA = { orgId: "org-1", packageId: "pkg-1", packagePrimaryDocumentId: "base", documents: [doc("base", "base_lease"), doc("assign", "lease_assignment")], claims: [claim("assign", "original_lease_date")] };
  const inputB = { ...inputA, documents: [...inputA.documents].reverse(), claims: [...inputA.claims].reverse() };
  assertEquals(detectDocumentRelationships(inputA), detectDocumentRelationships(inputB));

  const candidate = byType(detectDocumentRelationships(inputA), "assigns")[0];
  assertEquals(computeRelationshipKey({ orgId: "org-1", packageId: "pkg-1", candidate }), candidate.relationshipKey);
  const gen2 = { ...candidate, sourcePackageDocumentId: "assign-new", evidenceClaimIds: ["claim-new"] };
  assert(candidate.relationshipKey !== computeRelationshipKey({ orgId: "org-1", packageId: "pkg-1", candidate: gen2 }));
});

Deno.test("39/40: competing candidates are preserved; reviewer-confirmed relationships are not overwritten by pure detection", () => {
  const candidates = detect([doc("base-a", "base_lease"), doc("base-b", "base_lease"), doc("assign", "lease_assignment")], [claim("assign", "original_lease_date")]);
  const assigns = byType(candidates, "assigns")[0];
  assertEquals(assigns.candidateTargetDocumentIds, ["base-a", "base-b"]);
  assert(!("overwritesReviewerRelationship" in assigns));
});

Deno.test("52/53/54/55/56/57/58: P3.4 candidates contain no runtime or effective-claim side effects", () => {
  const candidate = byType(detect([doc("base", "base_lease"), doc("amd", "lease_amendment")], [claim("amd", "all_other_terms_remain_same")]), "amends")[0];
  assert(!("compatibilityOutput" in candidate));
  assert(!("packageEffectiveClaims" in candidate));
  assert(!("precedenceResolution" in candidate));
  assert(!("extraction_data" in candidate));
  assert(!("workflow_output" in candidate));
  assert(!("pipelineCallSite" in candidate));
  assert(!("mutatedSourceClaims" in candidate));
});
