// @ts-nocheck
// Phase 6A converter tests (expense-obligation-converters.ts): mapping
// tables, family assignment (correction E), audit-right tri-state parsing
// (correction C).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  camSpecialistToExpenseObligations,
  taxSpecialistToExpenseObligations,
  insuranceSpecialistToExpenseObligations,
  utilitiesSpecialistToExpenseObligations,
  repairsSpecialistToExpenseObligations,
  normalizeAuditRight,
} from "../_shared/extraction/canonical/financial/expense-obligation-converters.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

// ── normalizeAuditRight (correction C) ───────────────────────────────────────

Deno.test("normalizeAuditRight: null/empty text -> allowed:null (nothing to guess from)", () => {
  assertEquals(normalizeAuditRight(null).allowed, null);
  assertEquals(normalizeAuditRight("").allowed, null);
});

Deno.test("normalizeAuditRight: negative language -> allowed:false", () => {
  assertEquals(normalizeAuditRight("Tenant shall have no right to audit.").allowed, false);
  assertEquals(normalizeAuditRight("Tenant waives any right to audit Landlord's records.").allowed, false);
});

Deno.test("normalizeAuditRight: conditional/positive language -> allowed:true, notice period retained where present", () => {
  const result = normalizeAuditRight("Tenant may audit within 90 days after reconciliation.");
  assertEquals(result.allowed, true);
  assertEquals(result.noticePeriodDays, 90);
});

Deno.test("normalizeAuditRight: unrecognized wording -> allowed:null, never guessed true (fails safe)", () => {
  const result = normalizeAuditRight("Landlord shall provide an annual statement of Operating Expenses.");
  assertEquals(result.allowed, null);
  assertEquals(result.rawText, "Landlord shall provide an annual statement of Operating Expenses.");
});

// ── CAM converter ─────────────────────────────────────────────────────────────

