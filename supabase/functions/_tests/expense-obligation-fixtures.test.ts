// @ts-nocheck
// Phase 6A remaining narrative fixtures (6A.8) not already covered by
// expense-obligation-converters.test.ts / expense-obligation-dedup.test.ts /
// expense-obligation-projection.test.ts: mixed insurance as a real
// multi-obligation array, 4 utilities in one clause, split repairs, CAM
// proportionate share, expense exclusions, and estimated-payments-with-
// annual-reconciliation (correction C's deriveReconciliationFlags heuristic).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  camSpecialistToExpenseObligations,
  insuranceSpecialistToExpenseObligations,
  utilitiesSpecialistToExpenseObligations,
  repairsSpecialistToExpenseObligations,
} from "../_shared/extraction/canonical/financial/expense-obligation-converters.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

Deno.test("fixture: mixed tenant/landlord insurance stays 2+ separate obligations, never collapsed", () => {
  const obligations = insuranceSpecialistToExpenseObligations(
    [
      { coverageType: "tenant_property", obligatedParty: "tenant", obligationType: "must_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall insure its personal property." },
      { coverageType: "leasehold_improvements", obligatedParty: "landlord", obligationType: "may_insure", economicTreatment: "operating_expense_pass_through", status: "explicit", sourcePage: 1, sourceQuote: "Landlord may insure leasehold improvements, cost passed through as Operating Expenses." },
    ],
    CONTEXT, "insurance-obligation-v1",
  );
  assertEquals(obligations.length, 2);
  assertEquals(obligations[0].responsibleParty, "tenant");
  assertEquals(obligations[1].responsibleParty, "landlord");
  assertEquals(obligations[0].category, "tenant_property_insurance");
  assertEquals(obligations[1].category, "leasehold_improvements_insurance");
});

Deno.test("fixture: 4 utilities in one clause -> 4 distinct ExpenseObligations, distinct categories", () => {
  const obligations = utilitiesSpecialistToExpenseObligations(
    [
      { utilityType: "electricity", responsibleParty: "tenant", billingMethod: "included_in_rent", status: "explicit", sourcePage: 4, sourceQuote: "Tenant pays for electricity, HVAC, water, and sewer, all included in rent." },
      { utilityType: "hvac", responsibleParty: "tenant", billingMethod: "included_in_rent", status: "explicit", sourcePage: 4, sourceQuote: "Tenant pays for electricity, HVAC, water, and sewer, all included in rent." },
      { utilityType: "water", responsibleParty: "tenant", billingMethod: "included_in_rent", status: "explicit", sourcePage: 4, sourceQuote: "Tenant pays for electricity, HVAC, water, and sewer, all included in rent." },
      { utilityType: "sewer", responsibleParty: "tenant", billingMethod: "included_in_rent", status: "explicit", sourcePage: 4, sourceQuote: "Tenant pays for electricity, HVAC, water, and sewer, all included in rent." },
    ],
    CONTEXT, "utility-obligation-v1",
  );
  assertEquals(obligations.length, 4);
  assertEquals(new Set(obligations.map((o) => o.category)).size, 4, "each utility must produce a distinct category, never collapsed into one generic result");
});

Deno.test("fixture: tenant interior repairs + landlord structural repairs -> 2 obligations, correct party per component", () => {
  const obligations = repairsSpecialistToExpenseObligations(
    [
      { component: "interior", responsibleParty: "tenant", obligationType: "maintain", status: "explicit", sourcePage: 5, sourceQuote: "Tenant shall maintain the interior of the Premises." },
      { component: "structure", responsibleParty: "landlord", obligationType: "repair", status: "explicit", sourcePage: 5, sourceQuote: "Landlord shall repair the structure." },
    ],
    CONTEXT, "repair-obligation-v1",
  );
  assertEquals(obligations.length, 2);
  assertEquals(obligations[0].category, "interior_repairs");
  assertEquals(obligations[0].responsibleParty, "tenant");
  assertEquals(obligations[1].category, "structural_repairs");
  assertEquals(obligations[1].responsibleParty, "landlord");
});

Deno.test("fixture: CAM proportionate share -> allocationMethod pro_rata_share, responsibleParty tenant", () => {
  const [o] = camSpecialistToExpenseObligations(
    [{ category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share", amountType: "included", amount: null, percentage: null, cap: null, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 3, sourceQuote: "Tenant shall pay its Proportionate Share of Operating Expenses." }],
    CONTEXT, "cam-obligation-v1",
  );
  assertEquals(o.allocationMethod, "pro_rata_share");
  assertEquals(o.responsibleParty, "tenant");
  assertEquals(o.paymentMechanism, "additional_rent");
});

Deno.test("fixture: expense exclusions survive conversion unchanged", () => {
  const [o] = camSpecialistToExpenseObligations(
    [{ category: "operating_expenses", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share", amountType: "pass_through", amount: null, percentage: null, cap: null, inclusions: [], exclusions: ["capital expenditures", "depreciation", "leasing commissions"], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 6, sourceQuote: "Operating Expenses shall exclude capital expenditures, depreciation, and leasing commissions." }],
    CONTEXT, "cam-obligation-v1",
  );
  assertEquals(o.exclusions, ["capital expenditures", "depreciation", "leasing commissions"]);
});

Deno.test("fixture: estimated monthly payments with annual reconciliation -> both flags derived true", () => {
  const [o] = camSpecialistToExpenseObligations(
    [{
      category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share",
      amountType: "pass_through", amount: null, percentage: null, cap: null, inclusions: [], exclusions: [],
      reconciliationFrequency: "annual reconciliation of estimated monthly payments", auditRight: null,
      status: "explicit", sourcePage: 6, sourceQuote: "Tenant shall make estimated monthly payments, subject to annual reconciliation.",
    }],
    CONTEXT, "cam-obligation-v1",
  );
  assertEquals(o.reconciliation.estimatedPayments, true);
  assertEquals(o.reconciliation.annualReconciliation, true);
});

Deno.test("fixture: no reconciliation-related keywords -> flags stay null (no positive evidence either way), never guessed", () => {
  const [o] = camSpecialistToExpenseObligations(
    [{ category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share", amountType: "included", amount: null, percentage: null, cap: null, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "Tenant shall pay CAM as Additional Rent." }],
    CONTEXT, "cam-obligation-v1",
  );
  assertEquals(o.reconciliation.estimatedPayments, null);
  assertEquals(o.reconciliation.annualReconciliation, null);
});
