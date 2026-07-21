// @ts-nocheck
// P3.1 -- document profile registry + vocabulary reconciliation tests.
import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  DOCUMENT_PROFILES,
  LEGACY_VOCABULARY_RECONCILIATION,
  CANONICAL_PROFILES_WITH_NO_LEGACY_MAPPING,
  getDocumentProfile,
  resolveLegacyValue,
  validateDocumentProfileRegistry,
  computeDocumentProfileRegistryHash,
} from "../_shared/extraction/document-package/profile-registry.ts";
import { DOCUMENT_PROFILE_REGISTRY_VERSION } from "../_shared/extraction/document-package/profile-registry-version.ts";

// The real, confirmed-during-P3.0-exploration enum values -- copied here
// (not imported) so this test also catches drift if profile-registry.ts is
// edited without updating this list, or vice versa. Sources:
//   document_subtype: supabase/migrations/20260423001000_phase1_observability_baseline.sql:111-128
//   document_profile: supabase/functions/_shared/extraction/openai-fact-ledger/profile-classifier.ts:20-28
const REAL_DOCUMENT_SUBTYPE_VALUES = [
  "base_lease", "amendment", "assignment", "consent", "extension", "addendum",
  "expense_backup", "cam_support", "budget_support", "rent_roll", "generic",
];
const REAL_DOCUMENT_PROFILE_VALUES = [
  "full_lease", "assignment", "amendment", "assignment_amendment", "abstract", "addendum", "exhibit",
];

Deno.test("registry validation passes with zero errors", () => {
  const result = validateDocumentProfileRegistry();
  assertEquals(result.errors, []);
  assert(result.valid);
});

Deno.test("exactly 13 canonical profiles are registered, no duplicates", () => {
  assertEquals(DOCUMENT_PROFILES.length, 13);
  const keys = new Set(DOCUMENT_PROFILES.map((p) => p.profileKey));
  assertEquals(keys.size, 13);
});

Deno.test("every real document_subtype value has a reconciliation entry", () => {
  for (const value of REAL_DOCUMENT_SUBTYPE_VALUES) {
    const mapping = resolveLegacyValue("document_subtype", value);
    assert(mapping, `document_subtype value '${value}' has no reconciliation entry`);
  }
});

Deno.test("every real document_profile value has a reconciliation entry", () => {
  for (const value of REAL_DOCUMENT_PROFILE_VALUES) {
    const mapping = resolveLegacyValue("document_profile", value);
    assert(mapping, `document_profile value '${value}' has no reconciliation entry`);
  }
});

Deno.test("the reconciliation matrix contains no entries beyond the confirmed real values (catches stale/typo'd entries)", () => {
  for (const mapping of LEGACY_VOCABULARY_RECONCILIATION) {
    const realValues = mapping.legacyVocabulary === "document_subtype" ? REAL_DOCUMENT_SUBTYPE_VALUES : REAL_DOCUMENT_PROFILE_VALUES;
    assert(realValues.includes(mapping.legacyValue), `reconciliation entry '${mapping.legacyVocabulary}:${mapping.legacyValue}' does not match any confirmed real enum value`);
  }
});

Deno.test("no legacy value silently resolves to base_lease unless it is a genuine direct match", () => {
  // Only full_lease (document_profile) and base_lease (document_subtype)
  // itself may map to base_lease -- 'generic' and any unsupported/ambiguous
  // value must NOT.
  for (const mapping of LEGACY_VOCABULARY_RECONCILIATION) {
    if (mapping.canonicalProfiles.includes("base_lease")) {
      assert(
        mapping.mappingType === "direct" && (mapping.legacyValue === "base_lease" || mapping.legacyValue === "full_lease"),
        `'${mapping.legacyVocabulary}:${mapping.legacyValue}' unexpectedly maps to base_lease`,
      );
    }
  }
  const genericMapping = resolveLegacyValue("document_subtype", "generic");
  assertEquals(genericMapping?.canonicalProfiles, ["unknown_supported_document"]);
});

Deno.test("the addendum ambiguity rule is explicit for both vocabularies", () => {
  const subtypeAddendum = resolveLegacyValue("document_subtype", "addendum");
  const profileAddendum = resolveLegacyValue("document_profile", "addendum");
  assertEquals(subtypeAddendum?.mappingType, "ambiguous");
  assertEquals([...subtypeAddendum!.canonicalProfiles].sort(), ["cam_addendum", "rent_addendum"]);
  assertEquals(profileAddendum?.mappingType, "ambiguous");
  assertEquals([...profileAddendum!.canonicalProfiles].sort(), ["cam_addendum", "rent_addendum"]);
});

Deno.test("combined assignment_amendment signal maps distinctly, not as two separate ambiguous records", () => {
  const mapping = resolveLegacyValue("document_profile", "assignment_amendment");
  assertEquals(mapping?.mappingType, "direct");
  assertEquals(mapping?.canonicalProfiles, ["assignment_and_amendment"]);
});

Deno.test("unsupported legacy values are documented, not silently dropped", () => {
  for (const value of ["consent", "expense_backup", "cam_support", "budget_support", "rent_roll"]) {
    const mapping = resolveLegacyValue("document_subtype", value);
    assertEquals(mapping?.mappingType, "unsupported");
    assertEquals(mapping?.canonicalProfiles, []);
    assert(mapping!.reason.length > 10);
  }
  const abstractMapping = resolveLegacyValue("document_profile", "abstract");
  assertEquals(abstractMapping?.mappingType, "unsupported");
});

Deno.test("canonical profiles with no legacy mapping are exactly the 4 confirmed net-new profiles", () => {
  assertEquals([...CANONICAL_PROFILES_WITH_NO_LEGACY_MAPPING].sort(), ["commencement_certificate", "guaranty", "lease_renewal", "work_letter"]);
  for (const key of CANONICAL_PROFILES_WITH_NO_LEGACY_MAPPING) {
    const referencedAnywhere = LEGACY_VOCABULARY_RECONCILIATION.some((m) => m.canonicalProfiles.includes(key));
    assert(!referencedAnywhere, `${key} is listed as having no legacy mapping but appears in the reconciliation matrix`);
    assert(getDocumentProfile(key), `${key} must still be a real registered profile`);
  }
});

Deno.test("registry version is lease-document-profiles-v1", () => {
  assertEquals(DOCUMENT_PROFILE_REGISTRY_VERSION, "lease-document-profiles-v1");
});

Deno.test("computeDocumentProfileRegistryHash is deterministic", async () => {
  const h1 = await computeDocumentProfileRegistryHash();
  const h2 = await computeDocumentProfileRegistryHash();
  assertEquals(h1, h2);
  assertMatch(h1, /^[0-9a-f]{64}$/);
});

Deno.test("getDocumentProfile resolves every canonical key and returns undefined for garbage", () => {
  for (const profile of DOCUMENT_PROFILES) {
    assert(getDocumentProfile(profile.profileKey));
  }
  assertEquals(getDocumentProfile("not_a_real_profile"), undefined);
});
