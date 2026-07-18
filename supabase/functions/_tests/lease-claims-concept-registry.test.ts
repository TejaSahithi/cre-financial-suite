// @ts-nocheck
// P2.1 — concept registry unit tests.

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { LEASE_FIELD_CONTRACT } from "../_shared/extraction/field-contract.ts";
import {
  CLAIM_CONCEPTS,
  CLAIM_CONCEPT_EXCLUSIONS,
  computeRegistryHash,
  getClaimConcept,
  normalizeDynamicKey,
  validateClaimConceptRegistry,
} from "../_shared/extraction/claims/concept-registry.ts";
import { CLAIMS_REGISTRY_VERSION } from "../_shared/extraction/claims/registry-version.ts";

Deno.test("registry validation passes with zero errors", () => {
  const result = validateClaimConceptRegistry();
  assertEquals(result.errors, []);
  assert(result.valid);
});

Deno.test("every LEASE_FIELD_CONTRACT entry is either a registered concept or an explicit, documented exclusion", () => {
  const excludedKeys = new Set(CLAIM_CONCEPT_EXCLUSIONS.map((e) => e.key));
  for (const entry of LEASE_FIELD_CONTRACT) {
    const registered = getClaimConcept(entry.canonicalKey) !== undefined;
    const excluded = excludedKeys.has(entry.canonicalKey);
    assert(
      registered || excluded,
      `field-contract.ts entry '${entry.canonicalKey}' is neither a registered claim concept nor on the documented exclusion list`,
    );
  }
});

Deno.test("every exclusion has a non-empty documented reason", () => {
  for (const exclusion of CLAIM_CONCEPT_EXCLUSIONS) {
    assert(exclusion.reason.length > 20, `exclusion '${exclusion.key}' needs a real documented reason, not a placeholder`);
  }
});

Deno.test("concept count matches field-contract.ts minus documented exclusions", () => {
  assertEquals(CLAIM_CONCEPTS.length, LEASE_FIELD_CONTRACT.length - CLAIM_CONCEPT_EXCLUSIONS.length);
});

Deno.test("no concept uses the dynamic. namespace", () => {
  for (const concept of CLAIM_CONCEPTS) {
    assert(!concept.conceptKey.startsWith("dynamic."), `standard concept '${concept.conceptKey}' must not use the dynamic. namespace`);
  }
});

Deno.test("aliases are sourced from field-contract.ts, not hand-duplicated (spot check known aliases)", () => {
  const tenantName = getClaimConcept("tenant_name");
  assert(tenantName);
  assertEquals([...tenantName.aliases].sort(), ["lessee", "occupant", "tenant"]);

  const monthlyRent = getClaimConcept("monthly_rent");
  assert(monthlyRent);
  assertEquals([...monthlyRent.aliases].sort(), ["base_rent", "base_rent_monthly"]);
});

Deno.test("value-type inference produces sensible types for known fields", () => {
  assertEquals(getClaimConcept("monthly_rent")?.valueType, "money");
  assertEquals(getClaimConcept("security_deposit")?.valueType, "money");
  assertEquals(getClaimConcept("commencement_date")?.valueType, "date");
  assertEquals(getClaimConcept("lease_term_months")?.valueType, "integer");
  assertEquals(getClaimConcept("escalation_rate")?.valueType, "percentage");
  assertEquals(getClaimConcept("tenant_insurance_required")?.valueType, "boolean");
  assertEquals(getClaimConcept("property_address")?.valueType, "address");
  assertEquals(getClaimConcept("tenant_name")?.valueType, "string");
});

Deno.test("registry version is lease-claims-v1 and independent of the payload contract version string", () => {
  assertEquals(CLAIMS_REGISTRY_VERSION, "lease-claims-v1");
});

Deno.test("computeRegistryHash is deterministic across repeated calls", async () => {
  const hash1 = await computeRegistryHash();
  const hash2 = await computeRegistryHash();
  assertEquals(hash1, hash2);
  assertMatch(hash1, /^[0-9a-f]{64}$/);
});

Deno.test("normalizeDynamicKey produces a safe, deterministic dynamic. namespace key", () => {
  assertEquals(normalizeDynamicKey("Tenant's Special Clause!"), "dynamic.tenant_s_special_clause");
  assertEquals(normalizeDynamicKey("  weird__spacing  "), "dynamic.weird_spacing");
  assertEquals(normalizeDynamicKey(""), "dynamic.unknown");
  // Deterministic: same input always produces the same output.
  assertEquals(normalizeDynamicKey("Some Key"), normalizeDynamicKey("Some Key"));
});

Deno.test("excluded fields (computed/row-level-control) are correctly excluded, not silently present", () => {
  assertEquals(getClaimConcept("tenant_pro_rata_share"), undefined);
  assertEquals(getClaimConcept("document_profile"), undefined);
  assertEquals(getClaimConcept("approval_status"), undefined);
});
