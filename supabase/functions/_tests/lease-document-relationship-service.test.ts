// @ts-nocheck
// P3.4 -- relationship service mode and RPC contract tests.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectRelationshipsForPackage } from "../_shared/extraction/document-package/relationships/relationship-service.ts";

const FLAG = "LEASE_DOCUMENT_PACKAGE_MODE";

function doc(id: string, profileKey: string) {
  return {
    id,
    packageId: "pkg-1",
    uploadedFileId: `file-${id}`,
    extractionRunId: `run-${id}`,
    generationId: `gen-${id}`,
    profileKey,
    membershipRole: profileKey === "base_lease" ? "primary_base_document" : "related_document",
    membershipStatus: "confirmed",
  };
}

function claim(packageDocumentId: string, conceptKey: string) {
  return {
    id: `claim-${packageDocumentId}-${conceptKey}`,
    packageDocumentId,
    uploadedFileId: `file-${packageDocumentId}`,
    extractionRunId: `run-${packageDocumentId}`,
    generationId: `gen-${packageDocumentId}`,
    conceptKey,
    normalizedValue: "value",
    assertionStatus: "asserted",
  };
}

function input() {
  return {
    orgId: "org-1",
    packageId: "pkg-1",
    documents: [doc("base", "base_lease"), doc("assign", "lease_assignment")],
    claims: [claim("assign", "original_lease_date")],
  };
}

Deno.test("52: mode off computes candidates but produces zero runtime relationship writes", async () => {
  const previous = Deno.env.get(FLAG);
  Deno.env.delete(FLAG);
  try {
    const rpcCalls: unknown[] = [];
    const result = await detectRelationshipsForPackage({ rpc: (...args: unknown[]) => rpcCalls.push(args) }, input());
    assertEquals(result.persisted, false);
    assertEquals(rpcCalls.length, 0);
    assert(result.candidates.some((candidate) => candidate.relationshipType === "assigns"));
  } finally {
    if (previous === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, previous);
  }
});

Deno.test("53: shadow mode persists only relationship candidates and changes no compatibility output", async () => {
  const previous = Deno.env.get(FLAG);
  Deno.env.set(FLAG, "shadow");
  try {
    const rpcCalls: any[] = [];
    const result = await detectRelationshipsForPackage({
      rpc: (name: string, payload: unknown) => {
        rpcCalls.push({ name, payload });
        return Promise.resolve({ data: { success: true, relationships_inserted: 1 }, error: null });
      },
    }, input());
    assertEquals(result.persisted, true);
    assertEquals(rpcCalls.map((call) => call.name), ["persist_lease_document_relationship_candidates"]);
    assert(!("compatibilityOutput" in result));
    assert(!("packageEffectiveClaims" in result));
  } finally {
    if (previous === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, previous);
  }
});

Deno.test("active mode is recognized but does not persist without explicit allowActiveWrites", async () => {
  const previous = Deno.env.get(FLAG);
  Deno.env.set(FLAG, "active");
  try {
    const rpcCalls: unknown[] = [];
    const result = await detectRelationshipsForPackage({ rpc: (...args: unknown[]) => rpcCalls.push(args) }, input());
    assertEquals(result.persisted, false);
    assertEquals(rpcCalls.length, 0);
  } finally {
    if (previous === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, previous);
  }
});
