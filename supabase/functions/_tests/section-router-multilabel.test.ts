// @ts-nocheck
// Multi-label routing shadow (Phase 3, LEASE_MULTILABEL_ROUTING_V1) tests.
//
// Every fixture sentence below is checked against section-router.ts's REAL
// DOMAIN_PATTERNS regexes (not aspirational patterns) -- each is designed to
// trip exactly the named SectionDomain patterns, verified by hand against
// the actual regex source before being written here.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  routeSections,
  routeSectionsMultiLabel,
  buildRoutingShadowDiagnostics,
  DOMAIN_THRESHOLDS,
  LLM_CALL_DOMAINS,
} from "../_shared/extraction/section-router.ts";

function doclingFor(text: string, page = 1) {
  return { text_blocks: [{ block_index: 0, type: "paragraph", text, page }] };
}

// ── Byte-compatibility guarantee ─────────────────────────────────────────────

Deno.test("routeSectionsMultiLabel: primaryDomain/domainScores/byLlmCallDomain are byte-identical to plain routeSections()", () => {
  const text = "Tenant shall pay its Proportionate Share of Operating Expenses, real estate taxes, and Additional Rent as set forth in this Lease.";
  const docling = doclingFor(text);
  const single = routeSections(docling);
  const multi = routeSectionsMultiLabel(docling);

  assertEquals(multi.blocks[0].primaryDomain, single.blocks[0].primaryDomain);
  assertEquals(multi.blocks[0].domainScores, single.blocks[0].domainScores);
  assertEquals(multi.blocks[0].headingContext, single.blocks[0].headingContext);
  assertEquals(Object.keys(multi.byLlmCallDomain).sort(), Object.keys(single.byLlmCallDomain).sort());
  for (const domain of Object.keys(single.byLlmCallDomain)) {
    assertEquals(multi.byLlmCallDomain[domain].length, single.byLlmCallDomain[domain].length);
  }
});

// ── Six synthetic multi-topic fixtures ───────────────────────────────────────

Deno.test("fixture: proportionate-share CAM clause also names Additional Rent -> expenses_and_cam + rent_and_charges", () => {
  const docling = doclingFor(
    "Tenant shall pay its Proportionate Share of Operating Expenses, real estate taxes, and Additional Rent as set forth in this Lease.",
  );
  const block = routeSectionsMultiLabel(docling).blocks[0];
  const domains = new Set(block.targetLlmCallDomains);
  assert(domains.has("expenses_and_cam"), `expected expenses_and_cam, got ${JSON.stringify(block.targetLlmCallDomains)}`);
  assert(domains.has("rent_and_charges"));
});

Deno.test("fixture: insurance requirement tied to a default remedy -> expenses_and_cam + legal_rights_and_dates", () => {
  const docling = doclingFor(
    "Tenant shall maintain a Commercial General Liability insurance policy providing liability coverage, and any failure to do so shall constitute an Event of Default under this Lease.",
  );
  const block = routeSectionsMultiLabel(docling).blocks[0];
  const domains = new Set(block.targetLlmCallDomains);
  assert(domains.has("expenses_and_cam"));
  assert(domains.has("legal_rights_and_dates"));
});

Deno.test("fixture: repair obligation folded into CAM cost -> operating_obligations + expenses_and_cam", () => {
  const docling = doclingFor(
    "Tenant shall be responsible for repairs and maintenance of the HVAC system, the cost of which shall be included as Common Area Maintenance expenses.",
  );
  const block = routeSectionsMultiLabel(docling).blocks[0];
  const domains = new Set(block.targetLlmCallDomains);
  assert(domains.has("operating_obligations"));
  assert(domains.has("expenses_and_cam"));
});

