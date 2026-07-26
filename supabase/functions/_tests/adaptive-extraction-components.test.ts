// @ts-nocheck
/**
 * Unit tests for the Section-Aware Candidate Router's building blocks:
 * section-router.ts, deterministic-candidates.ts, domain-readiness.ts.
 * Synthetic fixtures only -- no document-specific literals in production
 * code, per this task's own constraint.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { routeSections, SECTION_DOMAIN_TO_LLM_CALL_DOMAIN } from "../_shared/extraction/section-router.ts";
import { extractDeterministicCandidates } from "../_shared/extraction/deterministic-candidates.ts";
import { evaluateDomainReadiness } from "../_shared/extraction/domain-readiness.ts";

function block(overrides: Partial<{ block_index: number; type: string; text: string; page: number }>) {
  return { block_index: 0, type: "paragraph", text: "", page: 1, ...overrides };
}

// ── section-router.ts ────────────────────────────────────────────────────────

Deno.test("section-router: a PARTIES heading routes the heading and following body text to the parties domain", () => {
  const docling = {
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "PARTIES", page: 1 }),
      block({ block_index: 1, type: "paragraph", text: "This Lease is entered into by and between the Landlord and the Tenant named below.", page: 1 }),
    ],
  };
  const result = routeSections(docling as any);
  assertEquals(result.blocks[0].primaryDomain, "parties");
  assertEquals(result.blocks[1].primaryDomain, "parties");
  assertEquals(result.blocks[1].headingContext, "PARTIES");
});

Deno.test("section-router: a repair clause routes to repairs, not utilities, unless it states a payment obligation", () => {
  const docling = {
    text_blocks: [
      block({ block_index: 0, type: "heading", text: "REPAIRS AND MAINTENANCE", page: 5 }),
      block({ block_index: 1, type: "paragraph", text: "Landlord shall repair the HVAC system in the event of mechanical failure.", page: 5 }),
    ],
  };
  const result = routeSections(docling as any);
  assertEquals(result.blocks[1].primaryDomain, "repairs");
  assertEquals(SECTION_DOMAIN_TO_LLM_CALL_DOMAIN[result.blocks[1].primaryDomain], "operating_obligations");
});

Deno.test("section-router: an unrelated block with no domain keyword and no heading context routes to 'other'", () => {
  const docling = {
    text_blocks: [block({ block_index: 0, type: "paragraph", text: "This page intentionally left blank." })],
  };
  const result = routeSections(docling as any);
  assertEquals(result.blocks[0].primaryDomain, "other");
});

// ── deterministic-candidates.ts ──────────────────────────────────────────────

Deno.test("deterministic-candidates: a labelled tenant name and rentable area resolve with zero LLM involvement", () => {
  const docling = {
    full_text: "Tenant: Justin Cress\nRentable Area: 1,875 square feet",
    text_blocks: [
      block({ block_index: 0, text: "Tenant: Justin Cress" }),
      block({ block_index: 1, text: "Rentable Area: 1,875 square feet" }),
    ],
    tables: [],
    fields: [
      { key: "Tenant", value: "Justin Cress", confidence: 0.9, page: 1 },
      { key: "Rentable Area", value: "1875", confidence: 0.9, page: 1 },
    ],
  };
  const result = extractDeterministicCandidates(docling as any, "lease");
  assert(result.fieldKeysCovered.has("tenant_name"), "expected tenant_name to be covered deterministically");
  assert(result.fieldKeysCovered.has("square_footage"), "expected square_footage to be covered deterministically");
  const tenantFact = result.facts.find((f) => f.value === "Justin Cress");
  assert(tenantFact, "expected a tenant_name fact");
  assertEquals(tenantFact.category, "clause:party_identification");
  assert(result.candidatesByDomain.core_terms?.some((c) => c.fieldKey === "tenant_name"));
});

// ── domain-readiness.ts ──────────────────────────────────────────────────────

Deno.test("domain-readiness: core_terms with all critical facts present via deterministic candidates does not require an LLM call", () => {
  const docling = {
    full_text: "Tenant: Justin Cress\nLandlord: Example Holdings LLC\nRentable Area: 1875 square feet\nCommencement Date: 2024-03-01\nExpiration Date: 2029-02-28",
    text_blocks: [],
    tables: [],
    fields: [
      { key: "Tenant", value: "Justin Cress", confidence: 0.9, page: 1 },
      { key: "Landlord", value: "Example Holdings LLC", confidence: 0.9, page: 1 },
      { key: "Rentable Area", value: "1875", confidence: 0.9, page: 1 },
      { key: "Commencement Date", value: "2024-03-01", confidence: 0.9, page: 1 },
      { key: "Expiration Date", value: "2029-02-28", confidence: 0.9, page: 1 },
    ],
  };
  const det = extractDeterministicCandidates(docling as any, "lease");
  const readiness = evaluateDomainReadiness({
    domain: "core_terms",
    moduleType: "lease",
    deterministicFacts: det.candidatesByDomain.core_terms?.map((c) => c.fact) ?? [],
    hasRoutedSectionContent: true,
  });
  assertEquals(readiness.requiresLlm, false, `expected no LLM call, reasons: ${JSON.stringify(readiness.escalationReasons)}`);
  assertEquals(readiness.criticalFactsPresent, true);
});

Deno.test("domain-readiness: core_terms with a missing critical fact requires an LLM call, with a specific reason", () => {
  const readiness = evaluateDomainReadiness({
    domain: "core_terms",
    moduleType: "lease",
    deterministicFacts: [
      { category: "clause:party_identification", value: "Justin Cress", sourceText: "Tenant: Justin Cress", sourcePage: 1, confidence: 0.9 },
    ],
    hasRoutedSectionContent: true,
  });
  assertEquals(readiness.requiresLlm, true);
  assert(readiness.escalationReasons.length > 0);
  assert(readiness.escalationReasons[0].includes("landlord_name") || readiness.escalationReasons.some((r) => r.includes("Missing critical")));
});

Deno.test("domain-readiness: a domain with no routed content and no facts does not force an LLM call (concept not applicable)", () => {
  const readiness = evaluateDomainReadiness({
    domain: "expenses_and_cam",
    moduleType: "lease",
    deterministicFacts: [],
    hasRoutedSectionContent: false,
  });
  assertEquals(readiness.requiresLlm, false);
  assertEquals(readiness.escalationReasons.length, 0);
});

Deno.test("domain-readiness: routed content with no resolved candidate DOES require an LLM call", () => {
  const readiness = evaluateDomainReadiness({
    domain: "expenses_and_cam",
    moduleType: "lease",
    deterministicFacts: [],
    hasRoutedSectionContent: true,
  });
  assertEquals(readiness.requiresLlm, true);
  assert(readiness.escalationReasons.length > 0);
});
