// @ts-nocheck
// Phase 5 expense-specialist shadow routing (section-router.ts's
// routeSectionsWithSpecialists/selectSpecialistTargetDomains). A separate,
// additive layer next to Phase 3's multi-label routing -- these tests focus
// specifically on proving it never touches targetLlmCallDomains/the
// existing 3-cap, and that each specialist gets its own routed block set
// (grounding correction A -- not a shared evidence blob).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  routeSections,
  routeSectionsMultiLabel,
  routeSectionsWithSpecialists,
  DEFAULT_SPECIALIST_ROUTING_BUDGET,
} from "../_shared/extraction/section-router.ts";

function doclingFor(text: string, page = 1) {
  return { text_blocks: [{ block_index: 0, type: "paragraph", text, page }] };
}

function multiBlockDocling(texts: string[]) {
  return { text_blocks: texts.map((text, i) => ({ block_index: i, type: "paragraph", text, page: 1 })) };
}

Deno.test("routeSectionsWithSpecialists: targetLlmCallDomains (from plain routeSections) is untouched -- byte-identical to routeSections() alone", () => {
  const text = "Tenant shall pay its Proportionate Share of Operating Expenses, real estate taxes, and Additional Rent as set forth in this Lease.";
  const docling = doclingFor(text);
  const plain = routeSections(docling);
  const withSpecialists = routeSectionsWithSpecialists(docling);
  assertEquals(withSpecialists.blocks[0].primaryDomain, plain.blocks[0].primaryDomain);
  assertEquals(withSpecialists.blocks[0].domainScores, plain.blocks[0].domainScores);
  assertEquals(Object.keys(withSpecialists.blocks[0]).includes("targetLlmCallDomains"), false, "routeSectionsWithSpecialists must not add targetLlmCallDomains -- that's routeSectionsMultiLabel's field");
});

Deno.test("routeSectionsWithSpecialists: the existing Phase 3 3-domain cap and multi-label routing are unaffected by this module change", () => {
  const docling = doclingFor(
    "By and Between Landlord and Tenant: the Premises, the Lease Term and Base Rent, Operating Expenses and real estate taxes and insurance, " +
      "repairs and maintenance, and any Renewal Option and Event of Default provisions shall all apply as set forth herein.",
  );
  const multiLabel = routeSectionsMultiLabel(docling);
  assert(multiLabel.blocks[0].targetLlmCallDomains.length <= 3, "Phase 3's cap must remain exactly 3, unaffected by specialist routing existing");
});

Deno.test("fixture: insurance clause routes to the insurance specialist", () => {
  const docling = doclingFor("Tenant shall maintain a Commercial General Liability insurance policy providing liability coverage for the Premises.");
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("insurance"), `expected insurance, got ${JSON.stringify(block.targetSpecialistDomains)}`);
});

Deno.test("fixture: utility clause routes to the utilities specialist, tax clause to the taxes specialist -- not the same bucket", () => {
  const docling = doclingFor("Tenant shall pay for all utility service including electrical service and water and sewer charges.");
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("utilities"));
  assert(!block.targetSpecialistDomains.includes("taxes"));
});

Deno.test("fixture: repair clause routes to the repairs_and_maintenance specialist", () => {
  const docling = doclingFor("Tenant shall be responsible for repairs and maintenance of the HVAC system serving the Premises.");
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("repairs_and_maintenance"));
});

Deno.test("fixture: CAM clause routes to the cam_and_operating_expenses specialist", () => {
  const docling = doclingFor("Tenant shall pay its Proportionate Share of Common Area Maintenance expenses under this Lease.");
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("cam_and_operating_expenses"));
});

Deno.test("selectSpecialistTargetDomains (via routeSectionsWithSpecialists): honors maximumSpecialistsPerBlock, not the original 3-cap", () => {
  const docling = doclingFor(
    "Tenant shall pay its Proportionate Share of Common Area Maintenance expenses, real estate taxes, insurance premiums, " +
      "utility charges including electricity and water and sewer, and shall be responsible for HVAC repairs and maintenance.",
  );
  const narrowBudget = { ...DEFAULT_SPECIALIST_ROUTING_BUDGET, maximumSpecialistsPerBlock: 2 };
  const block = routeSectionsWithSpecialists(docling, undefined, narrowBudget).blocks[0];
  assert(block.targetSpecialistDomains.length <= 2, `expected at most 2 with a narrowed budget, got ${block.targetSpecialistDomains.length}`);
});

Deno.test("bySpecialistDomain: each specialist's evidence is genuinely per-specialist, not one shared bucket (grounding correction A)", () => {
  const docling = multiBlockDocling([
    "Tenant shall maintain a Commercial General Liability insurance policy for the Premises.",
    "Tenant shall pay for all electrical service and water and sewer charges directly to the providers.",
  ]);
  const { bySpecialistDomain } = routeSectionsWithSpecialists(docling);
  const insuranceBlocks = bySpecialistDomain["insurance"] ?? [];
  const utilitiesBlocks = bySpecialistDomain["utilities"] ?? [];
  assert(insuranceBlocks.length > 0 && utilitiesBlocks.length > 0, "both specialists should have routed blocks");
  const insuranceTexts = insuranceBlocks.map((b) => b.text).join(" ");
  const utilitiesTexts = utilitiesBlocks.map((b) => b.text).join(" ");
  assert(insuranceTexts.includes("insurance"), "insurance specialist's evidence should include the insurance clause");
  assert(!insuranceTexts.includes("electrical service"), "insurance specialist's evidence must NOT include the utilities clause -- own routed evidence, not a shared blob");
  assert(utilitiesTexts.includes("electrical service"), "utilities specialist's evidence should include the utilities clause");
  assert(!utilitiesTexts.includes("Commercial General Liability"), "utilities specialist's evidence must NOT include the insurance clause");
});