Deno.test("fixture: renewal option with a notice/default deadline -> legal_rights_and_dates + core_terms", () => {
  const docling = doclingFor(
    "Tenant shall have the option to renew this Lease for one additional term prior to the expiration date, subject to the Default and Remedies provisions of this Lease.",
  );
  const block = routeSectionsMultiLabel(docling).blocks[0];
  const domains = new Set(block.targetLlmCallDomains);
  assert(domains.has("legal_rights_and_dates"));
  assert(domains.has("core_terms"));
  // legal_rights_and_dates scores higher (two matching patterns: options + defaults) than core_terms (one: term).
  assertEquals(block.targetLlmCallDomains[0], "legal_rights_and_dates");
});

Deno.test("fixture: real estate taxes paid as additional rent -> expenses_and_cam + rent_and_charges", () => {
  const docling = doclingFor("Tenant shall pay all real estate taxes assessed against the Property as Additional Rent under this Lease.");
  const block = routeSectionsMultiLabel(docling).blocks[0];
  const domains = new Set(block.targetLlmCallDomains);
  assert(domains.has("expenses_and_cam"));
  assert(domains.has("rent_and_charges"));
});

Deno.test("fixture: utility charges plus HVAC repair responsibility -> expenses_and_cam + operating_obligations", () => {
  const docling = doclingFor(
    "Tenant shall pay for all utility service including electrical service and water and sewer charges, and shall be responsible for HVAC repairs and maintenance of the equipment.",
  );
  const block = routeSectionsMultiLabel(docling).blocks[0];
  const domains = new Set(block.targetLlmCallDomains);
  assert(domains.has("expenses_and_cam"));
  assert(domains.has("operating_obligations"));
});

// ── Selection bounds ──────────────────────────────────────────────────────────

Deno.test("selectTargetDomains (via routeSectionsMultiLabel): never selects more than 3 domains, even when a block scores for all 5", () => {
  const docling = doclingFor(
    "By and Between Landlord and Tenant: the Premises, the Lease Term and Base Rent, Operating Expenses and real estate taxes and insurance, " +
      "repairs and maintenance, and any Renewal Option and Event of Default provisions shall all apply as set forth herein.",
  );
  const block = routeSectionsMultiLabel(docling).blocks[0];
  assert(block.targetLlmCallDomains.length <= 3, `expected at most 3 domains, got ${block.targetLlmCallDomains.length}`);
});

Deno.test("DOMAIN_THRESHOLDS: covers every real LlmCallDomain, expenses_and_cam starts lower than the rest", () => {
  for (const domain of LLM_CALL_DOMAINS) {
    assert(typeof DOMAIN_THRESHOLDS[domain] === "number", `missing threshold for ${domain}`);
  }
  assert(DOMAIN_THRESHOLDS.expenses_and_cam < DOMAIN_THRESHOLDS.core_terms);
});

// ── buildRoutingShadowDiagnostics ────────────────────────────────────────────

Deno.test("buildRoutingShadowDiagnostics: addedDomains excludes today's own single-label authoritative domain", () => {
  const docling = doclingFor(
    "Tenant shall pay its Proportionate Share of Operating Expenses, real estate taxes, and Additional Rent as set forth in this Lease.",
  );
  const blocks = routeSectionsMultiLabel(docling).blocks;
  const [diagnostic] = buildRoutingShadowDiagnostics(blocks);
  assert(!diagnostic.addedDomains.includes(diagnostic.authoritativeLlmDomain));
  assert(diagnostic.targetLlmCallDomains.includes(diagnostic.authoritativeLlmDomain), "the authoritative domain should still be one of the multi-label targets for a block this clearly on-topic");
});

Deno.test("buildRoutingShadowDiagnostics: a single-topic block has an empty addedDomains (multi-label agrees with today's routing)", () => {
  const docling = doclingFor("Base Rent shall be $1,400.00 per month, payable in advance on the first day of each calendar month.");
  const blocks = routeSectionsMultiLabel(docling).blocks;
  const [diagnostic] = buildRoutingShadowDiagnostics(blocks);
  assertEquals(diagnostic.addedDomains, []);
});
