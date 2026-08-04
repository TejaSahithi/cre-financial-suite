// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3, steps 4
// and 5: assemble pool expenses from published cam_expense_inputs and
// balanced pool assignments, then apply category inclusion/exclusion.
import { compareDates, inclusiveDayCount, overlapRange } from "../time/date-math.ts";
import type { Segment } from "../time/period-slicer.ts";
import type { CamExpenseInputRow, PoolAssignmentInput } from "../contracts/cam-input.ts";
import type { RecoveryPoolCategory } from "../contracts/cam-domain-types.ts";
import type { CalcException } from "../contracts/cam-output.ts";

export interface PoolSegmentAmount {
  pool_id: string;
  segment: Segment;
  category: string | null;
  amount: number;
  source_expense_input_id: string;
  variability: "fixed" | "variable" | "semi_variable" | "unknown";
  controllability: "controllable" | "uncontrollable" | "unknown";
}

/**
 * Prorates one published expense input's pool-assigned dollars across the
 * run's segments using its own service period, per blueprint 8.2:
 *   allocated = assignment_amount * overlap_days(service_period, slice) / total_days(service_period)
 * An input with no service_period_start/end at all cannot be prorated and
 * produces a blocking exception (Phase 3 requirement 15) rather than being
 * guessed into every slice or a single arbitrary one.
 */
export function assembleSegmentAmounts(
  segments: Segment[],
  expenseInputs: CamExpenseInputRow[],
  assignments: PoolAssignmentInput[],
): { amounts: PoolSegmentAmount[]; exceptions: CalcException[] } {
  const amounts: PoolSegmentAmount[] = [];
  const exceptions: CalcException[] = [];
  const inputsById = new Map(expenseInputs.map((i) => [i.id, i]));

  for (const assignment of assignments) {
    const input = inputsById.get(assignment.cam_expense_input_id);
    if (!input) {
      exceptions.push({
        severity: "blocking",
        code: "POOL_ASSIGNMENT_ORPHANED",
        entity_type: "cam_input_pool_assignments",
        entity_id: assignment.id,
        message: `Pool assignment ${assignment.id} references cam_expense_input ${assignment.cam_expense_input_id}, which is not in the snapshot's published input set`,
      });
      continue;
    }

    const servicePeriodStart = input.service_period_start;
    const servicePeriodEnd = input.service_period_end;
    if (!servicePeriodStart || !servicePeriodEnd) {
      exceptions.push({
        severity: "blocking",
        code: "EXPENSE_SERVICE_PERIOD_MISSING",
        entity_type: "cam_expense_inputs",
        entity_id: input.id,
        message: `Published CAM expense input ${input.id} has no service period recorded and cannot be prorated across monthly segments`,
      });
      continue;
    }
    if (compareDates(servicePeriodStart, servicePeriodEnd) > 0) {
      exceptions.push({
        severity: "blocking",
        code: "EXPENSE_SERVICE_PERIOD_INVALID",
        entity_type: "cam_expense_inputs",
        entity_id: input.id,
        message: `Published CAM expense input ${input.id} has service_period_end before service_period_start`,
      });
      continue;
    }

    const totalDays = inclusiveDayCount(servicePeriodStart, servicePeriodEnd);
    for (const segment of segments) {
      const overlap = overlapRange(servicePeriodStart, servicePeriodEnd, segment.start, segment.end);
      if (!overlap) continue;
      const proratedAmount = round6((assignment.amount * overlap.days) / totalDays);
      if (proratedAmount === 0) continue;
      amounts.push({
        pool_id: assignment.recovery_pool_id,
        segment,
        category: input.category,
        amount: proratedAmount,
        source_expense_input_id: input.id,
        variability: input.variability,
        controllability: input.controllability,
      });
    }
  }

  return { amounts, exceptions };
}

/**
 * Applies a pool's category inclusion/exclusion list (step 5). A pool with
 * zero configured categories is treated as open (everything included) —
 * that gap is Phase 2C's POOL_CATEGORY_MISSING readiness check's job to
 * flag, not this function's. An explicit 'exclude' entry always wins over
 * an 'include' entry for the same category (blueprint's own precedence:
 * "Explicit exclusion versus broad inclusion: Explicit category exclusion
 * wins").
 */
export function applyCategoryInclusionExclusion(
  amounts: PoolSegmentAmount[],
  poolCategories: Record<string, RecoveryPoolCategory[]>,
): { included: PoolSegmentAmount[]; excluded: PoolSegmentAmount[] } {
  const included: PoolSegmentAmount[] = [];
  const excluded: PoolSegmentAmount[] = [];

  for (const amount of amounts) {
    const categories = poolCategories[amount.pool_id] ?? [];
    if (categories.length === 0) {
      included.push(amount);
      continue;
    }
    const excludeMatch = categories.find((c) => c.expense_category_id === amount.category && c.inclusion_mode === "exclude");
    if (excludeMatch) {
      excluded.push(amount);
      continue;
    }
    const includeMatch = categories.find((c) => c.expense_category_id === amount.category && c.inclusion_mode === "include");
    const hasAnyIncludeRule = categories.some((c) => c.inclusion_mode === "include");
    if (includeMatch || !hasAnyIncludeRule) {
      included.push(amount);
    } else {
      excluded.push(amount);
    }
  }

  return { included, excluded };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
