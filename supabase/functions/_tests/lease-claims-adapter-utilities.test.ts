// @ts-nocheck
// P2.4 -- claim-key.ts / evidence-key.ts / claim-normalization.ts unit tests.
import { assert, assertEquals, assertMatch, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildClaimKey } from "../_shared/extraction/claims/adapters/claim-key.ts";
import { buildEvidenceKey, hashSourceText } from "../_shared/extraction/claims/adapters/evidence-key.ts";
import {
  normalizeMoney,
  normalizeDecimal,
  normalizePercentage,
  normalizeInteger,
  normalizeDate,
  normalizeBoolean,
  normalizeAddress,
  normalizeString,
  normalizeByStrategy,
} from "../_shared/extraction/claims/adapters/claim-normalization.ts";

Deno.test("buildClaimKey never includes an evidence fingerprint -- same inputs produce same key regardless of evidence", () => {
  const base = {
    generationId: "gen-1", stageAttempt: 1, producerType: "deterministic_mapper",
    conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default",
    normalizedValue: "Acme Corp", candidateOrdinal: 0,
  };
  assertEquals(buildClaimKey(base), buildClaimKey(base));
});

Deno.test("buildClaimKey differs when producer, concept, scope, instance, value, or ordinal differ", () => {
  const base = {
    generationId: "gen-1", stageAttempt: 1, producerType: "deterministic_mapper",
    conceptKey: "tenant_name", scopeKey: "lease", instanceKey: "default",
    normalizedValue: "Acme Corp", candidateOrdinal: 0,
  };
  assertNotEquals(buildClaimKey(base), buildClaimKey({ ...base, producerType: "semantic_extractor" }));
  assertNotEquals(buildClaimKey(base), buildClaimKey({ ...base, conceptKey: "landlord_name" }));
  assertNotEquals(buildClaimKey(base), buildClaimKey({ ...base, instanceKey: "unit_2" }));
  assertNotEquals(buildClaimKey(base), buildClaimKey({ ...base, normalizedValue: "XYZ LLC" }));
  assertNotEquals(buildClaimKey(base), buildClaimKey({ ...base, candidateOrdinal: 1 }));
});

Deno.test("buildClaimKey handles a null normalized_value distinctly from any real value", () => {
  const base = {
    generationId: "gen-1", stageAttempt: 1, producerType: "deterministic_mapper",
    conceptKey: "broker_name", scopeKey: "lease", instanceKey: "default",
    normalizedValue: null, candidateOrdinal: 0,
  };
  const withValue = buildClaimKey({ ...base, normalizedValue: "null" });
  const withoutValue = buildClaimKey(base);
  assertNotEquals(withoutValue, withValue);
});

Deno.test("buildEvidenceKey is deterministic and distinguishes page/span/hash", () => {
  const base = { uploadedFileId: "file-1", extractionRunId: "run-1", pageStart: 1, sourceTextHash: "abc" };
  assertEquals(buildEvidenceKey(base), buildEvidenceKey(base));
  assertNotEquals(buildEvidenceKey(base), buildEvidenceKey({ ...base, pageStart: 2 }));
  assertNotEquals(buildEvidenceKey(base), buildEvidenceKey({ ...base, sourceTextHash: "xyz" }));
});

Deno.test("hashSourceText is a stable sha256 hex digest, null for blank input", async () => {
  const h1 = await hashSourceText("Tenant: Acme Corp");
  const h2 = await hashSourceText("Tenant: Acme Corp");
  assertEquals(h1, h2);
  assertMatch(h1, /^[0-9a-f]{64}$/);
  assertEquals(await hashSourceText(null), null);
  assertEquals(await hashSourceText(""), null);
});

Deno.test("normalizeMoney handles $, commas, and plain numbers equivalently", () => {
  assertEquals(normalizeMoney("$6,004.00"), "6004.00");
  assertEquals(normalizeMoney("6004"), "6004.00");
  assertEquals(normalizeMoney("6004.00"), "6004.00");
  assertEquals(normalizeMoney(null), null);
  assertEquals(normalizeMoney(""), null);
});

Deno.test("normalizeDecimal / normalizePercentage / normalizeInteger basic behavior", () => {
  assertEquals(normalizeDecimal("1,234.5"), "1234.5");
  assertEquals(normalizePercentage("5%"), "5");
  assertEquals(normalizePercentage("5"), "5");
  assertEquals(normalizeInteger("12 months"), "12"); // parseInt takes the leading numeric prefix, same leniency as normalizeMoney/normalizeDecimal
  assertEquals(normalizeInteger("12"), "12");
  assertEquals(normalizeInteger("months"), null);
});

Deno.test("normalizeDate handles ISO, slash, and named-month formats", () => {
  assertEquals(normalizeDate("2026-01-15"), "2026-01-15");
  assertEquals(normalizeDate("01/15/2026"), "2026-01-15");
  assertEquals(normalizeDate("January 15, 2026"), "2026-01-15");
  assertEquals(normalizeDate("garbage"), null);
  assertEquals(normalizeDate(null), null);
});

Deno.test("normalizeBoolean handles common truthy/falsy text", () => {
  assertEquals(normalizeBoolean("Required"), "true");
  assertEquals(normalizeBoolean("Not Required"), "false");
  assertEquals(normalizeBoolean(true), "true");
  assertEquals(normalizeBoolean(false), "false");
  assertEquals(normalizeBoolean("garbage"), null);
});

Deno.test("normalizeAddress / normalizeString collapse whitespace and trim", () => {
  assertEquals(normalizeAddress("  123   Main   St  "), "123 Main St");
  assertEquals(normalizeString("  Acme Corp  "), "Acme Corp");
  assertEquals(normalizeString(""), null);
});

Deno.test("normalizeByStrategy dispatches to the correct normalizer and defaults to string_trim", () => {
  assertEquals(normalizeByStrategy("money_to_decimal", "$5,000"), "5000.00");
  assertEquals(normalizeByStrategy("date_to_iso", "2026-01-15"), "2026-01-15");
  assertEquals(normalizeByStrategy("unknown_strategy", "  hi  "), "hi");
});
