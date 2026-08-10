// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3, steps 8
// and 9: execute one lease's ordered, typed policy steps against its
// pool-share of a segment's adjusted pool amount. Steps run in the exact
// sequence lease_recovery_policy_steps.sequence assigned at materialization
// time (see supabase/migrations/20269900000014_..._materialization_
// corrections.sql's step-generation order) — that ordering already places
// GROSS_UP before APPLY_BASE_YEAR before APPLY_EXPENSE_STOP before
// APPLY_CAP before ADD_ADMIN_FEE before PRORATE before RECONCILE_ESTIMATES,
// which is what makes "fee applies after cap, not before" (CAM-G13) true
// by construction rather than a special case here.
//
// Requirement 10 (base year and expense stop are separate methods unless
// both are explicitly configured) is also satisfied by construction: the
// runner only ever executes steps that materialization actually created.
// A rule with has_base_year=true and no expense_stop_amount produces only
// an APPLY_BASE_YEAR step; both fields set produces both steps, which the
// runner then genuinely composes — that is the "explicit" signal the
// blueprint asks for, not a boolean flag on the policy row.
import type { CalcException, CalculationLine } from "../contracts/cam-output.ts";
import type { LeaseRecoveryPolicyStep } from "../contracts/cam-domain-types.ts";
import type { PriorCamHistoryEntry, BaseYearSourceSnapshot } from "../contracts/cam-input.ts";
import type { Segment } from "../time/period-slicer.ts";
import { inclusiveDayCount } from "../time/date-math.ts";

export interface PolicyStepRunContext {
  leaseId: string;
  poolId: string | null;
  segment: Segment;
  fiscalYearDays: number;
  numeratorArea: number;
  denominatorArea: number;
  priorCamHistory: PriorCamHistoryEntry[];
  baseYearSnapshots: BaseYearSourceSnapshot[];
  controllableInputAmount: number;
  uncontrollableInputAmount: number;
}

export interface PolicyStepRunResult {
  finalAmount: number;
  lines: CalculationLine[];
  exceptions: CalcException[];
}

let lineSequenceCounter = 0;

