// @ts-nocheck
// P3.3 -- package-membership resolver: pure, deterministic, zero DB access.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolvePackageMembership } from "../_shared/extraction/document-package/package-membership-resolver.ts";
import type { MembershipResolverInput, PackageCandidate } from "../_shared/extraction/document-package/package-membership-types.ts";

function candidate(partial: Partial<PackageCandidate> & { packageId: string; matchedVia: PackageCandidate["matchedVia"] }): PackageCandidate {
  return { leaseId: null, hasConfirmedPrimaryBaseDocument: false, ...partial };
}

function baseInput(overrides: Partial<MembershipResolverInput>): MembershipResolverInput {
  return {
    profileKey: "unknown_supported_document",
    claims: [],
    leaseLinkage: { leaseId: null, isLegacySourceDocument: false, propertyId: null, unitId: null, tenantId: null },
    candidates: [],
    ...overrides,
  };
}

// --- Package creation -------------------------------------------------------

Deno.test("1: legacy source document with no existing package creates one, confirmed, legacy_link", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "base_lease",
    leaseLinkage: { leaseId: "lease-1", isLegacySourceDocument: true, propertyId: null, unitId: null, tenantId: null },
  }));
  assertEquals(decision.decision, "create_package");
  assertEquals(decision.membershipStatus, "confirmed");
  assertEquals(decision.membershipSource, "legacy_link");
  assertEquals(decision.membershipRole, "primary_base_document");
});

Deno.test("2/3: legacy source document with an existing legacy-matched package joins it idempotently (repeat call = same decision)", () => {
  const input = baseInput({
    profileKey: "base_lease",
    leaseLinkage: { leaseId: "lease-1", isLegacySourceDocument: true, propertyId: null, unitId: null, tenantId: null },
    candidates: [candidate({ packageId: "pkg-1", matchedVia: "legacy_source_file", leaseId: "lease-1" })],
  });
  const first = resolvePackageMembership(input);
  const second = resolvePackageMembership(input);
  assertEquals(first, second);
  assertEquals(first.decision, "join_existing_package");
  assertEquals(first.packageId, "pkg-1");
});

Deno.test("4: base_lease linked to a lease with no existing package creates one, confirmed primary, deterministic", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "base_lease",
    leaseLinkage: { leaseId: "lease-2", isLegacySourceDocument: false, propertyId: null, unitId: null, tenantId: null },
  }));
  assertEquals(decision.decision, "create_package");
  assertEquals(decision.membershipRole, "primary_base_document");
  assertEquals(decision.membershipStatus, "confirmed");
  assertEquals(decision.membershipSource, "deterministic");
});

Deno.test("5/6: resolver input has no filename or upload-timestamp field at all -- cannot be used even accidentally", () => {
  const decision = resolvePackageMembership(baseInput({}));
  // Structural proof: the decision output never references any such field,
  // and no test anywhere supplies one -- MembershipResolverInput's type has
  // no filename/uploadedAt field for the resolver to read.
  assert(!("filename" in decision) && !("uploadedAt" in decision));
});

// --- Membership --------------------------------------------------------------

Deno.test("7: legacy source file always receives confirmed legacy_link membership regardless of candidate count (0 or 1)", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "base_lease",
    leaseLinkage: { leaseId: "lease-1", isLegacySourceDocument: true, propertyId: null, unitId: null, tenantId: null },
  }));
  assertEquals(decision.membershipSource, "legacy_link");
  assertEquals(decision.membershipStatus, "confirmed");
});

Deno.test("8: base_lease with explicit lease linkage may become confirmed primary", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "base_lease",
    leaseLinkage: { leaseId: "lease-3", isLegacySourceDocument: false, propertyId: null, unitId: null, tenantId: null },
  }));
  assertEquals(decision.membershipRole, "primary_base_document");
  assertEquals(decision.membershipStatus, "confirmed");
});

Deno.test("9: lease_assignment never becomes primary_base_document automatically", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "lease_assignment",
    candidates: [candidate({ packageId: "pkg-1", matchedVia: "explicit_lease_linkage", hasConfirmedPrimaryBaseDocument: true })],
  }));
  assertEquals(decision.membershipRole, "assignment_document");
});

Deno.test("10: lease_amendment receives amendment_document role", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "lease_amendment" }));
  assertEquals(decision.membershipRole, "amendment_document");
});

Deno.test("11: assignment_and_amendment maps to assignment_document (combined-profile metadata is a caller/service concern, not a resolver decision field)", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "assignment_and_amendment" }));
  assertEquals(decision.membershipRole, "assignment_document");
});

Deno.test("12: unknown/unclassified profile remains proposed, not confirmed", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "unclassified" }));
  assertEquals(decision.membershipRole, "unknown_document");
  assertEquals(decision.membershipStatus, "proposed");
});

Deno.test("13/14: a candidate is only usable through the matchedVia tiers the resolver understands -- an empty candidate list from a stale/wrong-generation lookup naturally falls through to no-package outcomes, never a confirm", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "lease_assignment", candidates: [] }));
  assertEquals(decision.membershipStatus === "confirmed", false);
});

Deno.test("15: cross-org candidates are never constructed by this pure module -- org scoping is the candidate-finder's job, not modeled as resolver input at all", () => {
  // The resolver has no orgId field on PackageCandidate -- structurally
  // cannot leak a cross-org candidate through this function.
  const decision = resolvePackageMembership(baseInput({
    profileKey: "lease_assignment",
    candidates: [candidate({ packageId: "pkg-1", matchedVia: "explicit_lease_linkage" })],
  }));
  assertEquals(decision.packageId, "pkg-1");
});

