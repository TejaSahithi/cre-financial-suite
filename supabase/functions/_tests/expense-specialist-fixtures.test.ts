// @ts-nocheck
// Phase 5.7 synthetic regression corpus -- the 6 clause fixtures from the
// spec, at two levels (no live LLM call anywhere in this file):
//   - routing-level: does the clause text select the right
//     targetSpecialistDomains (deterministic, section-router.ts's real
//     DOMAIN_PATTERNS regexes, hand-verified below the same way
//     section-router-multilabel.test.ts verified its own fixtures);
//   - schema/converter-level: given a hand-constructed mock response
//     matching the fixture's EXPECTED structured output, does
//     obligation -> claim conversion preserve it exactly. Whether the live
//     LLM actually returns that shape is a prompt-quality question verified
//     against a real MLB canary later, not something a synthetic unit test
//     can prove -- stated explicitly, not overclaimed.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { routeSectionsWithSpecialists } from "../_shared/extraction/section-router.ts";
import {
  camObligationsToClaims,
  insuranceObligationsToClaims,
  utilityObligationsToClaims,
  repairObligationsToClaims,
} from "../_shared/extraction/canonical/expense-specialist-claims.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

function doclingFor(text: string, page = 1) {
  return { text_blocks: [{ block_index: 0, type: "paragraph", text, page }] };
}

// ── Fixture 1: included insurance ────────────────────────────────────────────
// "Base Rent includes real-estate taxes and property insurance." Expected:
// economicTreatment=included_in_rent, obligatedParty=not_stated/ambiguous.
// Must NOT automatically produce obligatedParty=landlord.

Deno.test("fixture 1 (included insurance) -- routing: routes to both taxes and insurance specialists", () => {
  const docling = doclingFor("Base Rent shall include real estate taxes and property insurance premiums under this Lease.");
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("taxes"));
  assert(block.targetSpecialistDomains.includes("insurance"));
});

Deno.test("fixture 1 (included insurance) -- converter: included_in_rent + not_stated survives conversion, never becomes 'landlord'", () => {
  const claims = insuranceObligationsToClaims(
    [{
      coverageType: "building", obligatedParty: "not_stated", obligationType: "included_service",
      economicTreatment: "included_in_rent", status: "explicit", sourcePage: 1,
      sourceQuote: "Base Rent shall include real estate taxes and property insurance premiums under this Lease.",
    }],
    CONTEXT, "insurance-obligation-v1",
  );
  const obligatedPartyClaim = claims.find((c) => c.fieldCode.endsWith(".obligatedParty"));
  const economicTreatmentClaim = claims.find((c) => c.fieldCode.endsWith(".economicTreatment"));
  assertEquals(economicTreatmentClaim.normalizedValue, "included_in_rent");
  assertEquals(obligatedPartyClaim.normalizedValue, "not_stated");
  assert(obligatedPartyClaim.normalizedValue !== "landlord", "included-in-rent must not be silently upgraded to a landlord-responsibility claim");
});

// ── Fixture 2: mixed insurance ───────────────────────────────────────────────
// Tenant insures personal property/alterations; Landlord may insure
// leasehold improvements, premium in Operating Expenses. Expected: 2-3
// separate obligations, not one collapsed answer.

Deno.test("fixture 2 (mixed insurance) -- routing: routes to the insurance specialist", () => {
  const docling = doclingFor(
    "Tenant shall maintain insurance for its personal property and alterations. Landlord may maintain insurance for the leasehold improvements and include the premium in Operating Expenses payable by Tenant.",
  );
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("insurance"));
});

Deno.test("fixture 2 (mixed insurance) -- converter: 3 separate obligations stay separate, not collapsed into one", () => {
  const claims = insuranceObligationsToClaims(
    [
      { coverageType: "tenant_property", obligatedParty: "tenant", obligationType: "must_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall maintain insurance for its personal property" },
      { coverageType: "leasehold_improvements", obligatedParty: "tenant", obligationType: "must_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall maintain insurance ... and alterations" },
      { coverageType: "leasehold_improvements", obligatedParty: "landlord", obligationType: "may_insure", economicTreatment: "operating_expense_pass_through", status: "explicit", sourcePage: 1, sourceQuote: "Landlord may maintain insurance for the leasehold improvements and include the premium in Operating Expenses" },
    ],
    CONTEXT, "insurance-obligation-v1",
  );
  const obligatedParties = new Set(claims.filter((c) => c.fieldCode.endsWith(".obligatedParty")).map((c) => c.normalizedValue));
  assertEquals(obligatedParties, new Set(["tenant", "landlord"]), "both tenant and landlord obligations should be represented, not collapsed into one");
});

// ── Fixture 3: CAM cap ────────────────────────────────────────────────────────

Deno.test("fixture 3 (CAM cap) -- routing: routes to the cam_and_operating_expenses specialist", () => {
  const docling = doclingFor(
    "Tenant shall pay its Proportionate Share of Common Area Maintenance expenses, but controllable expenses shall not increase by more than five percent cumulatively per calendar year.",
  );
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("cam_and_operating_expenses"));
});

