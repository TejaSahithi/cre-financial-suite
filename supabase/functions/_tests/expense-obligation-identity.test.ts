// @ts-nocheck
// Phase 6A deterministic identity (expense-obligation-identity.ts,
// correction D). obligationId must never be crypto.randomUUID() -- same
// input twice -> same id, different generation -> different id.

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { stableHash, buildObligationId } from "../_shared/extraction/canonical/financial/expense-obligation-identity.ts";

Deno.test("stableHash: identical objects (regardless of key construction order) hash identically", () => {
  const a = { x: 1, y: 2, z: { nested: true } };
  const b = { z: { nested: true }, y: 2, x: 1 };
  assertEquals(stableHash(a), stableHash(b));
});

Deno.test("stableHash: array order is preserved (semantically meaningful, not sorted)", () => {
  const a = { list: [1, 2, 3] };
  const b = { list: [3, 2, 1] };
  assertNotEquals(stableHash(a), stableHash(b));
});

Deno.test("stableHash: different content hashes differently", () => {
  assertNotEquals(stableHash({ a: 1 }), stableHash({ a: 2 }));
});

Deno.test("buildObligationId: identical inputs produce the identical id (reproducible, not random)", () => {
  const args = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", specialistDomain: "insurance", sourceSchemaVersion: "insurance-obligation-v1", sourceObligationIndex: 0, sourcePage: 4, sourceQuote: "some quote" };
  assertEquals(buildObligationId(args), buildObligationId({ ...args }));
});

Deno.test("buildObligationId: a different generationId produces a different id", () => {
  const args = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", specialistDomain: "insurance", sourceSchemaVersion: "insurance-obligation-v1", sourceObligationIndex: 0, sourcePage: 4, sourceQuote: "some quote" };
  const idA = buildObligationId(args);
  const idB = buildObligationId({ ...args, generationId: "gen-2" });
  assertNotEquals(idA, idB);
});

Deno.test("buildObligationId: a different sourceObligationIndex produces a different id (two obligations from the same call don't collide)", () => {
  const args = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", specialistDomain: "insurance", sourceSchemaVersion: "insurance-obligation-v1", sourceObligationIndex: 0, sourcePage: 4, sourceQuote: "some quote" };
  assert(buildObligationId(args) !== buildObligationId({ ...args, sourceObligationIndex: 1 }));
});
