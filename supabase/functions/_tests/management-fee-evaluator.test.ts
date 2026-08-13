import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateManagementFee } from "../_shared/lease-charges/management-fee-evaluator.ts";
import type { ResolvedLeaseTerms } from "../_shared/lease-terms/contracts/resolved-lease-terms.ts";

function resolvedTerms(overrides: Partial<ResolvedLeaseTerms> = {}): ResolvedLeaseTerms {
  return {
    leaseId: "lease-1",
    asOfDate: "2026-08-01",
    premises: { propertyId: "property-1", buildingId: "building-1", unitId: "unit-1", rsf: 1000 },
    rent: {
      monthlyAmount: 1200,
      annualAmount: 14400,
      rowType: "base_rent",
      phase: "contracted",
      periodStart: "2026-07-01",
      periodEnd: "2026-12-31",
      abatementApplied: null,
      effectiveDatingSupported: true,
    },
    expenseRecovery: { ruleSetId: "rule-set-1", status: "approved", effectiveDatingSupported: false },
    cam: { ruleSetId: "rule-set-1", status: "approved", effectiveDatingSupported: false },
    managementFee: null,
    percentageRent: null,
    taxes: null,
    insurance: null,
    utilities: null,
    hvac: null,
    renewalOptions: null,
    reportingRequirements: null,
    unresolvedTerms: [],
    sourceEvidence: [],
    ...overrides,
  };
}

Deno.test("management fee evaluates against annualized rent for the effective period", () => {
  const result = evaluateManagementFee({
    resolvedTerms: resolvedTerms(),
    asOfDate: "2026-08-01",
    rule: { basis: "tenant_annualized_rent", fee_percent: 5 },
  });

  assertEquals(result.status, "calculated");
  assertEquals(result.amount, 720);
  assertEquals(result.inputs.annualizedRent, 14400);
  assertEquals(result.periodStart, "2026-07-01");
});

Deno.test("management fee blocks when annualized rent is missing", () => {
  const result = evaluateManagementFee({
    resolvedTerms: resolvedTerms({ rent: null }),
    asOfDate: "2026-08-01",
    rule: { basis: "tenant_annualized_rent", fee_percent: 5 },
  });

  assertEquals(result.status, "blocked");
  assertEquals(result.reasonCodes, ["ANNUALIZED_RENT_REQUIRED"]);
});

Deno.test("management fee blocks CAM-pool basis instead of forcing it into CAM V2", () => {
  const result = evaluateManagementFee({
    resolvedTerms: resolvedTerms(),
    asOfDate: "2026-08-01",
    rule: { basis: "cam_pool", fee_percent: 5 },
  });

  assertEquals(result.status, "blocked");
  assertEquals(result.reasonCodes, ["MANAGEMENT_FEE_BASIS_NOT_IMPLEMENTED"]);
});

Deno.test("management fee requires review for unknown basis", () => {
  const result = evaluateManagementFee({
    resolvedTerms: resolvedTerms(),
    asOfDate: "2026-08-01",
    rule: { basis: "some unusual lease wording", fee_percent: 5 },
  });

  assertEquals(result.status, "requires_review");
  assertEquals(result.reasonCodes, ["MANAGEMENT_FEE_BASIS_REQUIRES_REVIEW"]);
});