export function runPolicySteps(
  steps: LeaseRecoveryPolicyStep[],
  inputAmount: number,
  ctx: PolicyStepRunContext,
): PolicyStepRunResult {
  const lines: CalculationLine[] = [];
  const exceptions: CalcException[] = [];
  let running = inputAmount;
  // Tracks what FRACTION of `running` is controllable, not an absolute
  // dollar amount — `inputAmount` here is the pool-level (pre-tenant-share)
  // category amount, so ctx.controllableInputAmount/uncontrollableInputAmount
  // are pool-level too. An absolute controllable tracker would go stale the
  // instant CALCULATE_SHARE or DIRECT_ASSIGN rescales `running` to the
  // tenant's own share; deriving controllableShare from `before * fraction`
  // at cap time keeps it correctly proportional no matter what steps ran
  // first.
  const initialControlTotal = ctx.controllableInputAmount + ctx.uncontrollableInputAmount;
  let controllableFraction = initialControlTotal > 0 ? ctx.controllableInputAmount / initialControlTotal : 0;

  const pushLine = (line: Omit<CalculationLine, "sequence" | "lease_id" | "pool_id" | "segment_start" | "segment_end">) => {
    lines.push({
      ...line,
      sequence: ++lineSequenceCounter,
      lease_id: ctx.leaseId,
      pool_id: ctx.poolId,
      segment_start: ctx.segment.start,
      segment_end: ctx.segment.end,
    });
  };

  const orderedSteps = [...steps].sort((a, b) => a.sequence - b.sequence);

  for (const step of orderedSteps) {
    const before = running;
    switch (step.step_type) {
      case "INCLUDE_CATEGORY":
      case "EXCLUDE_CATEGORY":
        // Membership decisions, already applied upstream by
        // applyCategoryInclusionExclusion — recorded here only for
        // explainability continuity, not re-applied.
        continue;

      case "CALCULATE_SHARE": {
        const recoveryMethod = String(step.parameters?.recovery_method ?? "");
        const tenantSharePercent = step.parameters?.tenant_share_percent as number | null | undefined;
        let share: number;
        let formula: string;
        if (recoveryMethod === "fixed_percentage" && tenantSharePercent != null) {
          share = tenantSharePercent / 100;
          formula = "FIXED_PERCENTAGE";
        } else if (before === 0) {
          // No allocable pool amount reached this step this segment (e.g. a
          // month the pool's published expenses don't cover at all) --
          // `running` will stay exactly 0 regardless of what share is
          // computed here (0 * anything = 0), so a missing/zero denominator
          // has no effect on the output and is not a real data defect.
          // Blocking on it would fail readiness for months that legitimately
          // have nothing to allocate. See CAM readiness/engine parity fix.
          share = 0;
          formula = "AREA_PRO_RATA_NO_AMOUNT";
        } else {
          if (ctx.denominatorArea <= 0) {
            exceptions.push({
              severity: "blocking", code: "DENOMINATOR_ZERO", entity_type: "lease_recovery_policy_steps", entity_id: step.id,
              message: `Pool ${ctx.poolId} has a zero or negative denominator area for segment ${ctx.segment.start}..${ctx.segment.end}`,
            });
            share = 0;
            formula = "AREA_PRO_RATA_BLOCKED";
          } else {
            share = ctx.numeratorArea / ctx.denominatorArea;
            formula = "AREA_PRO_RATA";
          }
        }
        running = round6(before * share);
        pushLine({
          line_type: "TENANT_SHARE", category: null, formula_code: formula,
          input_amount: before, output_amount: running, adjustment: round6(running - before),
          policy_step_id: step.id,
          explanation: `${formula}: ${ctx.numeratorArea} / ${ctx.denominatorArea} = ${(share * 100).toFixed(4)}% of ${before}`,
        });
        break;
      }

      case "DIRECT_ASSIGN": {
        const annualAmount = Number(step.parameters?.estimated_annual_amount ?? 0);
        const segmentDays = inclusiveDayCount(ctx.segment.start, ctx.segment.end);
        running = ctx.fiscalYearDays > 0 ? round6((annualAmount * segmentDays) / ctx.fiscalYearDays) : 0;
        pushLine({
          line_type: "DIRECT_ASSIGN", category: null, formula_code: "DIRECT_ASSIGN_PRORATED",
          input_amount: before, output_amount: running, adjustment: round6(running - before),
          policy_step_id: step.id,
          explanation: `Direct-assigned annual amount ${annualAmount} prorated ${segmentDays}/${ctx.fiscalYearDays} days`,
        });
        break;
      }

      case "GROSS_UP_VARIABLE":
        // Gross-up is applied at the pool level before this per-lease step
        // runner is invoked (see pools/gross-up.ts) — recorded here for
        // explainability continuity only.
        continue;

      case "APPLY_BASE_YEAR": {
        const baseYear = String(step.parameters?.base_year ?? "");
        const explicitAmount = step.parameters?.base_year_amount as number | null | undefined;
        const snapshot = ctx.baseYearSnapshots.find((s) => s.base_year === baseYear && s.pool_id === ctx.poolId);
        const normalizedBaseAmount = snapshot?.normalized_amount ?? (explicitAmount ?? null);
        if (normalizedBaseAmount === null) {
          exceptions.push({
            severity: "blocking", code: "BASE_YEAR_MISSING", entity_type: "lease_recovery_policy_steps", entity_id: step.id,
            message: `Policy step ${step.id} requires base year ${baseYear || "(unspecified)"} but no base_year_snapshot or explicit base_year_amount is available`,
          });
          break;
        }
        // The base-year amount is normalized at the POOL level (the whole
        // building/property's base-year expenses); this step runs AFTER
        // CALCULATE_SHARE, so `before` is already the tenant's own share of
        // the current pool. The base deduction must be the tenant's
        // EQUIVALENT share of the base-year pool, computed with the same
        // area ratio, not the raw pool-wide base amount. normalizedBaseAmount
        // is an ANNUAL figure (like expense_stop_amount below) — it must be
        // prorated to this segment's day count before comparing against
        // `before`, which is only this segment's slice of the year; skipping
        // that proration would deduct the FULL annual base amount in every
        // monthly segment and silently zero out the whole year's recovery.
        const baseYearSegmentDays = inclusiveDayCount(ctx.segment.start, ctx.segment.end);
        const baseAmountForSegment = ctx.fiscalYearDays > 0 ? round6((normalizedBaseAmount * baseYearSegmentDays) / ctx.fiscalYearDays) : normalizedBaseAmount;
        const tenantBaseShare = round6(baseAmountForSegment * (ctx.denominatorArea > 0 ? ctx.numeratorArea / ctx.denominatorArea : 0));
        running = round6(Math.max(0, before - tenantBaseShare));
        pushLine({
          line_type: "BASE_YEAR", category: null, formula_code: "BASE_YEAR_DOLLAR",
          input_amount: before, output_amount: running, adjustment: round6(running - before),
          policy_step_id: step.id,
          explanation: `Base year ${baseYear}: tenant share of normalized base amount ${normalizedBaseAmount} (${tenantBaseShare}) deducted`,
        });
        break;
      }

      case "APPLY_EXPENSE_STOP": {
        const stopAmountAnnual = Number(step.parameters?.expense_stop_amount ?? 0);
        const segmentDays = inclusiveDayCount(ctx.segment.start, ctx.segment.end);
        const stopAmountForSegment = ctx.fiscalYearDays > 0 ? round6((stopAmountAnnual * segmentDays) / ctx.fiscalYearDays) : stopAmountAnnual;
        running = round6(Math.max(0, before - stopAmountForSegment));
        pushLine({
          line_type: "EXPENSE_STOP", category: null, formula_code: "EXPENSE_STOP_DOLLAR",
          input_amount: before, output_amount: running, adjustment: round6(running - before),
          policy_step_id: step.id,
          explanation: `Expense stop ${stopAmountAnnual}/yr prorated to ${stopAmountForSegment} for this segment, deducted`,
        });
        break;
      }

      case "APPLY_CAP": {
        const capType = normalizeCapType(String(step.parameters?.cap_type ?? ""));
        const capAmount = step.parameters?.cap_amount as number | null | undefined;
        const capPercent = step.parameters?.cap_percent as number | null | undefined;

        if (capType === "unrecognized") {
          exceptions.push({
            severity: "blocking", code: "CAP_TYPE_UNRECOGNIZED", entity_type: "lease_recovery_policy_steps", entity_id: step.id,
            message: `Policy step ${step.id} has an unrecognized cap_type "${step.parameters?.cap_type}"`,
          });
          break;
        }

        const history = ctx.priorCamHistory.filter((h) => h.lease_id === ctx.leaseId).sort((a, b) => a.fiscal_year - b.fiscal_year);
        const priorEntry = history[history.length - 1] ?? null;

        let permitted: number | null = null;
        if (capType === "fixed_dollar") {
          permitted = capAmount ?? null;
        } else if (capType === "noncumulative") {
          if (priorEntry) {
            permitted = round6(priorEntry.permitted_controllable_amount * (1 + (capPercent ?? 0) / 100));
          } else {
            exceptions.push({
              severity: "warning", code: "CAP_HISTORY_MISSING", entity_type: "lease_recovery_policy_steps", entity_id: step.id,
              message: `No prior CAM history for lease ${ctx.leaseId} — noncumulative cap cannot establish a baseline this year; controllable amount passes through uncapped`,
            });
            permitted = null;
          }
        } else if (capType === "cumulative") {
          if (history.length > 0) {
            const base = capAmount ?? history[0].permitted_controllable_amount;
            const yearsElapsed = history[history.length - 1].fiscal_year - history[0].fiscal_year + 1;
            permitted = round6(base * Math.pow(1 + (capPercent ?? 0) / 100, yearsElapsed));
          } else if (capAmount != null) {
            permitted = capAmount; // first year: the base itself is the permitted amount
          } else {
            exceptions.push({
              severity: "warning", code: "CAP_HISTORY_MISSING", entity_type: "lease_recovery_policy_steps", entity_id: step.id,
              message: `No prior CAM history and no explicit cap_amount base for lease ${ctx.leaseId} — cumulative cap cannot be established this year; controllable amount passes through uncapped`,
            });
            permitted = null;
          }
        }

        // `permitted` is an ANNUAL ceiling (prior-year history and cap_amount
        // are both annual figures); `before` is only this segment's slice of
        // the year, so the ceiling must be prorated to the same slice before
        // comparison — otherwise a full-year cap like "$1,000/yr" would
        // never bind against any single month's much smaller share and the
        // cap would silently have no effect across the whole run.
        const capSegmentDays = inclusiveDayCount(ctx.segment.start, ctx.segment.end);
        const permittedForSegment = permitted !== null && ctx.fiscalYearDays > 0 ? round6((permitted * capSegmentDays) / ctx.fiscalYearDays) : permitted;
        const controllableShare = round6(before * controllableFraction);
        const cappedControllable = permittedForSegment !== null ? Math.min(controllableShare, permittedForSegment) : controllableShare;
        const capAdjustment = round6(cappedControllable - controllableShare);
        running = round6(before + capAdjustment); // only the controllable portion is reduced; uncontrollable passes through untouched
        if (running !== 0) controllableFraction = cappedControllable / running; // keep the fraction in sync for any later cap step
        pushLine({
          line_type: "CAP", category: null, formula_code: `CAP_${capType.toUpperCase()}`,
          input_amount: before, output_amount: running, adjustment: capAdjustment,
          policy_step_id: step.id,
          explanation: permittedForSegment !== null
            ? `${capType} cap: controllable ${controllableShare} capped to permitted ${permittedForSegment} (annual ceiling ${permitted} prorated to this segment)`
            : `${capType} cap: no baseline available, passed through uncapped`,
        });
        break;
      }

      case "APPLY_FLOOR": {
        const floorAmount = Number(step.parameters?.floor_amount ?? 0);
        running = round6(Math.max(before, floorAmount));
        pushLine({
          line_type: "FLOOR", category: null, formula_code: "APPLY_FLOOR",
          input_amount: before, output_amount: running, adjustment: round6(running - before),
          policy_step_id: step.id,
          explanation: `Minimum permitted recovery floor ${floorAmount} enforced`,
        });
        break;
      }

      case "APPLY_DEDUCTIBLE": {
        const deductible = Number(step.parameters?.deductible_amount ?? 0);
        running = round6(Math.max(0, before - deductible));
        pushLine({
          line_type: "DEDUCTIBLE", category: null, formula_code: "APPLY_DEDUCTIBLE",
          input_amount: before, output_amount: running, adjustment: round6(running - before),
          policy_step_id: step.id,
          explanation: `Deductible threshold ${deductible} applied`,
        });
        break;
      }

      case "ADD_MANAGEMENT_FEE":
      case "ADD_ADMIN_FEE": {
        const feePercent = Number(step.parameters?.admin_fee_percent ?? step.parameters?.management_fee_percent ?? 0);
        const feeAmount = round6(before * (feePercent / 100));
        running = round6(before + feeAmount);
        pushLine({
          line_type: step.step_type === "ADD_ADMIN_FEE" ? "ADMIN_FEE" : "MANAGEMENT_FEE", category: null, formula_code: "FEE_ON_ELIGIBLE_EXPENSES",
          input_amount: before, output_amount: running, adjustment: feeAmount,
          policy_step_id: step.id,
          explanation: `${feePercent}% fee applied to post-cap recovery ${before}`,
        });
        break;
      }

      case "ADD_CAPITAL_AMORTIZATION": {
        const amortizedAmount = Number(step.parameters?.amortized_amount_for_period ?? 0);
        running = round6(before + amortizedAmount);
        pushLine({
          line_type: "CAPITAL_AMORTIZATION", category: null, formula_code: "ADD_CAPITAL_AMORTIZATION",
          input_amount: before, output_amount: running, adjustment: amortizedAmount,
          policy_step_id: step.id,
          explanation: `Capital amortization for this period ${amortizedAmount} added`,
        });
        break;
      }

      case "PRORATE": {
        // Proration already happened via day-weighted segment math
        // throughout (assembleSegmentAmounts, computeDenominatorArea,
        // computeTenantNumeratorArea) — this step is a documented
        // pass-through confirming that, for explainability/audit purposes.
        pushLine({
          line_type: "PRORATE", category: null, formula_code: "SEGMENT_DAY_WEIGHTED",
          input_amount: before, output_amount: before, adjustment: 0,
          policy_step_id: step.id,
          explanation: `Amount already reflects ${inclusiveDayCount(ctx.segment.start, ctx.segment.end)}-day segment proration applied upstream`,
        });
        break;
      }

      case "RECONCILE_ESTIMATES":
        // Reconciliation against estimates_billed happens once, at the
        // lease-level annual rollup, not per segment — see
        // reconciliation/estimate-reconciliation.ts. No-op here.
        continue;

      default:
        exceptions.push({
          severity: "blocking", code: "UNRECOGNIZED_POLICY_STEP", entity_type: "lease_recovery_policy_steps", entity_id: step.id,
          message: `Unrecognized policy step_type "${step.step_type}"`,
        });
    }
  }

  return { finalAmount: running, lines, exceptions };
}

function normalizeCapType(raw: string): "fixed_dollar" | "noncumulative" | "cumulative" | "unrecognized" {
  const v = raw.toLowerCase();
  if (["fixed_dollar", "fixed", "fixed_dollar_cap"].includes(v)) return "fixed_dollar";
  if (["noncumulative", "non_cumulative", "noncumulative_year_over_year"].includes(v)) return "noncumulative";
  if (["cumulative", "cumulative_compounding", "cumulative_carryforward"].includes(v)) return "cumulative";
  return "unrecognized";
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
