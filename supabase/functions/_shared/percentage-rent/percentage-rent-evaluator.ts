import { createLeaseChargeResult, type LeaseChargeResult } from "../lease-charges/contracts/lease-charge-result.ts";
import type { SourceEvidenceRef } from "../lease-terms/contracts/resolved-lease-terms.ts";

export interface PercentageRentTerm {
  lease_id?: string | null;
  status?: string | null;
  percentage_rate?: number | string | null;
  breakpoint_amount?: number | string | null;
  breakpoint_type?: string | null;
  effective_start?: string | null;
  effective_end?: string | null;
  sourceEvidence?: SourceEvidenceRef[];
}

export interface TenantSalesReport {
  lease_id?: string | null;
  status?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  gross_sales_amount?: number | string | null;
  exclusions_amount?: number | string | null;
  net_reportable_sales?: number | string | null;
  currency?: string | null;
  sourceEvidence?: SourceEvidenceRef[];
}

export interface EvaluatePercentageRentInput {
  term: PercentageRentTerm | null;
  salesReport: TenantSalesReport | null;
  asOfDate?: string | null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isApproved(status: unknown): boolean {
  return String(status || "").toLowerCase() === "approved";
}

function effectiveOn(term: PercentageRentTerm, asOfDate?: string | null): boolean {
  if (!asOfDate) return true;
  if (term.effective_start && term.effective_start > asOfDate) return false;
  if (term.effective_end && term.effective_end < asOfDate) return false;
  return true;
}

export function evaluatePercentageRent(input: EvaluatePercentageRentInput): LeaseChargeResult {
  const term = input.term;
  const report = input.salesReport;
  const evidence = [...(term?.sourceEvidence ?? []), ...(report?.sourceEvidence ?? [])];
  const leaseId = term?.lease_id ?? report?.lease_id ?? null;
  const periodStart = report?.period_start ?? null;
  const periodEnd = report?.period_end ?? null;

  if (!term) {
    return createLeaseChargeResult({
      chargeType: "percentage_rent",
      leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["PERCENTAGE_RENT_TERM_REQUIRED"],
      evidence,
    });
  }
  if (!isApproved(term.status)) {
    return createLeaseChargeResult({
      chargeType: "percentage_rent",
      leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["PERCENTAGE_RENT_TERM_NOT_APPROVED"],
      inputs: { termStatus: term.status },
      evidence,
    });
  }
  if (!effectiveOn(term, input.asOfDate)) {
    return createLeaseChargeResult({
      chargeType: "percentage_rent",
      leaseId,
      periodStart,
      periodEnd,
      status: "not_applicable",
      reasonCodes: ["PERCENTAGE_RENT_TERM_NOT_EFFECTIVE"],
      inputs: { asOfDate: input.asOfDate, effectiveStart: term.effective_start, effectiveEnd: term.effective_end },
      evidence,
    });
  }
  if (!report) {
    return createLeaseChargeResult({
      chargeType: "percentage_rent",
      leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["SALES_REPORT_REQUIRED"],
      evidence,
    });
  }
  if (!isApproved(report.status)) {
    return createLeaseChargeResult({
      chargeType: "percentage_rent",
      leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["SALES_REPORT_NOT_APPROVED"],
      inputs: { reportStatus: report.status },
      evidence,
    });
  }

  const rate = asNumber(term.percentage_rate);
  const breakpoint = asNumber(term.breakpoint_amount) ?? 0;
  const netSales = asNumber(report.net_reportable_sales) ?? Math.max((asNumber(report.gross_sales_amount) ?? 0) - (asNumber(report.exclusions_amount) ?? 0), 0);
  if (rate == null || rate < 0) {
    return createLeaseChargeResult({
      chargeType: "percentage_rent",
      leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["PERCENTAGE_RATE_REQUIRED"],
      inputs: { netSales, breakpoint },
      evidence,
    });
  }
  if (breakpoint < 0) {
    return createLeaseChargeResult({
      chargeType: "percentage_rent",
      leaseId,
      periodStart,
      periodEnd,
      status: "blocked",
      reasonCodes: ["BREAKPOINT_AMOUNT_INVALID"],
      inputs: { breakpoint },
      evidence,
    });
  }

  const excessSales = Math.max(netSales - breakpoint, 0);
  const amount = excessSales * (rate / 100);
  return createLeaseChargeResult({
    chargeType: "percentage_rent",
    leaseId,
    periodStart,
    periodEnd,
    amount,
    currency: report.currency ?? "USD",
    status: "calculated",
    inputs: { netSales, breakpoint, percentageRate: rate, excessSales },
    calculationLines: [
      {
        sequence: 1,
        lineType: "EXCESS_SALES",
        formulaCode: "NET_SALES_MINUS_BREAKPOINT",
        label: "Excess sales above breakpoint",
        inputAmount: netSales,
        outputAmount: excessSales,
        explanation: "Net reportable sales minus approved breakpoint; floored at zero.",
        source: "approved_sales_report",
      },
      {
        sequence: 2,
        lineType: "PERCENTAGE_RENT",
        formulaCode: "EXCESS_SALES_X_PERCENT",
        label: "Percentage rent",
        inputAmount: excessSales,
        outputAmount: amount,
        explanation: `Excess sales multiplied by approved percentage rate ${rate}%.`,
        source: "approved_percentage_rent_term",
      },
    ],
    evidence,
  });
}