// @ts-nocheck
import { DATE_EXPRESSION_REGISTRY_VERSION } from "../date-expressions/date-expression-registry-version.ts";
import { addOffset, applyBusinessDayPolicy, compareDateOnly } from "./date-only-math.ts";
import { defaultCalculationProvenance } from "./calculation-types.ts";
import { LEASE_DATE_RESOLUTION_ENGINE_VERSION } from "./calculation-version.ts";

export interface DateExpressionForResolution {
  id: string;
  conceptKey: string;
  expressionType: string;
  status?: string;
  explicitDate?: string | null;
  anchorExpressionId?: string | null;
  eventKey?: string | null;
  offsetValue?: number | null;
  offsetUnit?: "day" | "week" | "month" | "year" | null;
  direction?: "before" | "after" | null;
  operandExpressionIds?: string[];
  businessDayPolicy?: "none" | "next_business_day" | "previous_business_day" | null;
  recurrence?: { mode: "first" | "next" | "count"; asOfDate?: string; maxOccurrences?: number; intervalValue?: number; intervalUnit?: "day" | "week" | "month" | "year" };
  sourceClaimIds?: string[];
  formulaKey?: string | null;
}

export interface DateResolutionResult {
  dateExpressionId: string;
  conceptKey: string;
  resolutionStatus: string;
  resolvedDate: string | null;
  resolutionType: string;
  formulaKey?: string | null;
  formulaVersion?: string | null;
  inputExpressionIds: string[];
  sourceClaimIds: string[];
  assumptions: Record<string, unknown>;
  businessDayPolicy?: string | null;
  validationStatus: string;
  validationCodes: string[];
  provenance: Record<string, unknown>;
}

