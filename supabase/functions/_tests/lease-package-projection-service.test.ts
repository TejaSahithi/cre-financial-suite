// @ts-nocheck
// P3.6 -- package projection service mode and persistence boundary tests.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { projectPackageCompatibilityForResolution } from "../_shared/extraction/document-package/projection/package-projection-service.ts";

const input = {
  orgId: "org-1",
  packageId: "pkg-1",
  resolutionRun: { id: "res-run-1", orgId: "org-1", packageId: "pkg-1", status: "completed" },
  documents: [{
    id: "base",
    orgId: "org-1",
    packageId: "pkg-1",
    uploadedFileId: "file-base",
    extractionRunId: "run-1",
    generationId: "gen-1",
    activeGenerationId: "gen-1",
    profileKey: "base_lease",
    membershipRole: "primary_base_document",
    membershipStatus: "confirmed",
  }],
  sourceClaims: [{
    id: "claim-rent",
    orgId: "org-1",
    packageDocumentId: "base",
    uploadedFileId: "file-base",
    extractionRunId: "run-1",
    generationId: "gen-1",
    conceptKey: "monthly_rent",
    scopeKey: "lease",
    instanceKey: "default",
    assertionStatus: "asserted",
    normalizedValue: "1000.00",
    rawValueText: "$1,000.00",
    sourcePage: 2,
    sourceText: "Base rent is $1,000.00.",
    confidence: 90,
    hasEvidence: true,
    producerType: "deterministic_mapper",
    createdAt: "2026-01-01T00:00:00.000Z",
  }],
  effectiveClaims: [{
    conceptKey: "monthly_rent",
    scopeKey: "lease",
    instanceKey: "default",
    status: "effective",
    selectedClaimId: "claim-rent",
    sourcePackageDocumentId: "base",
    precedenceRule: "base_document_source_claim",
    reasonCodes: ["BASE_CLAIM_EFFECTIVE"],
    relationshipPath: [],
  }],
};

function mockSupabase() {
  const calls = [];
  return {
    calls,
    client: {
      rpc(name: string, args: unknown) {
        calls.push({ name, args });
        return Promise.resolve({ data: { success: true, projection_run_id: "pkg-proj-1" }, error: null });
      },
    },
  };
}

Deno.test("59/60/61/62/63/64/65/66: mode off computes only and exposes no runtime write-back fields", async () => {
  Deno.env.delete("LEASE_DOCUMENT_PACKAGE_MODE");
  const mock = mockSupabase();
  const result = await projectPackageCompatibilityForResolution(mock.client, input);
  assertEquals(result.persisted, false);
  assertEquals(mock.calls.length, 0);
  assertEquals(result.compatibilitySlice.fields.monthly_rent.value, "1000.00");
  assert(!("extraction_data" in result));
  assert(!("workflow_output" in result));
  assert(!("finalizer" in result));
});

Deno.test("60/61/62/63/64: shadow persists only package projection and never mutates P2 runtime output", async () => {
  Deno.env.set("LEASE_DOCUMENT_PACKAGE_MODE", "shadow");
  try {
    const mock = mockSupabase();
    const result = await projectPackageCompatibilityForResolution(mock.client, input, {
      singleDocumentCompatibility: { fields: {}, field_evidence: {}, confidence_scores: {} },
    });
    assertEquals(result.persisted, true);
    assertEquals(mock.calls.map((call) => call.name), ["persist_lease_package_projection"]);
    assertEquals(mock.calls[0].args.p_field_projections.length, 1);
    assert(!("extraction_data" in result));
    assert(!("workflow_output" in result));
  } finally {
    Deno.env.delete("LEASE_DOCUMENT_PACKAGE_MODE");
  }
});

Deno.test("active mode is recognized but does not persist without explicit allowActiveWrites in P3.6", async () => {
  Deno.env.set("LEASE_DOCUMENT_PACKAGE_MODE", "active");
  try {
    const mock = mockSupabase();
    const result = await projectPackageCompatibilityForResolution(mock.client, input);
    assertEquals(result.persisted, false);
    assertEquals(mock.calls.length, 0);
  } finally {
    Deno.env.delete("LEASE_DOCUMENT_PACKAGE_MODE");
  }
});
