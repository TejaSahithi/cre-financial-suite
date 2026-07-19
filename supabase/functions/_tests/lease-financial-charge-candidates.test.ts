import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildFinancialAmortizationKey,
  buildFinancialChargeAmountKey,
  buildFinancialChargeKey,
  buildFinancialChargePeriodKey,
  buildFinancialDepositComponentKey,
  buildFinancialFormulaKey,
} from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-key.ts";
import {
  validateFinancialAmortizationCandidate,
  validateFinancialChargeAmountCandidate,
  validateFinancialChargeCandidate,
  validateFinancialChargePeriodCandidate,
  validateFinancialChargePeriodSet,
  validateFinancialDepositComponentCandidate,
  validateFinancialFormulaCandidate,
} from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-validation.ts";
import { LEASE_FINANCIAL_CHARGE_REGISTRY_HASH, LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION } from "../_shared/extraction/lease-financial-schedule/charges/financial-charge-registry-version.ts";

const orgId = "org-a";
const leaseId = "lease-a";
const packageId = "package-a";
const uploadedFileId = "file-a";
const extractionRunId = "run-a";
const generationId = "generation-a";

const context = {
  orgId,
  leaseId,
  packageId,
  uploadedFileId,
  extractionRunId,
  generationId,
  activeGenerationId: generationId,
  dateExpressions: [
    { id: "expr-start", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "valid" },
    { id: "expr-end", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "valid" },
  ],
  sourceClaims: [
    { id: "claim-cam", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "asserted" },
    { id: "claim-deposit", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "asserted" },
    { id: "claim-ti", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "asserted" },
    { id: "claim-percent", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "asserted" },
  ],
  baseRentScheduleCandidates: [
    { id: "base-rent-schedule-a", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "valid" },
  ],
};

const camCharge = {
  orgId,
  leaseId,
  packageId,
  uploadedFileId,
  extractionRunId,
  generationId,
  sourcePackageDocumentId: "package-document-a",
  sourcePackageEffectiveClaimId: "effective-claim-cam",
  instanceKey: "cam-estimate-initial",
  registryVersion: LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION,
  registryHash: LEASE_FINANCIAL_CHARGE_REGISTRY_HASH,
  chargeType: "cam_estimate",
  chargeDomain: "additional_charge",
  financialRole: "tenant_payable",
  chargeStatus: "extracted",
  originType: "extracted",
  currencyCode: "USD",
  frequency: "annually",
  estimateStatus: "stated_estimate",
  sourceClaimIds: ["claim-cam"],
  producerType: "semantic_extractor",
  producerName: "p4.4_fixture",
  providerInvocationId: "provider-invocation-a",
  confidence: 0.9,
  metadata: { fixture: "sanitized_charge" },
};

Deno.test("P4.4 charges: candidate keys are stable and include attempt identity", async () => {
  const key = await buildFinancialChargeKey(camCharge);
  const reordered = await buildFinancialChargeKey({ ...camCharge, sourceClaimIds: ["claim-cam"], confidence: 0.1, metadata: { display: "$5.25 PSF" } });
  const newGeneration = await buildFinancialChargeKey({ ...camCharge, generationId: "generation-b" });
  assertEquals(key, reordered);
  assert(key !== newGeneration);
});

Deno.test("P4.4 charges: CAM estimates validate as estimates and cannot masquerade as base rent", () => {
  assertEquals(validateFinancialChargeCandidate(camCharge, context), { valid: true, status: "valid", errorCodes: [] });
  assert(validateFinancialChargeCandidate({ ...camCharge, baseRentScheduleCandidateId: "base-rent-schedule-a" }, context).errorCodes.includes("CHARGE_BASE_RENT_CONFLATION"));
  assert(validateFinancialChargeCandidate({ ...camCharge, estimateStatus: "stated_final" }, context).errorCodes.includes("CHARGE_ESTIMATE_FINAL_CONFLATION"));
  assert(validateFinancialChargeCandidate({ ...camCharge, metadata: { computed_cam: 15760.5 } }, context).errorCodes.includes("CHARGE_NO_CALCULATION_ALLOWED"));
});

