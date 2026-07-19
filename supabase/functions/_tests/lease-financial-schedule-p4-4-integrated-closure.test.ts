import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildFinancialChargeAmountKey, buildFinancialChargeKey } from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-key.ts";
import { validateFinancialAmortizationCandidate, validateFinancialChargeAmountCandidate, validateFinancialChargeCandidate, validateFinancialDepositComponentCandidate, validateFinancialFormulaCandidate } from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-validation.ts";
import { LEASE_FINANCIAL_CHARGE_REGISTRY_HASH, LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION } from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-registry-version.ts";

const orgId = "org-p44";
const leaseId = "lease-p44";
const packageId = "package-p44";
const uploadedFileId = "file-p44";
const extractionRunId = "run-p44";
const generationId = "generation-p44";
const context = {
  orgId,
  leaseId,
  packageId,
  uploadedFileId,
  extractionRunId,
  generationId,
  activeGenerationId: generationId,
  sourceClaims: ["cam", "deposit", "ti", "percent", "amort"].map((name) => ({ id: `claim-${name}`, orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "asserted" })),
};

function charge(overrides: Record<string, unknown>): any {
  return {
    orgId,
    leaseId,
    packageId,
    uploadedFileId,
    extractionRunId,
    generationId,
    registryVersion: LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION,
    registryHash: LEASE_FINANCIAL_CHARGE_REGISTRY_HASH,
    sourcePackageDocumentId: "package-document-p44",
    sourcePackageEffectiveClaimId: "effective-claim-p44",
    chargeStatus: "extracted",
    originType: "extracted",
    currencyCode: "USD",
    producerType: "semantic_extractor",
    producerName: "p4.4_integrated_fixture",
    providerInvocationId: "provider-invocation-p44",
    confidence: 0.88,
    metadata: { sanitized_fixture: true },
    ...overrides,
  };
}

Deno.test("P4.4 integrated closure: charge package preserves explicit values and no calculated outputs", async () => {
  const cam = charge({ instanceKey: "cam", chargeType: "cam_estimate", chargeDomain: "additional_charge", financialRole: "tenant_payable", frequency: "annually", estimateStatus: "stated_estimate", sourceClaimIds: ["claim-cam"] });
  const deposit = charge({ instanceKey: "deposit", chargeType: "security_deposit", chargeDomain: "deposit_or_prepayment", financialRole: "escrow_or_deposit", frequency: "one_time", estimateStatus: "stated_final", sourceClaimIds: ["claim-deposit"] });
  const allowance = charge({ instanceKey: "ti-allowance", chargeType: "tenant_improvement_allowance", chargeDomain: "allowance_or_contribution", financialRole: "landlord_payable", frequency: "one_time", estimateStatus: "stated_final", sourceClaimIds: ["claim-ti"] });
  const percentage = charge({ instanceKey: "percentage-rent", chargeType: "percentage_rent", chargeDomain: "percentage_rent", financialRole: "tenant_payable", frequency: "percentage_rent_period", estimateStatus: "not_applicable", sourceClaimIds: ["claim-percent"] });
  const amortized = charge({ instanceKey: "amortized-improvement", chargeType: "amortized_improvement_charge", chargeDomain: "amortization_instruction", financialRole: "tenant_payable", frequency: "monthly", estimateStatus: "not_applicable", sourceClaimIds: ["claim-amort"] });

  for (const item of [cam, deposit, allowance, percentage, amortized]) {
    assertEquals(validateFinancialChargeCandidate(item, context), { valid: true, status: "valid", errorCodes: [] });
  }

  const camKey = await buildFinancialChargeKey(cam);
  const camAmount = { orgId, chargeKey: camKey, generationId, amountRole: "estimated_amount", amountBasis: "per_square_foot_per_year", statedAmount: 5.25, currencyCode: "USD", frequency: "annually", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-cam" };
  assertEquals(validateFinancialChargeAmountCandidate(camAmount, context, cam), { valid: true, status: "valid", errorCodes: [] });

  const depositKey = await buildFinancialChargeKey(deposit);
  const depositAmount = { orgId, chargeKey: depositKey, generationId, amountRole: "deposit_amount", amountBasis: "fixed_amount", statedAmount: 15535.36, currencyCode: "USD", frequency: "one_time", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-deposit" };
  const depositComponent = { orgId, parentChargeKey: depositKey, componentKeySeed: "letter-of-credit", generationId, componentType: "letter_of_credit", allocationRole: "security_deposit_portion", amountRole: "deposit_amount", statedAmount: 2626.76, currencyCode: "USD", componentStatus: "extracted", sourceClaimId: "claim-deposit" };
  assertEquals(validateFinancialChargeAmountCandidate(depositAmount, context, deposit), { valid: true, status: "valid", errorCodes: [] });
  assertEquals(validateFinancialDepositComponentCandidate(depositComponent, context, deposit), { valid: true, status: "valid", errorCodes: [] });

  const allowanceKey = await buildFinancialChargeKey(allowance);
  const allowanceAmount = { orgId, chargeKey: allowanceKey, generationId, amountRole: "allowance_amount", amountBasis: "fixed_amount", statedAmount: 68352, currencyCode: "USD", frequency: "one_time", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-ti" };
  assertEquals(validateFinancialChargeAmountCandidate(allowanceAmount, context, allowance), { valid: true, status: "valid", errorCodes: [] });

  const percentageKey = await buildFinancialChargeKey(percentage);
  const percentageFormula = { orgId, chargeKey: percentageKey, generationId, formulaType: "percentage_rent_formula", formulaStatus: "explicit_formula", formulaText: "5% of annual gross sales over breakpoint", inputAmountIds: [], outputAmountRole: "formula_output_placeholder", sourceClaimId: "claim-percent" };
  assertEquals(validateFinancialFormulaCandidate(percentageFormula, context), { valid: true, status: "valid", errorCodes: [] });

  const amortizedKey = await buildFinancialChargeKey(amortized);
  const principalKey = await buildFinancialChargeAmountKey({ orgId, chargeKey: amortizedKey, generationId, amountRole: "principal_amount", amountBasis: "principal", statedAmount: 12350, currencyCode: "USD", frequency: "one_time", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-amort" });
  const paymentKey = await buildFinancialChargeAmountKey({ orgId, chargeKey: amortizedKey, generationId, amountRole: "payment_amount", amountBasis: "payment", statedAmount: 174.55, currencyCode: "USD", frequency: "monthly", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-amort" });
  const amortization = { orgId, chargeKey: amortizedKey, generationId, amortizationType: "tenant_improvement_repayment", amortizationStatus: "explicit_instruction", principalAmountId: principalKey, paymentAmountId: paymentKey, sourceClaimId: "claim-amort" };
  assertEquals(validateFinancialAmortizationCandidate(amortization, context), { valid: true, status: "valid", errorCodes: [] });

  assert(validateFinancialFormulaCandidate({ ...percentageFormula, metadata: { calculated_percentage_rent: 999 } }, context).errorCodes.includes("CHARGE_NO_CALCULATION_ALLOWED"));
});