Deno.test("camSpecialistToExpenseObligations: management_fee/administrative_fee categories get family 'fee', others get 'cam'", () => {
  const obligations = camSpecialistToExpenseObligations(
    [
      { category: "management_fee", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "not_stated", amountType: "percentage", amount: null, percentage: 3, cap: null, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "q" },
      { category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share", amountType: "included", amount: null, percentage: null, cap: null, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "q2" },
    ],
    CONTEXT, "cam-obligation-v1",
  );
  assertEquals(obligations[0].family, "fee");
  assertEquals(obligations[0].category, "management_fee");
  assertEquals(obligations[1].family, "cam");
  assertEquals(obligations[1].category, "common_area_maintenance");
});

Deno.test("camSpecialistToExpenseObligations: paymentMechanism 'included_in_rent' reconciles to 'included_in_base_rent'", () => {
  const [o] = camSpecialistToExpenseObligations(
    [{ category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "included_in_rent", allocationMethod: "not_stated", amountType: "included", amount: null, percentage: null, cap: null, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "cam-obligation-v1",
  );
  assertEquals(o.paymentMechanism, "included_in_base_rent");
});

Deno.test("camSpecialistToExpenseObligations: cap object survives conversion unchanged", () => {
  const [o] = camSpecialistToExpenseObligations(
    [{ category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share", amountType: "percentage", amount: null, percentage: null, cap: { type: "cumulative_percentage", value: 5, appliesTo: "controllable expenses" }, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "cam-obligation-v1",
  );
  assertEquals(o.cap, { type: "cumulative_percentage", value: 5, appliesTo: "controllable expenses" });
});

// ── Insurance converter (correction E: finer taxonomy) ───────────────────────

Deno.test("insuranceSpecialistToExpenseObligations: all 7 coverage types map to DISTINCT categories, no collapse to 'other' for the 4 previously-collapsed types", () => {
  const coverageTypes = ["building", "tenant_property", "leasehold_improvements", "commercial_general_liability", "business_interruption", "workers_compensation", "other"];
  const obligations = insuranceSpecialistToExpenseObligations(
    coverageTypes.map((coverageType) => ({ coverageType, obligatedParty: "tenant", obligationType: "must_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: `q-${coverageType}` })),
    CONTEXT, "insurance-obligation-v1",
  );
  const categories = obligations.map((o) => o.category);
  assertEquals(categories, ["property_insurance", "tenant_property_insurance", "leasehold_improvements_insurance", "liability_insurance", "business_interruption_insurance", "workers_compensation_insurance", "other"]);
  assertEquals(new Set(categories.slice(0, 6)).size, 6, "the 6 non-'other' coverage types must all produce distinct categories");
});

Deno.test("insuranceSpecialistToExpenseObligations: obligatedParty 'both' reconciles to responsibleParty 'shared'", () => {
  const [o] = insuranceSpecialistToExpenseObligations(
    [{ coverageType: "building", obligatedParty: "both", obligationType: "must_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "insurance-obligation-v1",
  );
  assertEquals(o.responsibleParty, "shared");
});

Deno.test("insuranceSpecialistToExpenseObligations: economicTreatment 'included_in_rent' + obligatedParty 'not_stated' survives -- never becomes 'landlord' (Phase 5's guardrail, re-verified at this layer)", () => {
  const [o] = insuranceSpecialistToExpenseObligations(
    [{ coverageType: "building", obligatedParty: "not_stated", obligationType: "included_service", economicTreatment: "included_in_rent", status: "explicit", sourcePage: 4, sourceQuote: "Rent includes property insurance." }],
    CONTEXT, "insurance-obligation-v1",
  );
  assertEquals(o.paymentMechanism, "included_in_base_rent");
  assertEquals(o.responsibleParty, "not_stated");
  assert(o.responsibleParty !== "landlord");
});

// ── Utilities converter ───────────────────────────────────────────────────────

Deno.test("utilitiesSpecialistToExpenseObligations: billingMethod maps into BOTH paymentMechanism and allocationMethod appropriately", () => {
  const [submetered] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "submetered", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  assertEquals(submetered.paymentMechanism, "submetered");
  assertEquals(submetered.allocationMethod, "submeter");

  const [includedInRent] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "water", responsibleParty: "tenant", billingMethod: "included_in_rent", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  assertEquals(includedInRent.paymentMechanism, "included_in_base_rent");
  assertEquals(includedInRent.allocationMethod, "included");
});

Deno.test("utilitiesSpecialistToExpenseObligations: obligationType defaults to must_pay when a responsible party is resolved, not_stated otherwise", () => {
  const [resolved] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "gas", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  assertEquals(resolved.obligationType, "must_pay");

  const [unresolved] = utilitiesSpecialistToExpenseObligations(
    [{ utilityType: "gas", responsibleParty: "not_stated", billingMethod: "not_stated", status: "not_found", sourcePage: null, sourceQuote: null }],
    CONTEXT, "utility-obligation-v1",
  );
  assertEquals(unresolved.obligationType, "not_stated");
});

// ── Repairs converter ─────────────────────────────────────────────────────────

Deno.test("repairsSpecialistToExpenseObligations: component maps to the correct finer category (roof/structure/interior distinct)", () => {
  const obligations = repairsSpecialistToExpenseObligations(
    [
      { component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "roof" },
      { component: "structure", responsibleParty: "landlord", obligationType: "repair", status: "explicit", sourcePage: 1, sourceQuote: "structure" },
      { component: "interior", responsibleParty: "tenant", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "interior" },
    ],
    CONTEXT, "repair-obligation-v1",
  );
  assertEquals(obligations.map((o) => o.category), ["roof_repairs", "structural_repairs", "interior_repairs"]);
});

Deno.test("repairsSpecialistToExpenseObligations: obligationType maintain/repair/replace all map to must_perform, reimburse maps to must_reimburse", () => {
  const [maintain] = repairsSpecialistToExpenseObligations([{ component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "q" }], CONTEXT, "repair-obligation-v1");
  const [reimburse] = repairsSpecialistToExpenseObligations([{ component: "roof", responsibleParty: "tenant", obligationType: "reimburse", status: "explicit", sourcePage: 1, sourceQuote: "q" }], CONTEXT, "repair-obligation-v1");
  assertEquals(maintain.obligationType, "must_perform");
  assertEquals(reimburse.obligationType, "must_reimburse");
});

// ── Tax converter ──────────────────────────────────────────────────────────────

Deno.test("taxSpecialistToExpenseObligations: real_estate_tax/personal_property_tax map to distinct categories, minor categories collapse to 'other' with subcategory preserved", () => {
  const [realEstate] = taxSpecialistToExpenseObligations([{ category: "real_estate_tax", responsibleParty: "tenant", economicTreatment: "direct_cost", baseYear: null, capOrLimit: null, status: "explicit", sourcePage: 1, sourceQuote: "q" }], CONTEXT, "tax-obligation-v1");
  const [appeal] = taxSpecialistToExpenseObligations([{ category: "tax_appeal_right", responsibleParty: "landlord", economicTreatment: "not_stated", baseYear: null, capOrLimit: null, status: "explicit", sourcePage: 1, sourceQuote: "q" }], CONTEXT, "tax-obligation-v1");
  assertEquals(realEstate.category, "real_estate_taxes");
  assertEquals(realEstate.subcategory, null);
  assertEquals(appeal.category, "other");
  assertEquals(appeal.subcategory, "tax_appeal_right");
  assertEquals(appeal.family, "tax", "family still identifies the domain even when category collapses to other");
});