Deno.test("fixture 3 (CAM cap) -- converter: cap.type=cumulative_percentage, cap.value=5, responsibleParty=tenant, allocationMethod=pro_rata_share", () => {
  const claims = camObligationsToClaims(
    [{
      category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent",
      allocationMethod: "pro_rata_share", amountType: "percentage", amount: null, percentage: null,
      cap: { type: "cumulative_percentage", value: 5, appliesTo: "controllable expenses" },
      inclusions: [], exclusions: [], reconciliationFrequency: "annual", auditRight: null,
      status: "explicit", sourcePage: 1,
      sourceQuote: "controllable expenses shall not increase by more than five percent cumulatively per calendar year",
    }],
    CONTEXT, "cam-obligation-v1",
  );
  const capClaim = claims.find((c) => c.fieldCode.endsWith(".cap"));
  const responsiblePartyClaim = claims.find((c) => c.fieldCode.endsWith(".responsibleParty"));
  const allocationMethodClaim = claims.find((c) => c.fieldCode.endsWith(".allocationMethod"));
  assertEquals(capClaim.normalizedValue.type, "cumulative_percentage");
  assertEquals(capClaim.normalizedValue.value, 5);
  assertEquals(responsiblePartyClaim.normalizedValue, "tenant");
  assertEquals(allocationMethodClaim.normalizedValue, "pro_rata_share");
});

// ── Fixture 4: utility separation ────────────────────────────────────────────
// Expected: 4 separate obligations, not one generic result.

Deno.test("fixture 4 (utility separation) -- routing: routes to the utilities specialist", () => {
  const docling = doclingFor("Tenant shall pay for all utility service including electricity, water and sewer, and gas charges directly to the providers.");
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("utilities"));
});

Deno.test("fixture 4 (utility separation) -- converter: 4 distinct utility types produce 4 distinct obligation claim sets, never collapsed", () => {
  const claims = utilityObligationsToClaims(
    [
      { utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "electricity ... directly to the providers" },
      { utilityType: "water", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "water ... directly to the providers" },
      { utilityType: "sewer", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "sewer ... directly to the providers" },
      { utilityType: "gas", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "gas charges directly to the providers" },
    ],
    CONTEXT, "utility-obligation-v1",
  );
  const utilityTypes = new Set(claims.map((c) => c.fieldCode.split(".")[2]));
  assertEquals(utilityTypes, new Set(["electricity", "water", "sewer", "gas"]));
  assertEquals(claims.filter((c) => c.fieldCode.endsWith(".responsibleParty")).length, 4, "expected exactly 4 responsibleParty claims, one per utility");
});

// ── Fixture 5: repair split ───────────────────────────────────────────────────
// Expected: at least 5 separate obligations.

Deno.test("fixture 5 (repair split) -- routing: routes to the repairs_and_maintenance specialist", () => {
  const docling = doclingFor("Tenant shall maintain the interior and HVAC serving the Premises. Landlord shall maintain the roof, structure, and common areas.");
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  assert(block.targetSpecialistDomains.includes("repairs_and_maintenance"));
});

Deno.test("fixture 5 (repair split) -- converter: 5 distinct components produce 5 distinct obligation claim sets", () => {
  const claims = repairObligationsToClaims(
    [
      { component: "interior", responsibleParty: "tenant", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall maintain the interior" },
      { component: "hvac", responsibleParty: "tenant", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "and HVAC serving the Premises" },
      { component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "Landlord shall maintain the roof" },
      { component: "structure", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "structure" },
      { component: "common_areas", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "and common areas" },
    ],
    CONTEXT, "repair-obligation-v1",
  );
  const components = new Set(claims.map((c) => c.fieldCode.split(".")[1]));
  assertEquals(components.size, 5);
  const tenantComponents = claims.filter((c) => c.fieldCode.endsWith(".responsibleParty") && c.normalizedValue === "tenant").length;
  const landlordComponents = claims.filter((c) => c.fieldCode.endsWith(".responsibleParty") && c.normalizedValue === "landlord").length;
  assertEquals(tenantComponents, 2);
  assertEquals(landlordComponents, 3);
});

// ── Fixture 6: mixed expense clause ──────────────────────────────────────────
// Expected: multiple specialist outputs from one clause.

Deno.test("fixture 6 (mixed expense clause) -- routing: one clause routes to cam, taxes, insurance, AND utilities specialists", () => {
  const docling = doclingFor(
    "Tenant shall reimburse Landlord for its Proportionate Share of Common Area Maintenance expenses, real estate taxes, property insurance, and utility service as Additional Rent.",
  );
  const block = routeSectionsWithSpecialists(docling).blocks[0];
  for (const domain of ["cam_and_operating_expenses", "taxes", "insurance", "utilities"]) {
    assert(block.targetSpecialistDomains.includes(domain), `expected ${domain} among ${JSON.stringify(block.targetSpecialistDomains)}`);
  }
});
