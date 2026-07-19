// @ts-nocheck
import {
  LEASE_FINANCIAL_AMORTIZATION_CONTRACT_VERSION,
  LEASE_FINANCIAL_CHARGE_AMOUNT_CONTRACT_VERSION,
  LEASE_FINANCIAL_CHARGE_CONTRACT_VERSION,
  LEASE_FINANCIAL_CHARGE_PERIOD_CONTRACT_VERSION,
  LEASE_FINANCIAL_DEPOSIT_COMPONENT_CONTRACT_VERSION,
  LEASE_FINANCIAL_FORMULA_CONTRACT_VERSION,
  type FinancialAmortizationInput,
  type FinancialChargeAmountInput,
  type FinancialChargeInput,
  type FinancialChargePeriodInput,
  type FinancialDepositComponentInput,
  type FinancialFormulaInput,
} from "./financial-charge-types.ts";

async function sha256Hex(parts: unknown[]): Promise<string> {
  const normalized = parts.map((part) => {
    if (Array.isArray(part)) return [...part].map(String).sort().join(",");
    if (part && typeof part === "object") return JSON.stringify(part, Object.keys(part as Record<string, unknown>).sort());
    return part ?? "";
  });
  const bytes = new TextEncoder().encode(normalized.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stableFinancialSourceClaims(sourceClaimIds: string[] = []): string[] {
  return [...new Set(sourceClaimIds.filter(Boolean).map(String))].sort();
}

export async function buildFinancialChargeKey(input: FinancialChargeInput): Promise<string> {
  return sha256Hex([
    LEASE_FINANCIAL_CHARGE_CONTRACT_VERSION,
    input.orgId,
    input.packageId ?? input.leaseId ?? "no-lease-or-package",
    input.uploadedFileId,
    input.extractionRunId,
    input.generationId,
    input.sourcePackageDocumentId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
    input.chargeType,
    input.instanceKey ?? "default",
    stableFinancialSourceClaims(input.sourceClaimIds),
  ]);
}

export async function buildFinancialChargePeriodKey(input: FinancialChargePeriodInput): Promise<string> {
  return sha256Hex([
    LEASE_FINANCIAL_CHARGE_PERIOD_CONTRACT_VERSION,
    input.orgId,
    input.chargeKey,
    input.sequenceNumber ?? "",
    input.startExpressionId ?? "",
    input.endExpressionId ?? "",
    input.startTermMonth ?? "",
    input.endTermMonth ?? "",
    input.termCandidateId ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
  ]);
}

export async function buildFinancialChargeAmountKey(input: FinancialChargeAmountInput): Promise<string> {
  return sha256Hex([
    LEASE_FINANCIAL_CHARGE_AMOUNT_CONTRACT_VERSION,
    input.orgId,
    input.chargeKey,
    input.periodKey ?? "",
    input.amountRole,
    input.amountBasis,
    input.frequency ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
    input.formulaCandidateId ?? "",
  ]);
}

export async function buildFinancialDepositComponentKey(input: FinancialDepositComponentInput): Promise<string> {
  return sha256Hex([
    LEASE_FINANCIAL_DEPOSIT_COMPONENT_CONTRACT_VERSION,
    input.orgId,
    input.parentChargeKey,
    input.componentKeySeed ?? "",
    input.componentType,
    input.allocationRole,
    input.amountRole,
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
  ]);
}

export async function buildFinancialAmortizationKey(input: FinancialAmortizationInput): Promise<string> {
  return sha256Hex([
    LEASE_FINANCIAL_AMORTIZATION_CONTRACT_VERSION,
    input.orgId,
    input.chargeKey,
    input.generationId,
    input.amortizationType,
    input.principalAmountId ?? "",
    input.paymentAmountId ?? "",
    input.interestRateAmountId ?? "",
    input.termExpressionId ?? "",
    input.startExpressionId ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
  ]);
}

export async function buildFinancialFormulaKey(input: FinancialFormulaInput): Promise<string> {
  return sha256Hex([
    LEASE_FINANCIAL_FORMULA_CONTRACT_VERSION,
    input.orgId,
    input.chargeKey,
    input.generationId,
    input.formulaType,
    input.formulaText ?? "",
    stableFinancialSourceClaims(input.inputAmountIds ?? []),
    input.outputAmountRole ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
  ]);
}
