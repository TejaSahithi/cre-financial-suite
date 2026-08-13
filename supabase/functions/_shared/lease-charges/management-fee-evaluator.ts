import { resolveLeaseTerms } from "../lease-terms/resolve.ts";
import type {
  LeaseTermsSnapshot,
  ResolvedLeaseTerms,
  SourceEvidenceRef,
} from "../lease-terms/contracts/resolved-lease-terms.ts";
import { createLeaseChargeResult, type LeaseChargeResult } from "./contracts/lease-charge-result.ts";

export type ManagementFeeBasis =
  | "tenant_annualized_rent"
  | "cam_pool"
  | "gross_rent"
  | "fixed_amount"
  | "manual_review";

export interface ManagementFeeRule {
  basis?: string | null;
  management_fee_basis?: string | null;
  fee_percent?: number | string | null;
  management_fee_percent?: number | string | null;
  admin_fee_percent?: number | string | null;
  fixed_amount?: number | string | null;
  sourceEvidence?: SourceEvidenceRef[];
}

export interface EvaluateManagementFeeInput {
  snapshot?: LeaseTermsSnapshot;
  resolvedTerms?: ResolvedLeaseTerms;
  rule?: ManagementFeeRule | null;
  asOfDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBasis(value: unknown): ManagementFeeBasis {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["tenant_annualized_rent", "tenant_annual_rent", "annualized_rent", "annual_rent", "rent_collected"].includes(text)) {
    return "tenant_annualized_rent";
  }
  if (["cam", "cam_pool", "cam_pool_pro_rata", "recoverable_pool", "operating_expense_pool"].includes(text)) {
    return "cam_pool";
  }
  if (["gross_rent", "gross_receipts_rent", "total_rent"].includes(text)) {
    return "gross_rent";
  }
  if (["fixed", "fixed_amount", "flat", "flat_amount"].includes(text)) {
    return "fixed_amount";
  }
  return "manual_review";
}

function percentFromRule(rule: ManagementFeeRule | null | undefined): number | null {
  return asNumber(rule?.fee_percent ?? rule?.management_fee_percent ?? rule?.admin_fee_percent);
}

function fixedAmountFromRule(rule: ManagementFeeRule | null | undefined): number | null {
  return asNumber(rule?.fixed_amount);
}

export function evaluateManagementFee(input: EvaluateManagementFeeInput): LeaseChargeResult {
  const terms = input.resolvedTerms ?? (input.snapshot ? resolveLeaseTerms(input.snapshot, input.asOfDate) : null);
  const rule = input.rule ?? {};
  const basis = normalizeBasis(rule.basis ?? rule.management_fee_basis);
  const periodStart = input.periodStart ?? terms?.rent?.periodStart ?? input.asOfDate;
  const periodEnd = input.periodEnd ?? terms?.rent?.periodEnd ?? input.asOfDate;
  const evidence = [...(terms?.sourceEvidence ?? []), ...(rule.sourceEvidence ?? [])];

  if (!terms) {
    return createLeaseChargeResult({
      chargeType: "management_fee",
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["LEASE_TERMS_REQUIRED"],
      inputs: { basis },
      evidence,
    });
  }

  if (basis === "fixed_amount") {
    const fixedAmount = fixedAmountFromRule(rule);
    if (fixedAmount == null) {
      return createLeaseChargeResult({
        chargeType: "management_fee",
        leaseId: terms.leaseId,
        periodStart,
        periodEnd,
        status: "blocked",
        reasonCodes: ["MANAGEMENT_FEE_FIXED_AMOUNT_REQUIRED"],
        inputs: { basis },
        evidence,
      });
    }
    return createLeaseChargeResult({
      chargeType: "management_fee",
      leaseId: terms.leaseId,
      periodStart,
      periodEnd,
      amount: fixedAmount,
      status: "calculated",
      reasonCodes: [],
      inputs: { basis, fixedAmount },
      calculationLines: [{
        sequence: 1,
        lineType: "FIXED_AMOUNT",
        formulaCode: "MANAGEMENT_FEE_FIXED_AMOUNT",
        label: "Fixed management fee",
        inputAmount: fixedAmount,
        outputAmount: fixedAmount,
        explanation: "Approved fixed management fee amount.",
        source: "approved_management_fee_rule",
      }],
      evidence,
    });
  }

  if (basis !== "tenant_annualized_rent") {
    return createLeaseChargeResult({
      chargeType: "management_fee",
      leaseId: terms.leaseId,
      periodStart,
      periodEnd,
      status: basis === "manual_review" ? "requires_review" : "blocked",
      reasonCodes: basis === "manual_review"
        ? ["MANAGEMENT_FEE_BASIS_REQUIRES_REVIEW"]
        : ["MANAGEMENT_FEE_BASIS_NOT_IMPLEMENTED"],
      inputs: { basis },
      evidence,
    });
  }

  const annualizedRent = terms.rent?.annualAmount ?? (
    terms.rent?.monthlyAmount != null ? terms.rent.monthlyAmount * 12 : null
  );
  const feePercent = percentFromRule(rule);
  if (annualizedRent == null) {
    return createLeaseChargeResult({
      chargeType: "management_fee",
      leaseId: terms.leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["ANNUALIZED_RENT_REQUIRED"],
      inputs: { basis, feePercent },
      evidence,
    });
  }
  if (feePercent == null) {
    return createLeaseChargeResult({
      chargeType: "management_fee",
      leaseId: terms.leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["MANAGEMENT_FEE_PERCENT_REQUIRED"],
      inputs: { basis, annualizedRent },
      evidence,
    });
  }

  const amount = annualizedRent * (feePercent / 100);
  return createLeaseChargeResult({
    chargeType: "management_fee",
    leaseId: terms.leaseId,
    periodStart,
    periodEnd,
    amount,
    status: "calculated",
    reasonCodes: [],
    inputs: { basis, annualizedRent, feePercent },
    calculationLines: [{
      sequence: 1,
      lineType: "BASIS",
      formulaCode: "ANNUALIZED_RENT_X_PERCENT",
      label: "Annualized rent basis",
      inputAmount: annualizedRent,
      outputAmount: amount,
      explanation: `Annualized rent multiplied by management fee percent ${feePercent}%.`,
      source: "resolved_lease_terms",
    }],
    evidence,
  });
}
