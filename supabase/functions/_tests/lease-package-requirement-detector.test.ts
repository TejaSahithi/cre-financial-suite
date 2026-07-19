// @ts-nocheck
// P3.3 -- related-document requirement detector: fires ONLY on explicit
// profile/claim evidence, never on "a field happens to be absent."
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectRelatedDocumentRequirement } from "../_shared/extraction/document-package/package-requirement-detector.ts";

function claim(conceptKey: string, normalizedValue: string | null = "some-value"): any {
  return { id: `claim-${conceptKey}`, conceptKey, scopeKey: "lease", instanceKey: "default", normalizedValue, assertionStatus: "asserted" };
}

Deno.test("lease_assignment without a base document in the package creates a base_lease requirement", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "lease_assignment", claims: [], hasBaseDocumentInPackage: false, hasPriorAmendmentInPackage: false,
  });
  assert(requirement);
  assertEquals(requirement!.requirementType, "base_lease");
});

Deno.test("lease_assignment WITH a base document in the package creates no requirement", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "lease_assignment", claims: [], hasBaseDocumentInPackage: true, hasPriorAmendmentInPackage: false,
  });
  assertEquals(requirement, null);
});

Deno.test("guaranty without a base document creates a base_lease requirement (requiresBaseDocument-driven, not hand-listed)", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "guaranty", claims: [], hasBaseDocumentInPackage: false, hasPriorAmendmentInPackage: false,
  });
  assert(requirement);
  assertEquals(requirement!.requirementType, "base_lease");
});

Deno.test("base_lease itself never creates a base_lease requirement against itself", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "base_lease", claims: [], hasBaseDocumentInPackage: false, hasPriorAmendmentInPackage: false,
  });
  assertEquals(requirement, null);
});

Deno.test("missing an ordinary field (no dynamic prior-amendment claim) creates no requirement for an amendment that already has a base document", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "lease_amendment", claims: [claim("assignment_consideration", null)], hasBaseDocumentInPackage: true, hasPriorAmendmentInPackage: false,
  });
  assertEquals(requirement, null);
});

Deno.test("amendment referencing an absent prior amendment via a real dynamic claim creates a prior_amendment requirement", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "lease_amendment", claims: [claim("dynamic.prior_amendment_reference", "Amendment No. 2")],
    hasBaseDocumentInPackage: true, hasPriorAmendmentInPackage: false,
  });
  assert(requirement);
  assertEquals(requirement!.requirementType, "prior_amendment");
  assertEquals(requirement!.evidenceClaimIds, ["claim-dynamic.prior_amendment_reference"]);
});

Deno.test("amendment referencing a prior amendment that IS already in the package creates no requirement", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "lease_amendment", claims: [claim("dynamic.prior_amendment_reference", "Amendment No. 2")],
    hasBaseDocumentInPackage: true, hasPriorAmendmentInPackage: true,
  });
  assertEquals(requirement, null);
});

Deno.test("unclassified profile never produces a requirement", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "unclassified", claims: [], hasBaseDocumentInPackage: false, hasPriorAmendmentInPackage: false,
  });
  assertEquals(requirement, null);
});

Deno.test("unknown_supported_document (requiresBaseDocument=false per registry, confirmed via getDocumentProfile) creates no requirement even without a base document", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "unknown_supported_document", claims: [], hasBaseDocumentInPackage: false, hasPriorAmendmentInPackage: false,
  });
  assertEquals(requirement, null);
});

Deno.test("exhibit (requiresBaseDocument=true per registry, confirmed not assumed) DOES create a base_lease requirement without a base document", () => {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: "exhibit", claims: [], hasBaseDocumentInPackage: false, hasPriorAmendmentInPackage: false,
  });
  assert(requirement);
  assertEquals(requirement!.requirementType, "base_lease");
});
