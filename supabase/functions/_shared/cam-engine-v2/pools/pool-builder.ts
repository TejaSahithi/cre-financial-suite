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
  // Display label only — see CamExpenseInputRow.category. Retained so
  // calculation lines and pool results can show a human-readable category
  // without a second lookup.
  category: string | null;
  // Canonical category key used for ALL matching against
  // recovery_pool_categories and lease_recovery_policy_steps.
  expense_category_id: string | null;
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
        expense_category_id: input.expense_category_id,
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
 *
 * Matching is on the canonical expense_category_id ONLY. recovery_pool_
 * categories.expense_category_id is a public.expense_categories UUID, so
 * comparing it against the free-text `category` label can never match:
 * every exclude rule would silently stop excluding, and — because a pool
 * that has any include rule treats a non-matching amount as excluded —
 * every expense in a normally-configured pool would fall through to
 * `excluded`, driving the pool to zero (specification 8.3, 16).
 *
 * An amount whose canonical category could not be resolved cannot be
 * classified against a configured pool. It is reported as a blocking
 * EXPENSE_CATEGORY_MISSING and held out of the recoverable total rather
 * than being guessed into it (specification 1 rule 5, 18.3).
 */
export function applyCategoryInclusionExclusion(
  amounts: PoolSegmentAmount[],
  poolCategories: Record<string, RecoveryPoolCategory[]>,
): { included: PoolSegmentAmount[]; excluded: PoolSegmentAmount[]; exceptions: CalcException[] } {
  const included: PoolSegmentAmount[] = [];
  const excluded: PoolSegmentAmount[] = [];
  const exceptions: CalcException[] = [];
  const reported = new Set<string>();

  for (const amount of amounts) {
    const categories = poolCategories[amount.pool_id] ?? [];
    if (categories.length === 0) {
      included.push(amount);
      continue;
    }

    if (!amount.expense_category_id) {
      // Report once per source input per pool, not once per segment.
      const key = `${amount.pool_id}|${amount.source_expense_input_id}`;
      if (!reported.has(key)) {
        reported.add(key);
        exceptions.push({
          severity: "blocking",
          code: "EXPENSE_CATEGORY_MISSING",
          entity_type: "cam_expense_inputs",
          entity_id: amount.source_expense_input_id,
          message:
            `Published CAM expense input ${amount.source_expense_input_id} has no canonical expense_category_id, ` +
            `so it cannot be matched against pool ${amount.pool_id}'s configured categories` +
            (amount.category ? ` (label '${amount.category}' did not resolve to exactly one category)` : "") +
            `. Resolve the category on the source expense and republish.`,
        });
      }
      excluded.push(amount);
      continue;
    }

    const excludeMatch = categories.find((c) => c.expense_category_id === amount.expense_category_id && c.inclusion_mode === "exclude");
    if (excludeMatch) {
      excluded.push(amount);
      continue;
    }
    const includeMatch = categories.find((c) => c.expense_category_id === amount.expense_category_id && c.inclusion_mode === "include");
    const hasAnyIncludeRule = categories.some((c) => c.inclusion_mode === "include");
    if (includeMatch || !hasAnyIncludeRule) {
      included.push(amount);
    } else {
      excluded.push(amount);
    }
  }

  return { included, excluded, exceptions };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
