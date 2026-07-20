// @ts-nocheck
import { CLAIMS_REGISTRY_VERSION } from "../../claims/registry-version.ts";
import { DATE_EXPRESSION_REGISTRY_VERSION } from "../date-expressions/date-expression-registry-version.ts";
import { LEASE_FINANCIAL_CHARGE_REGISTRY_HASH, LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION } from "../charges/financial-charge-registry-version.ts";
import { LEASE_FINANCIAL_CALCULATION_VERSION } from "../calculation/calculation-version.ts";
import { buildFinancialCompatibilityCandidate } from "./financial-compatibility-builder.ts";
import { diffFinancialCompatibility, summarizeFinancialDiff } from "./financial-projection-diff.ts";
import { buildFinancialProjectionInputHash } from "./financial-projection-key.ts";
import { LEASE_FINANCIAL_PROJECTION_CLAIMS_REGISTRY_HASH, LEASE_FINANCIAL_PROJECTION_DATE_REGISTRY_HASH, LEASE_FINANCIAL_PROJECTION_VERSION } from "./financial-projection-version.ts";
import { validateFinancialProjectionRows, validateProjectionRunInput } from "./financial-projection-validator.ts";

export function planFinancialProjectionRun(input: { context: any; calculationRun: any; dateResults?: any[]; termResults?: any[]; rentResults?: any[]; rentPeriods?: any[]; chargeResults?: any[] }) {
  const inputHash = buildFinancialProjectionInputHash({
    calculationRunId: input.calculationRun.id ?? input.calculationRun.calculationRunId,
    calculationInputHash: input.calculationRun.inputHash,
    dateResults: input.dateResults ?? [],
    termResults: input.termResults ?? [],
    rentResults: input.rentResults ?? [],
    rentPeriods: input.rentPeriods ?? [],
    chargeResults: input.chargeResults ?? [],
  });
  return {
    financialProjectionVersion: LEASE_FINANCIAL_PROJECTION_VERSION,
    compatibilityContractVersion: CLAIMS_REGISTRY_VERSION,
    claimsRegistryVersion: CLAIMS_REGISTRY_VERSION,
    claimsRegistryHash: LEASE_FINANCIAL_PROJECTION_CLAIMS_REGISTRY_HASH,
    dateRegistryVersion: DATE_EXPRESSION_REGISTRY_VERSION,
    dateRegistryHash: LEASE_FINANCIAL_PROJECTION_DATE_REGISTRY_HASH,
    chargeRegistryVersion: LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION,
    chargeRegistryHash: LEASE_FINANCIAL_CHARGE_REGISTRY_HASH,
    calculationVersion: LEASE_FINANCIAL_CALCULATION_VERSION,
    mode: input.context.mode ?? "off",
    status: "running",
    inputHash,
    inputDateResultCount: input.dateResults?.length ?? 0,
    inputTermResultCount: input.termResults?.length ?? 0,
    inputRentResultCount: input.rentResults?.length ?? 0,
    inputChargeResultCount: input.chargeResults?.length ?? 0,
  };
}

export function buildFinancialProjection(input: { context: any; calculationRun: any; dateResults?: any[]; termResults?: any[]; rentResults?: any[]; rentPeriods?: any[]; chargeResults?: any[]; currentFields?: any; comparisonTarget?: string }) {
  const runErrors = validateProjectionRunInput(input.context, input.calculationRun);
  const candidate = buildFinancialCompatibilityCandidate(input);
  const rowErrors = validateFinancialProjectionRows(candidate.fieldProjections, candidate.scheduleProjections);
  const errors = [...new Set([...runErrors, ...rowErrors])];
  const diffs = input.currentFields ? diffFinancialCompatibility({ currentFields: input.currentFields, p4Fields: candidate.compatibilitySlice.fields, fieldProjections: candidate.fieldProjections, scheduleProjections: candidate.scheduleProjections }) : [];
  return {
    run: {
      ...planFinancialProjectionRun(input),
      status: errors.length ? "needs_review" : "completed",
      outputFieldCount: candidate.metadata.outputFieldCount,
      outputScheduleCount: candidate.metadata.outputScheduleCount,
      calculatedFieldCount: candidate.metadata.calculatedFieldCount,
      unresolvedFieldCount: candidate.metadata.unresolvedFieldCount,
      conflictCount: candidate.metadata.conflictCount,
      relatedDocumentCount: candidate.metadata.relatedDocumentCount,
      validationCodes: errors,
    },
    ...candidate,
    diffs,
    diffSummary: summarizeFinancialDiff(diffs),
  };
}