export function resolveDateExpressions(
  expressions: DateExpressionForResolution[],
  eventDates: Record<string, string> = {},
): Map<string, DateResolutionResult> {
  const byId = new Map(expressions.map((expression) => [expression.id, expression]));
  const resolved = new Map<string, DateResolutionResult>();

  function result(expression: DateExpressionForResolution, status: string, date: string | null, codes: string[], inputs: string[] = [], assumptions: Record<string, unknown> = {}): DateResolutionResult {
    return {
      dateExpressionId: expression.id,
      conceptKey: expression.conceptKey,
      resolutionStatus: status,
      resolvedDate: date,
      resolutionType: expression.expressionType,
      formulaKey: expression.formulaKey ?? (status === "calculated" || status === "resolved" ? `${expression.expressionType}:v1` : null),
      formulaVersion: DATE_EXPRESSION_REGISTRY_VERSION,
      inputExpressionIds: [...inputs].sort(),
      sourceClaimIds: [...(expression.sourceClaimIds ?? [])].sort(),
      assumptions,
      businessDayPolicy: expression.businessDayPolicy ?? null,
      validationStatus: codes.length ? (status === "needs_review" || status === "ambiguous" ? "needs_review" : "unresolved") : "valid",
      validationCodes: codes,
      provenance: defaultCalculationProvenance(LEASE_DATE_RESOLUTION_ENGINE_VERSION, inputs, expression.sourceClaimIds ?? [], assumptions),
    };
  }

  function resolve(id: string, stack: string[] = []): DateResolutionResult {
    if (resolved.has(id)) return resolved.get(id)!;
    const expression = byId.get(id);
    if (!expression) {
      return {
        dateExpressionId: id,
        conceptKey: "missing",
        resolutionStatus: "unresolved",
        resolvedDate: null,
        resolutionType: "missing_expression",
        inputExpressionIds: [],
        sourceClaimIds: [],
        assumptions: {},
        validationStatus: "unresolved",
        validationCodes: ["DATE_INPUT_MISSING"],
        provenance: defaultCalculationProvenance(LEASE_DATE_RESOLUTION_ENGINE_VERSION),
      };
    }
    if (stack.includes(id)) {
      const cycle = result(expression, "needs_review", null, ["DATE_CYCLE_DETECTED"], stack);
      resolved.set(id, cycle);
      return cycle;
    }
    if (expression.status === "ambiguous") {
      const ambiguous = result(expression, "needs_review", null, ["DATE_INPUT_AMBIGUOUS"]);
      resolved.set(id, ambiguous);
      return ambiguous;
    }

    let out: DateResolutionResult;
    if (expression.expressionType === "fixed_date") {
      out = expression.explicitDate
        ? result(expression, "extracted_fixed", expression.explicitDate, [])
        : result(expression, "unresolved", null, ["DATE_FIXED_VALUE_MISSING"]);
    } else if (expression.expressionType === "event_date") {
      const supplied = expression.eventKey ? eventDates[expression.eventKey] : null;
      out = supplied ? result(expression, "resolved", supplied, [], [], { suppliedEvent: expression.eventKey }) : result(expression, "unresolved", null, ["DATE_EVENT_MISSING"]);
    } else if (expression.expressionType === "relative_to_date" || expression.expressionType === "relative_to_event" || expression.expressionType === "dependent_date" || expression.expressionType === "notice_window") {
      const anchor = expression.anchorExpressionId ? resolve(expression.anchorExpressionId, [...stack, id]) : null;
      if (!anchor || !anchor.resolvedDate || anchor.validationStatus !== "valid" || !expression.offsetValue || !expression.offsetUnit) {
        out = result(expression, "unresolved", null, ["DATE_REQUIRED_INPUT_MISSING"], expression.anchorExpressionId ? [expression.anchorExpressionId] : []);
      } else {
        const shifted = addOffset(anchor.resolvedDate, { value: expression.offsetValue, unit: expression.offsetUnit, direction: expression.direction ?? "after" });
        const business = applyBusinessDayPolicy(shifted, expression.businessDayPolicy ?? "none");
        out = business
          ? result(expression, "calculated", business, [], [expression.anchorExpressionId!], { offset: { value: expression.offsetValue, unit: expression.offsetUnit, direction: expression.direction ?? "after" } })
          : result(expression, "needs_review", null, ["DATE_BUSINESS_DAY_POLICY_UNSUPPORTED"], [expression.anchorExpressionId!]);
      }
    } else if (expression.expressionType === "earlier_of" || expression.expressionType === "later_of") {
      const inputs = expression.operandExpressionIds ?? [];
      const operands = inputs.map((input) => resolve(input, [...stack, id]));
      if (operands.length < 2 || operands.some((operand) => !operand.resolvedDate || operand.validationStatus !== "valid")) {
        out = result(expression, "unresolved", null, ["DATE_OPERAND_UNRESOLVED"], inputs);
      } else {
        const dates = operands.map((operand) => operand.resolvedDate!);
        dates.sort(compareDateOnly);
        out = result(expression, "calculated", expression.expressionType === "earlier_of" ? dates[0] : dates[dates.length - 1], [], inputs);
      }
    } else if (expression.expressionType === "recurring_deadline") {
      const anchor = expression.anchorExpressionId ? resolve(expression.anchorExpressionId, [...stack, id]) : null;
      if (!anchor?.resolvedDate || !expression.recurrence?.mode || !expression.offsetValue || !expression.offsetUnit) {
        out = result(expression, "unresolved", null, ["DATE_RECURRING_BOUNDS_MISSING"], expression.anchorExpressionId ? [expression.anchorExpressionId] : []);
      } else {
        const first = addOffset(anchor.resolvedDate, { value: expression.offsetValue, unit: expression.offsetUnit, direction: expression.direction ?? "after" });
        out = result(expression, "calculated", first, [], [expression.anchorExpressionId!], { recurrenceMode: expression.recurrence.mode, bounded: true });
      }
    } else {
      out = result(expression, "needs_review", null, ["DATE_RULE_UNSUPPORTED"]);
    }
    resolved.set(id, out);
    return out;
  }

  for (const expression of expressions) resolve(expression.id);
  return resolved;
}
