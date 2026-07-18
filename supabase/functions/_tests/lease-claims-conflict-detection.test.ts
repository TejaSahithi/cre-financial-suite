// @ts-nocheck
// P2.5 -- claim-comparison.ts / claim-conflict-detector.ts unit tests.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { claimValuesEqual } from "../_shared/extraction/claims/adapters/claim-comparison.ts";
import { normalizeMoney, normalizePercentage } from "../_shared/extraction/claims/adapters/claim-normalization.ts";
import { detectClaimConflicts } from "../_shared/extraction/claims/adapters/claim-conflict-detector.ts";

Deno.test("claimValuesEqual: equivalent money representations do not conflict", () => {
  const a = normalizeMoney("6004");
  const b = normalizeMoney("6004.00");
  const c = normalizeMoney("$6,004.00");
  assert(claimValuesEqual("money", a, b));
  assert(claimValuesEqual("money", b, c));
  assert(claimValuesEqual("money", a, c));
});

Deno.test("claimValuesEqual: genuinely different money values conflict", () => {
  const a = normalizeMoney("6004");
  const b = normalizeMoney("6500");
  assertFalse(claimValuesEqual("money", a, b));
});

Deno.test("claimValuesEqual: equivalent percentage representations do not conflict", () => {
  assert(claimValuesEqual("percentage", normalizePercentage("5%"), normalizePercentage("5")));
});

Deno.test("claimValuesEqual: names -- different companies conflict, trivial case variation does not", () => {
  assertFalse(claimValuesEqual("string", "ABC LLC", "XYZ LLC"));
  assert(claimValuesEqual("string", "ABC LLC", "abc llc"));
  assert(claimValuesEqual("string", "  Acme Corp  ", "Acme Corp"));
});

Deno.test("claimValuesEqual: null handling -- both null is equal, one null is not", () => {
  assert(claimValuesEqual("money", null, null));
  assertFalse(claimValuesEqual("money", "6004.00", null));
  assertFalse(claimValuesEqual("money", null, "6004.00"));
});

Deno.test("detectClaimConflicts: single-cardinality concept with two distinct values produces exactly one conflict group", () => {
  const claims = [
    { claimKey: "c1", conceptKey: "monthly_rent", scopeKey: "lease", instanceKey: "default", valueType: "money", normalizedValue: "5000.00", assertionStatus: "asserted" },
    { claimKey: "c2", conceptKey: "monthly_rent", scopeKey: "lease", instanceKey: "default", valueType: "money", normalizedValue: "5500.00", assertionStatus: "asserted" },
  ];
  const conflicts = detectClaimConflicts(claims);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].memberClaimKeys.sort(), ["c1", "c2"]);
  assertEquals(conflicts[0].distinctValues.length, 2);
});

Deno.test("detectClaimConflicts: equivalent representations of the same value do not create a conflict", () => {
  const claims = [
    { claimKey: "c1", conceptKey: "monthly_rent", scopeKey: "lease", instanceKey: "default", valueType: "money", normalizedValue: normalizeMoney("$6,004.00"), assertionStatus: "asserted" },
    { claimKey: "c2", conceptKey: "monthly_rent", scopeKey: "lease", instanceKey: "default", valueType: "money", normalizedValue: normalizeMoney("6004"), assertionStatus: "asserted" },
  ];
  assertEquals(detectClaimConflicts(claims).length, 0);
});

Deno.test("detectClaimConflicts: a single claim for a fact slot never conflicts with itself", () => {
  const claims = [
    { claimKey: "c1", conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default", valueType: "string", normalizedValue: "Acme Corp", assertionStatus: "asserted" },
  ];
  assertEquals(detectClaimConflicts(claims).length, 0);
});

Deno.test("detectClaimConflicts: different fact slots (different concept/scope/instance) never cross-contaminate", () => {
  const claims = [
    { claimKey: "c1", conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default", valueType: "string", normalizedValue: "ABC LLC", assertionStatus: "asserted" },
    { claimKey: "c2", conceptKey: "landlord_name", scopeKey: "lease", instanceKey: "default", valueType: "string", normalizedValue: "XYZ LLC", assertionStatus: "asserted" },
  ];
  assertEquals(detectClaimConflicts(claims).length, 0);
});

Deno.test("detectClaimConflicts: not_present claims are ignored -- absence never conflicts with a present value", () => {
  const claims = [
    { claimKey: "c1", conceptKey: "broker_name", scopeKey: "lease", instanceKey: "default", valueType: "string", normalizedValue: "Some Broker", assertionStatus: "asserted" },
    { claimKey: "c2", conceptKey: "broker_name", scopeKey: "lease", instanceKey: "default", valueType: "string", normalizedValue: null, assertionStatus: "not_present" },
  ];
  assertEquals(detectClaimConflicts(claims).length, 0);
});

Deno.test("detectClaimConflicts: is idempotent -- running twice over the same input produces the same result", () => {
  const claims = [
    { claimKey: "c1", conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default", valueType: "string", normalizedValue: "ABC LLC", assertionStatus: "asserted" },
    { claimKey: "c2", conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default", valueType: "string", normalizedValue: "XYZ LLC", assertionStatus: "asserted" },
  ];
  assertEquals(detectClaimConflicts(claims), detectClaimConflicts(claims));
});
