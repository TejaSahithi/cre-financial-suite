// @ts-nocheck
// Phase 6A projection tests (expense-obligation-projection.ts, correction
// F). The safe-mapping bar is tightened well beyond Phase 5's original
// 4-condition check -- these tests exercise the concrete guardrail that
// keeps an insurance-included-in-rent obligation from ever producing a
// coarse responsibility mapping.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  safeExactCanonicalMappingExists,
  proposeCanonicalMapping,
  proposeDynamicRow,
  proposeExpenseObligationPlacements,
} from "../_shared/extraction/canonical/financial/expense-obligation-projection.ts";
import { utilitiesSpecialistToExpenseObligations, insuranceSpecialistToExpenseObligations, repairsSpecialistToExpenseObligations } from "../_shared/extraction/canonical/financial/expense-obligation-converters.ts";
import { applyExpenseObligationEvidenceVerification } from "../_shared/extraction/canonical/financial/expense-obligation-validation.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

function verified(obligation: any) {
  // meetsSafeMappingBar requires verificationStatus:"verified" -- promote
  // it the same way the real pipeline does (applyExpenseObligationEvidenceVerification),
  // using a doclingRaw that actually contains the quote so verification succeeds.
  const doclingRaw = { text_blocks: [{ text: obligation.evidence[0]?.quote ?? "", page: obligation.evidence[0]?.pageNumber ?? 1 }, { text: "unrelated other page content", page: 99 }] };
  return applyExpenseObligationEvidenceVerification(obligation, doclingRaw);
}

Deno.test("safeExactCanonicalMappingExists: true for a clean, verified electricity/tenant obligation", () => {
  const [o] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall pay for electricity." }],
    CONTEXT, "utility-obligation-v1",
  );
  const o2 = verified(o);
  assert(safeExactCanonicalMappingExists(o2));
  const mapping = proposeCanonicalMapping(o2);
  assertEquals(mapping.targetFieldKey, "electric_responsibility");
  assertEquals(mapping.value, "tenant");
});

// ── The core guardrail this correction exists for ────────────────────────────

Deno.test("projection guardrail: property insurance included in rent NEVER produces an insurance_responsibility mapping, even with a resolved responsibleParty", () => {
  const [o] = insuranceSpecialistToExpenseObligations(
    [{ coverageType: "building", obligatedParty: "landlord", obligationType: "must_insure", economicTreatment: "included_in_rent", status: "explicit", sourcePage: 4, sourceQuote: "Rent includes property insurance." }],
    CONTEXT, "insurance-obligation-v1",
  );
  const o2 = verified(o);
  assertEquals(o2.paymentMechanism, "included_in_base_rent");
  assertEquals(safeExactCanonicalMappingExists(o2), false, "included_in_base_rent must fail the safe-mapping bar regardless of responsibleParty");
  assertEquals(proposeCanonicalMapping(o2), null);
  const row = proposeDynamicRow(o2);
  assert(row != null, "should fall through to a dynamic row instead");
  assertEquals(row.businessTab, "insurance");
});

Deno.test("safeExactCanonicalMappingExists: false when verificationStatus is not 'verified' (e.g. still unverified or needs_review)", () => {
  const [o] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall pay for electricity." }],
    CONTEXT, "utility-obligation-v1",
  );
  assertEquals(o.verificationStatus, "unverified");
  assertEquals(safeExactCanonicalMappingExists(o), false);
});

Deno.test("safeExactCanonicalMappingExists: false when requiresReview is true", () => {
  const [o] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall pay for electricity." }],
    CONTEXT, "utility-obligation-v1",
  );
  const flagged = { ...verified(o), requiresReview: true };
  assertEquals(safeExactCanonicalMappingExists(flagged), false);
});

Deno.test("safeExactCanonicalMappingExists: false for an obligationType outside the per-concept allow-list (e.g. insurance 'may_insure')", () => {
  const [o] = insuranceSpecialistToExpenseObligations(
    [{ coverageType: "building", obligatedParty: "landlord", obligationType: "may_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: "Landlord may insure the building." }],
    CONTEXT, "insurance-obligation-v1",
  );
  const o2 = verified(o);
  assertEquals(safeExactCanonicalMappingExists(o2), false);
});

Deno.test("repairs never get a safe canonical mapping (no mappable concept defined for repairs -- always dynamic row, preserving per-component granularity)", () => {
  const [o] = repairsSpecialistToExpenseObligations(
    [{ component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "Landlord shall maintain the roof." }],
    CONTEXT, "repair-obligation-v1",
  );
  const o2 = verified(o);
  assertEquals(safeExactCanonicalMappingExists(o2), false);
  const row = proposeDynamicRow(o2);
  assertEquals(row.businessTab, "repairs_maintenance");
});

Deno.test("proposeExpenseObligationPlacements: partitions a mixed batch correctly between canonicalMappings and dynamicRows", () => {
  const [safe] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "water", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall pay for water directly." }],
    CONTEXT, "utility-obligation-v1",
  );
  const [unsafe] = insuranceSpecialistToExpenseObligations(
    [{ coverageType: "building", obligatedParty: "not_stated", obligationType: "included_service", economicTreatment: "included_in_rent", status: "explicit", sourcePage: 1, sourceQuote: "Rent includes property insurance." }],
    CONTEXT, "insurance-obligation-v1",
  );
  const { canonicalMappings, dynamicRows } = proposeExpenseObligationPlacements([verified(safe), verified(unsafe)]);
  assertEquals(canonicalMappings.length, 1);
  assertEquals(canonicalMappings[0].targetFieldKey, "water_sewer_responsibility");
  assertEquals(dynamicRows.length, 1);
});
