// @ts-nocheck
import {
  LEASE_CHARGE_CALCULATION_ENGINE_VERSION,
  LEASE_DATE_ARITHMETIC_POLICY_VERSION,
  LEASE_DATE_RESOLUTION_ENGINE_VERSION,
  LEASE_FINANCIAL_CALCULATION_VERSION,
  LEASE_FINANCIAL_ROUNDING_POLICY_VERSION,
  LEASE_RENT_CALCULATION_ENGINE_VERSION,
  LEASE_TERM_RESOLUTION_ENGINE_VERSION,
} from "./calculation-version.ts";

export const CALCULATION_RUN_STATUSES = [
  "running",
  "completed",
  "completed_with_warnings",
  "needs_review",
  "failed",
  "superseded",
] as const;

export const RESOLUTION_STATUSES = [
  "extracted_fixed",
  "resolved",
  "calculated",
  "unresolved",
  "ambiguous",
  "needs_review",
  "requires_related_document",
  "not_applicable",
  "unreadable",
  "extraction_failed",
] as const;

export const VALIDATION_STATUSES = ["valid", "warning", "needs_review", "invalid", "unresolved"] as const;

export const CALCULATION_CONFLICT_TYPES = [
  "date_resolution_conflict",
  "explicit_vs_calculated_date_conflict",
  "term_duration_conflict",
  "rent_stated_vs_calculated_conflict",
  "rent_period_overlap",
  "escalation_result_conflict",
  "deposit_reconciliation_conflict",
  "amortization_result_conflict",
  "percentage_formula_conflict",
  "conflicting_formula_inputs",
  "stale_generation_input",
  "related_document_required",
  "unsupported_calculation_rule",
] as const;

export const CALCULATION_REVIEW_OPERATIONS = [
  "accept_calculated_result",
  "reject_calculated_result",
  "select_date_path",
  "select_formula_input",
  "approve_rounding_policy",
  "approve_business_day_policy",
  "accept_stated_value",
  "replace_assumption",
  "mark_unresolved",
  "mark_manual_required",
  "reopen",
] as const;

export interface CalculationContext {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId?: string | null;
  extractionRunId: string;
  generationId: string;
  activeGenerationId?: string | null;
  calculationVersion?: string;
  dateEngineVersion?: string;
  termEngineVersion?: string;
  rentEngineVersion?: string;
  chargeEngineVersion?: string;
  roundingPolicy?: string;
}

export interface SourceInputRef {
  id: string;
  orgId: string;
  generationId: string;
  packageId?: string | null;
  leaseId?: string | null;
  status?: string | null;
}

export interface CalculationProvenance {
  calculationVersion: string;
  engineVersion: string;
  arithmeticPolicy?: string;
  roundingPolicy?: string;
  sourceInputIds: string[];
  sourceClaimIds: string[];
  assumptions: Record<string, unknown>;
}

export function defaultCalculationProvenance(
  engineVersion: string,
  sourceInputIds: string[] = [],
  sourceClaimIds: string[] = [],
  assumptions: Record<string, unknown> = {},
): CalculationProvenance {
  return {
    calculationVersion: LEASE_FINANCIAL_CALCULATION_VERSION,
    engineVersion,
    arithmeticPolicy: LEASE_DATE_ARITHMETIC_POLICY_VERSION,
    roundingPolicy: LEASE_FINANCIAL_ROUNDING_POLICY_VERSION,
    sourceInputIds: [...sourceInputIds].sort(),
    sourceClaimIds: [...sourceClaimIds].sort(),
    assumptions,
  };
}

export function defaultEngineVersions() {
  return {
    calculationVersion: LEASE_FINANCIAL_CALCULATION_VERSION,
    dateEngineVersion: LEASE_DATE_RESOLUTION_ENGINE_VERSION,
    termEngineVersion: LEASE_TERM_RESOLUTION_ENGINE_VERSION,
    rentEngineVersion: LEASE_RENT_CALCULATION_ENGINE_VERSION,
    chargeEngineVersion: LEASE_CHARGE_CALCULATION_ENGINE_VERSION,
    roundingPolicy: LEASE_FINANCIAL_ROUNDING_POLICY_VERSION,
  };
}

export function assertSameCalculationContext(context: CalculationContext, refs: SourceInputRef[]): string[] {
  const errors: string[] = [];
  for (const ref of refs) {
    if (ref.orgId !== context.orgId) errors.push("CALC_INPUT_CROSS_ORG");
    if (context.packageId && ref.packageId && ref.packageId !== context.packageId) errors.push("CALC_INPUT_WRONG_PACKAGE");
    if (context.leaseId && ref.leaseId && ref.leaseId !== context.leaseId) errors.push("CALC_INPUT_WRONG_LEASE");
    if (ref.generationId !== context.generationId) errors.push("CALC_INPUT_GENERATION_MISMATCH");
    if (context.activeGenerationId && ref.generationId !== context.activeGenerationId) errors.push("CALC_INPUT_GENERATION_STALE");
    if (ref.status && ["superseded", "invalid", "rejected"].includes(ref.status)) errors.push("CALC_INPUT_NOT_AUTHORITATIVE");
  }
  return [...new Set(errors)];
}
