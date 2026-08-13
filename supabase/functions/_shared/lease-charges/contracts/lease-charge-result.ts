import type { SourceEvidenceRef } from "../../lease-terms/contracts/resolved-lease-terms.ts";

export type LeaseChargeStatus = "calculated" | "requires_review" | "blocked" | "not_applicable";

export interface LeaseChargeCalculationLine {
  sequence: number;
  lineType: string;
  formulaCode: string;
  label: string;
  inputAmount: number | null;
  outputAmount: number | null;
  explanation: string;
  source: string | null;
}

export interface LeaseChargeResult {
  contractVersion: "lease-charge-result-v1";
  chargeType: string;
  leaseId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  amount: number | null;
  currency: string;
  status: LeaseChargeStatus;
  reasonCodes: string[];
  inputs: Record<string, unknown>;
  calculationLines: LeaseChargeCalculationLine[];
  evidence: SourceEvidenceRef[];
}

export interface LeaseChargeResultInput {
  chargeType: string;
  leaseId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  amount?: number | null;
  currency?: string;
  status: LeaseChargeStatus;
  reasonCodes?: string[];
  inputs?: Record<string, unknown>;
  calculationLines?: LeaseChargeCalculationLine[];
  evidence?: SourceEvidenceRef[];
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function createLeaseChargeResult(input: LeaseChargeResultInput): LeaseChargeResult {
  return {
    contractVersion: "lease-charge-result-v1",
    chargeType: input.chargeType,
    leaseId: input.leaseId ?? null,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    amount: typeof input.amount === "number" && Number.isFinite(input.amount) ? roundCurrency(input.amount) : null,
    currency: input.currency ?? "USD",
    status: input.status,
    reasonCodes: input.reasonCodes ?? [],
    inputs: input.inputs ?? {},
    calculationLines: input.calculationLines ?? [],
    evidence: input.evidence ?? [],
  };
}
