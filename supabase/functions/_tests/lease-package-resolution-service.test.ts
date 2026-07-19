// @ts-nocheck
// P3.5 -- package resolution service mode and persistence boundary tests.

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolvePackageClaimsForPackage } from "../_shared/extraction/document-package/resolution/package-resolution-service.ts";

const input = {
  orgId: "org-1",
  packageId: "pkg-1",
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
  relationships: [],
  claims: [{
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
    normalizedValue: "1000",
    registryStatus: "registered",
    hasEvidence: true,
  }],
};

function mockSupabase() {
  const calls = [];
  return {
    calls,
    client: {
      rpc(name: string, args: unknown) {
        calls.push({ name, args });
        return Promise.resolve({ data: { success: true, resolution_run_id: "run-id" }, error: null });
      },
    },
  };
}

Deno.test("59: mode off computes package-effective results but creates zero resolution rows", async () => {
  Deno.env.delete("LEASE_DOCUMENT_PACKAGE_MODE");
  const mock = mockSupabase();
  const result = await resolvePackageClaimsForPackage(mock.client, input);
  assertEquals(result.persisted, false);
  assertEquals(mock.calls.length, 0);
  assertEquals(result.resolutions[0].selectedClaimId, "claim-rent");
});

Deno.test("60/61/62/63/64: shadow mode persists only package resolution and changes no compatibility or runtime output", async () => {
  Deno.env.set("LEASE_DOCUMENT_PACKAGE_MODE", "shadow");
  try {
    const mock = mockSupabase();
    const result = await resolvePackageClaimsForPackage(mock.client, input);
    assertEquals(result.persisted, true);
    assertEquals(mock.calls.map((call) => call.name), ["persist_lease_package_resolution"]);
    assert(!("fields" in result));
    assert(!("field_evidence" in result));
    assert(!("extraction_data" in result));
    assert(!("workflow_output" in result));
  } finally {
    Deno.env.delete("LEASE_DOCUMENT_PACKAGE_MODE");
  }
});

Deno.test("active mode is recognized but does not persist without explicit allowActiveWrites in P3.5", async () => {
  Deno.env.set("LEASE_DOCUMENT_PACKAGE_MODE", "active");
  try {
    const mock = mockSupabase();
    const result = await resolvePackageClaimsForPackage(mock.client, input);
    assertEquals(result.persisted, false);
    assertEquals(mock.calls.length, 0);
  } finally {
    Deno.env.delete("LEASE_DOCUMENT_PACKAGE_MODE");
  }
});