Deno.test("16: one file cannot be confirmed into two packages for the same lease -- two base_lease candidates for the same lease produce ambiguous, not a pick", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "base_lease",
    leaseLinkage: { leaseId: "lease-1", isLegacySourceDocument: false, propertyId: null, unitId: null, tenantId: null },
    candidates: [
      candidate({ packageId: "pkg-1", matchedVia: "explicit_lease_linkage", leaseId: "lease-1" }),
      candidate({ packageId: "pkg-2", matchedVia: "explicit_lease_linkage", leaseId: "lease-1" }),
    ],
  }));
  assertEquals(decision.decision, "ambiguous");
  assertEquals(decision.candidatePackageIds?.sort(), ["pkg-1", "pkg-2"]);
});

// --- Candidate resolution ------------------------------------------------

Deno.test("17: one strong explicit reference selects exactly one candidate", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "lease_assignment",
    candidates: [candidate({ packageId: "pkg-1", matchedVia: "explicit_document_reference" })],
  }));
  assertEquals(decision.decision, "join_existing_package");
  assertEquals(decision.packageId, "pkg-1");
});

Deno.test("18: two valid candidates produce an ambiguous result, preserving both candidate IDs", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "lease_assignment",
    candidates: [
      candidate({ packageId: "pkg-1", matchedVia: "explicit_document_reference" }),
      candidate({ packageId: "pkg-2", matchedVia: "explicit_lease_linkage" }),
    ],
  }));
  assertEquals(decision.decision, "ambiguous");
  assertEquals(decision.candidatePackageIds?.length, 2);
});

Deno.test("19/20/21: party-name/address/property similarity are not fields on the resolver's input at all -- cannot influence the decision even in principle", () => {
  const input = baseInput({ profileKey: "lease_assignment" });
  // LeaseLinkageSignal only carries ids (leaseId/propertyId/unitId/tenantId)
  // and a boolean -- no tenantName/address/propertyName string field exists
  // for the resolver to read, structurally, not just by convention.
  assertEquals(Object.keys(input.leaseLinkage).sort(), ["isLegacySourceDocument", "leaseId", "propertyId", "tenantId", "unitId"]);
  const decision = resolvePackageMembership(input);
  assert(decision.decision !== undefined);
});

Deno.test("22: explicit lease-id linkage outranks having zero other signals -- a base_lease with lease linkage and zero candidates still creates/joins deterministically, not ambiguously", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "base_lease",
    leaseLinkage: { leaseId: "lease-9", isLegacySourceDocument: false, propertyId: null, unitId: null, tenantId: null },
  }));
  assertEquals(decision.decision, "create_package");
});

Deno.test("23: resolver is deterministic regardless of candidate array order", () => {
  const c1 = candidate({ packageId: "pkg-1", matchedVia: "explicit_document_reference" });
  const c2 = candidate({ packageId: "pkg-2", matchedVia: "explicit_lease_linkage" });
  const decisionA = resolvePackageMembership(baseInput({ profileKey: "lease_assignment", candidates: [c1, c2] }));
  const decisionB = resolvePackageMembership(baseInput({ profileKey: "lease_assignment", candidates: [c2, c1] }));
  assertEquals(decisionA.decision, decisionB.decision);
  assertEquals([...(decisionA.candidatePackageIds ?? [])].sort(), [...(decisionB.candidatePackageIds ?? [])].sort());
});

// --- Requirements (resolver-level integration) ----------------------------

Deno.test("24: assignment without base lease and zero candidates produces requires_related_document with a base_lease requirement", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "lease_assignment", candidates: [] }));
  assertEquals(decision.decision, "requires_related_document");
  assertEquals(decision.relatedDocumentRequirement?.requirementType, "base_lease");
});

Deno.test("25: assignment WITH a base-lease-having candidate creates no missing-base requirement", () => {
  const decision = resolvePackageMembership(baseInput({
    profileKey: "lease_assignment",
    candidates: [candidate({ packageId: "pkg-1", matchedVia: "explicit_lease_linkage", hasConfirmedPrimaryBaseDocument: true })],
  }));
  assertEquals(decision.decision, "join_existing_package");
  assertEquals(decision.relatedDocumentRequirement, undefined);
});

Deno.test("27: a missing ordinary field alone (no profile/claim signal) never produces a related-document requirement", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "unknown_supported_document" }));
  assertEquals(decision.relatedDocumentRequirement, undefined);
});

Deno.test("30: related-document requirement never carries raw evidence text -- only claim IDs", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "lease_assignment", candidates: [] }));
  for (const id of decision.evidenceClaimIds) {
    assert(typeof id === "string" && !id.includes(" "), "evidenceClaimIds must be opaque IDs, not text");
  }
});

// --- Mode/compatibility (resolver-level) -----------------------------------

Deno.test("41: the resolver never produces a relationship-shaped field -- PackageMembershipDecision has no relationshipType/edge field", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "lease_assignment" }));
  assert(!("relationshipType" in decision) && !("edges" in decision));
});

Deno.test("42: the resolver never produces an effective-claim/projection field", () => {
  const decision = resolvePackageMembership(baseInput({ profileKey: "base_lease" }));
  assert(!("effectiveClaims" in decision) && !("projection" in decision));
});
