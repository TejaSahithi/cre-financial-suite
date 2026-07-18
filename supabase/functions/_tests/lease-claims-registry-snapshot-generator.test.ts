// @ts-nocheck
// P2.1 — generator determinism tests. The DB snapshot in
// 20260826000000_lease_claim_registry_snapshot.sql is a generated artifact
// of the TS registry (round-2 correction #1); these tests confirm the
// generator itself is deterministic and internally consistent. The actual
// "hash in the DB matches hash(TS registry) right now" check is a
// schema-contract test run against a real reset local Postgres (see
// docs/database — both-lanes verification), not something a pure Deno unit
// test can assert, since it requires a live database.
import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { CLAIM_CONCEPTS, computeRegistryHash } from "../_shared/extraction/claims/concept-registry.ts";
import { CLAIMS_REGISTRY_VERSION } from "../_shared/extraction/claims/registry-version.ts";

// The exact hash value embedded in
// supabase/migrations/20260826000000_lease_claim_registry_snapshot.sql,
// produced by scripts/generate-lease-claim-registry-snapshot.ts and verified
// against a real reset local Postgres instance. If the TS registry changes,
// this constant AND the migration's INSERT statement must be regenerated
// together -- this test catches exactly that drift.
const SNAPSHOT_MIGRATION_REGISTRY_HASH = "4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a";
const SNAPSHOT_MIGRATION_CONCEPT_COUNT = 88;

Deno.test("computeRegistryHash matches the hash embedded in the committed snapshot migration", async () => {
  const hash = await computeRegistryHash();
  assertEquals(hash, SNAPSHOT_MIGRATION_REGISTRY_HASH,
    "TS registry changed since the snapshot migration was generated -- re-run scripts/generate-lease-claim-registry-snapshot.ts and add a new additive migration");
});

Deno.test("CLAIM_CONCEPTS count matches the row count embedded in the committed snapshot migration", () => {
  assertEquals(CLAIM_CONCEPTS.length, SNAPSHOT_MIGRATION_CONCEPT_COUNT);
});

Deno.test("registry version referenced by the snapshot matches the TS registry-version constant", () => {
  assertEquals(CLAIMS_REGISTRY_VERSION, "lease-claims-v1");
});

Deno.test("hash is stable across repeated computation (generator determinism)", async () => {
  const hash1 = await computeRegistryHash();
  const hash2 = await computeRegistryHash();
  const hash3 = await computeRegistryHash();
  assertEquals(hash1, hash2);
  assertEquals(hash2, hash3);
  assertMatch(hash1, /^[0-9a-f]{64}$/);
});

Deno.test("every concept has all fields the snapshot generator requires (no undefined slips into SQL as NULL unexpectedly)", () => {
  for (const concept of CLAIM_CONCEPTS) {
    assert(concept.conceptKey, `concept missing conceptKey`);
    assert(concept.domain, `${concept.conceptKey} missing domain`);
    assert(concept.valueType, `${concept.conceptKey} missing valueType`);
    assert(concept.cardinality, `${concept.conceptKey} missing cardinality`);
    assert(concept.instanceStrategy, `${concept.conceptKey} missing instanceStrategy`);
    assert(typeof concept.evidenceRequired === "boolean", `${concept.conceptKey} evidenceRequired must be boolean`);
    assert(Array.isArray(concept.aliases), `${concept.conceptKey} aliases must be an array`);
    assert(concept.normalizationStrategy, `${concept.conceptKey} missing normalizationStrategy`);
    assert(concept.comparisonStrategy, `${concept.conceptKey} missing comparisonStrategy`);
    assert(typeof concept.active === "boolean", `${concept.conceptKey} active must be boolean`);
    assert(concept.introducedIn, `${concept.conceptKey} missing introducedIn`);
  }
});