Deno.test("P4.4 amounts and periods: preserve explicit values without expansion or calculation", async () => {
  const chargeKey = await buildFinancialChargeKey(camCharge);
  const period = { orgId, chargeKey, leaseId, packageId, generationId, periodStatus: "extracted", sequenceNumber: 1, startExpressionId: "expr-start", endExpressionId: "expr-end", sourceClaimId: "claim-cam" };
  const periodKey = await buildFinancialChargePeriodKey(period);
  const amount = { orgId, chargeKey, periodKey, generationId, amountRole: "estimated_amount", amountBasis: "per_square_foot_per_year", statedAmount: 5.25, currencyCode: "USD", frequency: "annually", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-cam" };
  assertEquals(validateFinancialChargePeriodCandidate(period, context), { valid: true, status: "valid", errorCodes: [] });
  assertEquals(validateFinancialChargeAmountCandidate(amount, context, camCharge), { valid: true, status: "valid", errorCodes: [] });
  assert((await buildFinancialChargeAmountKey(amount)).length === 64);
  assert(validateFinancialChargePeriodCandidate({ ...period, metadata: { due_dates: ["2026-01-01"] } }, context).errorCodes.includes("CHARGE_NO_CALCULATION_ALLOWED"));
  assert(validateFinancialChargePeriodSet([{ ...period, startTermMonth: 1, endTermMonth: 12 }, { ...period, startTermMonth: 12, endTermMonth: 24 }]).errorCodes.includes("CHARGE_PERIOD_OVERLAP"));
});

Deno.test("P4.4 deposits: parent candidate and components remain explicit and unsummed", async () => {
  const deposit = { ...camCharge, instanceKey: "security-deposit", chargeType: "security_deposit", chargeDomain: "deposit_or_prepayment", financialRole: "escrow_or_deposit", frequency: "one_time", estimateStatus: "stated_final", sourceClaimIds: ["claim-deposit"] };
  const depositKey = await buildFinancialChargeKey(deposit);
  const amount = { orgId, chargeKey: depositKey, generationId, amountRole: "deposit_amount", amountBasis: "fixed_amount", statedAmount: 15535.36, currencyCode: "USD", frequency: "one_time", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-deposit" };
  const component = { orgId, parentChargeKey: depositKey, componentKeySeed: "cash", generationId, componentType: "cash_deposit", allocationRole: "security_deposit_portion", amountRole: "deposit_amount", statedAmount: 12908.6, currencyCode: "USD", componentStatus: "extracted", sourceClaimId: "claim-deposit" };
  assertEquals(validateFinancialChargeCandidate(deposit, context), { valid: true, status: "valid", errorCodes: [] });
  assertEquals(validateFinancialChargeAmountCandidate(amount, context, deposit), { valid: true, status: "valid", errorCodes: [] });
  assertEquals(validateFinancialDepositComponentCandidate(component, context, deposit), { valid: true, status: "valid", errorCodes: [] });
  assert((await buildFinancialDepositComponentKey(component)).length === 64);
  assert(validateFinancialDepositComponentCandidate({ ...component, metadata: { computed_total: 15535.36 } }, context, deposit).errorCodes.includes("CHARGE_NO_CALCULATION_ALLOWED"));
});

Deno.test("P4.4 formulas and amortization: preserve instructions, never computed schedules", async () => {
  const charge = { ...camCharge, instanceKey: "amortized-grease-trap", chargeType: "amortized_improvement_charge", chargeDomain: "amortization_instruction", estimateStatus: "not_applicable", frequency: "monthly", sourceClaimIds: ["claim-ti"] };
  const chargeKey = await buildFinancialChargeKey(charge);
  const principal = { orgId, chargeKey, generationId, amountRole: "principal_amount", amountBasis: "principal", statedAmount: 12350, currencyCode: "USD", frequency: "one_time", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-ti" };
  const payment = { orgId, chargeKey, generationId, amountRole: "payment_amount", amountBasis: "payment", statedAmount: 174.55, currencyCode: "USD", frequency: "monthly", amountStatus: "extracted", originType: "extracted", sourceClaimId: "claim-ti" };
  const principalKey = await buildFinancialChargeAmountKey(principal);
  const paymentKey = await buildFinancialChargeAmountKey(payment);
  const amortization = { orgId, chargeKey, generationId, amortizationType: "tenant_improvement_repayment", amortizationStatus: "explicit_instruction", principalAmountId: principalKey, paymentAmountId: paymentKey, sourceClaimId: "claim-ti" };
  assertEquals(validateFinancialAmortizationCandidate(amortization, context), { valid: true, status: "valid", errorCodes: [] });
  assert((await buildFinancialAmortizationKey(amortization)).length === 64);
  assert(validateFinancialAmortizationCandidate({ ...amortization, metadata: { amortization_schedule: [{ month: 1, payment: 174.55 }] } }, context).errorCodes.includes("CHARGE_NO_CALCULATION_ALLOWED"));

  const percentageRent = { ...camCharge, instanceKey: "percentage-rent", chargeType: "percentage_rent", chargeDomain: "percentage_rent", estimateStatus: "not_applicable", frequency: "percentage_rent_period", sourceClaimIds: ["claim-percent"] };
  const percentKey = await buildFinancialChargeKey(percentageRent);
  const formula = { orgId, chargeKey: percentKey, generationId, formulaType: "percentage_rent_formula", formulaStatus: "explicit_formula", formulaText: "6% of gross sales above stated breakpoint", inputAmountIds: [], outputAmountRole: "formula_output_placeholder", sourceClaimId: "claim-percent" };
  assertEquals(validateFinancialFormulaCandidate(formula, context), { valid: true, status: "valid", errorCodes: [] });
  assert((await buildFinancialFormulaKey(formula)).length === 64);
  assert(validateFinancialFormulaCandidate({ ...formula, metadata: { calculatedOutputAmount: 2200 } }, context).errorCodes.includes("CHARGE_NO_CALCULATION_ALLOWED"));
});
