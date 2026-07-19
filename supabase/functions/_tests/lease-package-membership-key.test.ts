// @ts-nocheck
// P3.3 -- deterministic package/membership/decision key derivation tests.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { computeDecisionKey, computeMembershipKey, computePackageKey } from "../_shared/extraction/document-package/package-membership-key.ts";

Deno.test("computePackageKey is deterministic for the same inputs", () => {
  const params = { orgId: "org-1", leaseId: "lease-1", canonicalPrimaryUploadedFileId: "file-1" };
  assertEquals(computePackageKey(params), computePackageKey(params));
});

Deno.test("computePackageKey never depends on anything but org/lease/file", () => {
  const a = computePackageKey({ orgId: "org-1", leaseId: "lease-1", canonicalPrimaryUploadedFileId: "file-1" });
  const b = computePackageKey({ orgId: "org-1", leaseId: "lease-1", canonicalPrimaryUploadedFileId: "file-1" });
  assertEquals(a, b);
  // Different file -> different key.
  const c = computePackageKey({ orgId: "org-1", leaseId: "lease-1", canonicalPrimaryUploadedFileId: "file-2" });
  assertNotEquals(a, c);
});

Deno.test("computePackageKey uses a stable 'none' sentinel for a null lease, not an empty/undefined gap", () => {
  const key = computePackageKey({ orgId: "org-1", leaseId: null, canonicalPrimaryUploadedFileId: "file-1" });
  assertEquals(key, "org-1:none:file-1:v1");
});

Deno.test("computeMembershipKey mirrors add_document_to_lease_package's own default formula", () => {
  const key = computeMembershipKey({
    orgId: "org-1", packageId: "pkg-1", uploadedFileId: "file-1", generationId: "gen-1", membershipRole: "primary_base_document",
  });
  assertEquals(key, "org-1:pkg-1:file-1:gen-1:primary_base_document");
});

Deno.test("computeDecisionKey is scoped to org+file+run+generation, distinct per generation", () => {
  const gen1 = computeDecisionKey({ orgId: "org-1", uploadedFileId: "file-1", extractionRunId: "run-1", generationId: "gen-1" });
  const gen2 = computeDecisionKey({ orgId: "org-1", uploadedFileId: "file-1", extractionRunId: "run-2", generationId: "gen-2" });
  assertNotEquals(gen1, gen2);
  assertEquals(gen1, computeDecisionKey({ orgId: "org-1", uploadedFileId: "file-1", extractionRunId: "run-1", generationId: "gen-1" }));
});
