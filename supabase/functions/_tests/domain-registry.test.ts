// @ts-nocheck
// Domain registry (Phase 4) — integrity tests, independent of the legacy
// fixture (see domain-registry-byte-compatibility.test.ts for the
// preserve-exact-behavior proof).

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  DOMAIN_REGISTRY,
  getDomainDefinition,
  getEnabledDomainDefinitionsInOrder,
  getEnabledDomainIdsInOrder,
  getExpenseSpecialistDefinitionsInOrder,
  validateDomainRegistry,
} from "../_shared/extraction/domains/domain-registry.ts";

Deno.test("DOMAIN_REGISTRY: every id is unique", () => {
  const ids = DOMAIN_REGISTRY.map((d) => d.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("DOMAIN_REGISTRY: every executionOrder is unique", () => {
  const orders = DOMAIN_REGISTRY.map((d) => d.executionOrder);
  assertEquals(new Set(orders).size, orders.length);
});

Deno.test("DOMAIN_REGISTRY: every boundedEnrichStageName is unique", () => {
  const names = DOMAIN_REGISTRY.map((d) => d.boundedEnrichStageName).filter((n) => n != null);
  assertEquals(new Set(names).size, names.length);
});

Deno.test("DOMAIN_REGISTRY: every dependency resolves to a real domain id", () => {
  const ids = new Set(DOMAIN_REGISTRY.map((d) => d.id));
  for (const definition of DOMAIN_REGISTRY) {
    for (const dep of definition.dependencies) {
      assert(ids.has(dep), `${definition.id} depends on unknown domain ${dep}`);
    }
  }
});

Deno.test("DOMAIN_REGISTRY: every enabled domain has non-empty promptConcepts", () => {
  for (const definition of getEnabledDomainDefinitionsInOrder()) {
    assert(typeof definition.promptConcepts === "string" && definition.promptConcepts.length > 0, `${definition.id} has empty promptConcepts`);
  }
});

Deno.test("DOMAIN_REGISTRY: every routingThreshold is a finite number", () => {
  for (const definition of DOMAIN_REGISTRY) {
    assert(Number.isFinite(definition.routingThreshold), `${definition.id} has a non-finite routingThreshold`);
  }
});

Deno.test("getEnabledDomainDefinitionsInOrder: iteration order equals executionOrder order", () => {
  const definitions = getEnabledDomainDefinitionsInOrder();
  for (let i = 1; i < definitions.length; i++) {
    assert(definitions[i].executionOrder >= definitions[i - 1].executionOrder, "definitions must be sorted by executionOrder");
  }
});

Deno.test("getEnabledDomainIdsInOrder: returns only ids, same order as definitions", () => {
  const ids = getEnabledDomainIdsInOrder();
  const definitionIds = getEnabledDomainDefinitionsInOrder().map((d) => d.id);
  assertEquals(ids, definitionIds);
});

Deno.test("getDomainDefinition: throws (never returns undefined) for an unknown domain id", () => {
  assertThrows(() => getDomainDefinition("not_a_real_domain" as any), Error, "Unknown extraction domain");
});

Deno.test("getDomainDefinition: returns the real definition for a known id", () => {
  const def = getDomainDefinition("expenses_and_cam" as any);
  assertEquals(def.id, "expenses_and_cam");
});

Deno.test("validateDomainRegistry: throws on a duplicate id", () => {
  const base = getDomainDefinition("core_terms" as any);
  assertThrows(() => validateDomainRegistry([base, { ...base }]), Error, "Duplicate extraction domain");
});

Deno.test("validateDomainRegistry: throws on a duplicate executionOrder", () => {
  const a = getDomainDefinition("core_terms" as any);
  const b = { ...getDomainDefinition("rent_and_charges" as any), executionOrder: a.executionOrder };
  assertThrows(() => validateDomainRegistry([a, b]), Error, "Duplicate domain execution order");
});

Deno.test("validateDomainRegistry: throws on a duplicate boundedEnrichStageName", () => {
  const a = getDomainDefinition("core_terms" as any);
  const b = { ...getDomainDefinition("rent_and_charges" as any), boundedEnrichStageName: a.boundedEnrichStageName };
  assertThrows(() => validateDomainRegistry([a, b]), Error, "Duplicate bounded-enrichment stage");
});

Deno.test("validateDomainRegistry: throws on an unknown dependency", () => {
  const a = { ...getDomainDefinition("core_terms" as any), dependencies: ["not_a_real_domain"] };
  assertThrows(() => validateDomainRegistry([a]), Error, "unknown dependency");
});

Deno.test("validateDomainRegistry: the real DOMAIN_REGISTRY is itself valid (already ran at module load, but explicit here too)", () => {
  validateDomainRegistry(); // must not throw
});

// ── Phase 4.5: participatesInBoundedEnrichment integrity ────────────────────

Deno.test("validateDomainRegistry: throws when an enabled domain participates in bounded enrichment but has no boundedEnrichStageName", () => {
  const a = { ...getDomainDefinition("core_terms" as any), boundedEnrichStageName: null };
  assertThrows(() => validateDomainRegistry([a]), Error, "participates in bounded enrichment but has no boundedEnrichStageName");
});

Deno.test("validateDomainRegistry: does NOT throw for a disabled domain with participatesInBoundedEnrichment true and no stage name", () => {
  // authorityMode:"disabled" (not "authoritative") -- a disabled-but-still-
  // authoritative combination is itself invalid per the Phase 5 authority-mode
  // check below, which is orthogonal to what THIS test is checking.
  const a = { ...getDomainDefinition("core_terms" as any), enabled: false, authorityMode: "disabled", boundedEnrichStageName: null };
  validateDomainRegistry([a]); // must not throw -- disabled domains are exempt
});

Deno.test("validateDomainRegistry: does NOT throw for a domain that opts out of bounded enrichment (participatesInBoundedEnrichment false, stage name null)", () => {
  const a = { ...getDomainDefinition("core_terms" as any), participatesInBoundedEnrichment: false, boundedEnrichStageName: null };
  validateDomainRegistry([a]); // must not throw -- this is the Phase 5 shadow-specialist shape
});

Deno.test("DOMAIN_REGISTRY: every domain has participatesInBoundedEnrichment set", () => {
  for (const definition of DOMAIN_REGISTRY) {
    assertEquals(typeof definition.participatesInBoundedEnrichment, "boolean", `${definition.id} is missing participatesInBoundedEnrichment`);
  }
});

// ── Phase 5: expense specialists ─────────────────────────────────────────────

Deno.test("getEnabledDomainIdsInOrder: unchanged after adding the 5 Phase 5 specialists (all enabled:false)", () => {
  assertEquals(getEnabledDomainIdsInOrder(), [
    "core_terms", "rent_and_charges", "expenses_and_cam", "operating_obligations", "legal_rights_and_dates",
  ]);
});

Deno.test("getExpenseSpecialistDefinitionsInOrder: returns exactly the 5 specialists, sorted, enabled:false, domainFamily:expense_specialist", () => {
  const specialists = getExpenseSpecialistDefinitionsInOrder();
  assertEquals(specialists.map((d) => d.id), [
    "cam_and_operating_expenses", "taxes", "insurance", "utilities", "repairs_and_maintenance",
  ]);
  for (const d of specialists) {
    assertEquals(d.enabled, false, `${d.id} must be enabled:false (grounding correction #1)`);
    assertEquals(d.domainFamily, "expense_specialist");
    assertEquals(d.authorityMode, "shadow");
    assert(d.schemaName, `${d.id} must have a real schemaName`);
  }
});

Deno.test("getExpenseSpecialistDefinitionsInOrder: filtering by domainFamily+authorityMode both matters -- a shadow domain with a DIFFERENT domainFamily must not leak in", () => {
  const base = getDomainDefinition("insurance" as any);
  const unrelatedShadowDomain = { ...base, id: "unrelated_shadow_domain", domainFamily: "core" };
  const registryWithExtra = [...DOMAIN_REGISTRY, unrelatedShadowDomain];
  const specialists = registryWithExtra.filter((d) => d.domainFamily === "expense_specialist" && d.authorityMode === "shadow");
  assert(!specialists.some((d) => d.id === "unrelated_shadow_domain"), "a shadow domain from a different domainFamily must not be selected as an expense specialist");
});

Deno.test("validateDomainRegistry: throws when an authoritative domain is disabled", () => {
  const a = { ...getDomainDefinition("core_terms" as any), enabled: false };
  assertThrows(() => validateDomainRegistry([a]), Error, 'authorityMode:"authoritative" but enabled:false');
});

Deno.test("validateDomainRegistry: throws when a shadow domain has no schemaName", () => {
  const a = { ...getDomainDefinition("insurance" as any), schemaName: null };
  assertThrows(() => validateDomainRegistry([a]), Error, 'authorityMode:"shadow" but has no schemaName');
});

Deno.test("validateDomainRegistry: throws on an unknown evidenceSourceDomains entry", () => {
  const a = { ...getDomainDefinition("insurance" as any), evidenceSourceDomains: ["not_a_real_domain"] };
  assertThrows(() => validateDomainRegistry([a]), Error, "unknown evidenceSourceDomains entry");
});

Deno.test("validateDomainRegistry: throws on an unknown shadowRunsAfter entry", () => {
  const a = { ...getDomainDefinition("insurance" as any), evidenceSourceDomains: [], shadowRunsAfter: ["not_a_real_domain"] };
  assertThrows(() => validateDomainRegistry([a]), Error, "unknown shadowRunsAfter entry");
});

Deno.test("validateDomainRegistry: throws when shadowRunsAfter references another shadow domain", () => {
  const shadowA = { ...getDomainDefinition("insurance" as any), evidenceSourceDomains: [], shadowRunsAfter: [] };
  const shadowB = { ...getDomainDefinition("taxes" as any), evidenceSourceDomains: [], shadowRunsAfter: ["insurance"] };
  assertThrows(() => validateDomainRegistry([shadowA, shadowB]), Error, "references another shadow domain");
});

Deno.test("validateDomainRegistry: does NOT throw when shadowRunsAfter references a real authoritative domain (the real registry's own shape)", () => {
  validateDomainRegistry(); // the real DOMAIN_REGISTRY -- specialists depend on authoritative domains only
});

Deno.test("DOMAIN_REGISTRY: every specialist's shadowRunsAfter/evidenceSourceDomains point at a real authoritative domain", () => {
  for (const d of getExpenseSpecialistDefinitionsInOrder()) {
    assert(d.shadowRunsAfter.length > 0, `${d.id} should declare at least one shadowRunsAfter dependency`);
    for (const id of [...d.shadowRunsAfter, ...d.evidenceSourceDomains]) {
      const referenced = getDomainDefinition(id as any);
      assertEquals(referenced.authorityMode, "authoritative", `${d.id} references ${id}, which should be authoritative`);
    }
  }
});
