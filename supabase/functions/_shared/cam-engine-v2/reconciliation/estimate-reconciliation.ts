// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3, step 9
// (RECONCILE_ESTIMATES) and blueprint section 8.8. Runs once per lease per
// run, after every segment's final_recovery has been summed to an annual
// total — not per segment, since estimates are billed on their own
// schedule independent of the calculation's internal segmentation.
//
// Phase 3B product decision 4: approved_prior_period_adjustments and
// prior_credits_applied are no longer bare numbers defaulting to zero. Each
// must be an explicit CamPriorPeriodAdjustment row in one of four states —
// KNOWN_ZERO, KNOWN_AMOUNT, UNKNOWN, or NOT_APPLICABLE — and a MISSING row
// (no adjustment record at all for this lease/period/type) is treated
// exactly like UNKNOWN, never like KNOWN_ZERO. UNKNOWN produces a
// review_required exception; in a posting_eligible run that exception is
// promoted to blocking so the run cannot post over an unresolved figure,
// while a preview run leaves it as a warning so reviewers can still see
// draft numbers.
import type { CamEstimateSchedule, CamPriorPeriodAdjustment } from "../contracts/cam-domain-types.ts";
import type { CalcException, CalculationLine } from "../contracts/cam-output.ts";

export interface ReconciliationResult {
  finalRecovery: number;
  estimatesBilled: number;
  amountDueOrCredit: number;
  line: CalculationLine;
}

function resolveAdjustmentAmount(
  leaseId: string,
  recoveryPeriodId: string,
  adjustmentType: CamPriorPeriodAdjustment["adjustment_type"],
  adjustments: CamPriorPeriodAdjustment[],
  runMode: "preview" | "posting_eligible",
  exceptions: CalcException[],
): number {
  const row = adjustments.find((a) => a.lease_id === leaseId && a.recovery_period_id === recoveryPeriodId && a.adjustment_type === adjustmentType);

  if (!row || row.state === "UNKNOWN") {
    exceptions.push({
      severity: runMode === "posting_eligible" ? "blocking" : "warning",
      code: "PRIOR_ADJUSTMENT_UNKNOWN",
      entity_type: "cam_prior_period_adjustments",
      entity_id: row?.id ?? null,
      message: row
        ? `${adjustmentType} for lease ${leaseId}/period ${recoveryPeriodId} is explicitly UNKNOWN — cannot post until resolved`
        : `No ${adjustmentType} record exists for lease ${leaseId}/period ${recoveryPeriodId} — treated as UNKNOWN, not zero, until an explicit state is recorded`,
    });
    return 0;
  }

  if (row.state === "KNOWN_ZERO" || row.state === "NOT_APPLICABLE") return 0;

  // KNOWN_AMOUNT — the DB CHECK constraint guarantees amount is non-null here.
  return row.amount ?? 0;
}

export function reconcileEstimates(
  leaseId: string,
  recoveryPeriodId: string,
  finalRecovery: number,
  estimateSchedules: CamEstimateSchedule[],
  priorAdjustments: CamPriorPeriodAdjustment[],
  recoveryPeriodStart: string,
  recoveryPeriodEnd: string,
  runMode: "preview" | "posting_eligible",
): { result: ReconciliationResult; exceptions: CalcException[] } {
  const exceptions: CalcException[] = [];
  const leaseEstimates = estimateSchedules.filter(
    (e) => e.lease_id === leaseId && e.status !== "void" && e.month_date >= recoveryPeriodStart && e.month_date <= recoveryPeriodEnd,
  );
  const estimatesBilled = round2(leaseEstimates.reduce((sum, e) => sum + e.amount, 0));

  const priorApprovedAdjustments = resolveAdjustmentAmount(leaseId, recoveryPeriodId, "prior_period_adjustment", priorAdjustments, runMode, exceptions);
  const priorCreditsApplied = resolveAdjustmentAmount(leaseId, recoveryPeriodId, "prior_credit", priorAdjustments, runMode, exceptions);

  const amountDueOrCredit = round2(finalRecovery - estimatesBilled + priorApprovedAdjustments - priorCreditsApplied);

  const line: CalculationLine = {
    lease_id: leaseId,
    pool_id: null,
    sequence: 0, // orchestrator assigns the real running sequence
    line_type: "ESTIMATE_RECON",
    category: null,
    formula_code: "RECONCILE_ESTIMATES",
    input_amount: finalRecovery,
    output_amount: amountDueOrCredit,
    adjustment: round2(amountDueOrCredit - finalRecovery),
    policy_step_id: null,
    explanation: `Final recovery ${finalRecovery} less estimates billed ${estimatesBilled}${priorApprovedAdjustments ? ` + adjustments ${priorApprovedAdjustments}` : ""}${priorCreditsApplied ? ` - prior credits ${priorCreditsApplied}` : ""} = ${amountDueOrCredit} (${amountDueOrCredit >= 0 ? "due from tenant" : "credit to tenant"})`,
    segment_start: recoveryPeriodStart,
    segment_end: recoveryPeriodEnd,
  };

  return { result: { finalRecovery, estimatesBilled, amountDueOrCredit, line }, exceptions };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
