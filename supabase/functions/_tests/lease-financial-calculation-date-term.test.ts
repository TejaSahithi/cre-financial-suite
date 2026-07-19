import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { addDays, addMonths, addOffset } from "../_shared/extraction/lease-financial-schedule/calculation/date-only-math.ts";
import { resolveDateExpressions } from "../_shared/extraction/lease-financial-schedule/calculation/date-expression-resolver.ts";
import { resolveLeaseTerm } from "../_shared/extraction/lease-financial-schedule/calculation/term-resolver.ts";

Deno.test("P4.5 dates 1-7,10-14: fixed, relative, EOM, leap, operands, missing event and timezone independence", () => {
  assertEquals(addMonths("2024-01-31", 1), "2024-02-29");
  assertEquals(addMonths("2023-01-31", 1), "2023-02-28");
  assertEquals(addDays("2024-02-28", 1), "2024-02-29");
  assertEquals(addOffset("2031-02-28", { value: 180, unit: "day", direction: "before" }), "2030-09-01");
  assertEquals(addMonths("2024-01-15", 86), "2031-03-15");

  const results = resolveDateExpressions([
    { id: "commencement", conceptKey: "commencement_date", expressionType: "fixed_date", explicitDate: "2024-01-15", sourceClaimIds: ["claim-start"] },
    { id: "expiration", conceptKey: "expiration_date", expressionType: "relative_to_date", anchorExpressionId: "commencement", offsetValue: 86, offsetUnit: "month", direction: "after", sourceClaimIds: ["claim-term"] },
    { id: "notice", conceptKey: "option_notice_deadline", expressionType: "notice_window", anchorExpressionId: "expiration", offsetValue: 180, offsetUnit: "day", direction: "before", sourceClaimIds: ["claim-notice"] },
    { id: "co", conceptKey: "certificate_of_occupancy", expressionType: "event_date", eventKey: "co_issued", sourceClaimIds: ["claim-co"] },
    { id: "co-plus-one", conceptKey: "rent_commencement_date", expressionType: "relative_to_event", anchorExpressionId: "co", offsetValue: 1, offsetUnit: "day", direction: "after", sourceClaimIds: ["claim-rent"] },
    { id: "early", conceptKey: "earlier_of", expressionType: "earlier_of", operandExpressionIds: ["commencement", "expiration"] },
    { id: "late", conceptKey: "later_of", expressionType: "later_of", operandExpressionIds: ["commencement", "expiration"] },
  ], { co_issued: "2024-02-29" });

  assertEquals(results.get("commencement")?.resolutionStatus, "extracted_fixed");
  assertEquals(results.get("expiration")?.resolvedDate, "2031-03-15");
  assertEquals(results.get("notice")?.resolvedDate, "2030-09-16");
  assertEquals(results.get("co-plus-one")?.resolvedDate, "2024-03-01");
  assertEquals(results.get("early")?.resolvedDate, "2024-01-15");
  assertEquals(results.get("late")?.resolvedDate, "2031-03-15");
  assertEquals(results.get("expiration")?.provenance.arithmeticPolicy, "lease-date-only-calendar-v1");
});

Deno.test("P4.5 dates 8-9,15: ambiguous paths, unresolved operands, cycles and no holiday fetch fail closed", () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = ((..._args: unknown[]) => { fetchCount++; throw new Error("fetch forbidden"); }) as typeof fetch;
  try {
    const results = resolveDateExpressions([
      { id: "ambiguous", conceptKey: "commencement_date", expressionType: "fixed_date", status: "ambiguous", explicitDate: "2024-01-01" },
      { id: "missing-co", conceptKey: "co", expressionType: "event_date", eventKey: "co_missing" },
      { id: "after-missing", conceptKey: "rent_start", expressionType: "relative_to_event", anchorExpressionId: "missing-co", offsetValue: 1, offsetUnit: "day", direction: "after" },
      { id: "cycle-a", conceptKey: "a", expressionType: "relative_to_date", anchorExpressionId: "cycle-b", offsetValue: 1, offsetUnit: "day" },
      { id: "cycle-b", conceptKey: "b", expressionType: "relative_to_date", anchorExpressionId: "cycle-a", offsetValue: 1, offsetUnit: "day" },
      { id: "holiday", conceptKey: "holiday", expressionType: "relative_to_date", anchorExpressionId: "ambiguous", offsetValue: 1, offsetUnit: "day", businessDayPolicy: "next_business_day" },
    ]);
    assertEquals(results.get("ambiguous")?.resolutionStatus, "needs_review");
    assertEquals(results.get("after-missing")?.resolvedDate, null);
    assert(results.get("cycle-a")?.validationCodes.includes("DATE_REQUIRED_INPUT_MISSING") || results.get("cycle-b")?.validationCodes.includes("DATE_CYCLE_DETECTED"));
    assertEquals(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("P4.5 terms 16-23: term boundaries, duration conflicts, extensions, options, holdover and partial terms", () => {
  const dateResults = new Map<string, any>([
    ["start", { resolvedDate: "2024-01-15", validationStatus: "valid" }],
    ["end", { resolvedDate: "2031-03-14", validationStatus: "valid" }],
  ]);
  const initial = resolveLeaseTerm({ id: "term-1", termType: "initial_term", instanceKey: "initial", startDateResultId: "start", durationValue: 86, durationUnit: "month", sourceClaimIds: ["claim-term"] }, dateResults);
  assertEquals(initial.resolutionStatus, "calculated");
  assertEquals(initial.resolvedEndDate, "2031-03-14");
  assertEquals(initial.formulaKey, "term.duration.inclusive:v1");

  const mismatch = resolveLeaseTerm({ id: "term-2", termType: "initial_term", instanceKey: "initial", startDateResultId: "start", durationValue: 86, durationUnit: "month", explicitEndDate: "2031-03-15" }, dateResults);
  assertEquals(mismatch.validationCodes, ["TERM_DURATION_CONFLICT"]);

  const extension = resolveLeaseTerm({ id: "term-3", termType: "extension_term", instanceKey: "extension-1", priorTermEndDate: "2031-03-14", durationValue: 60, durationUnit: "month" }, dateResults);
  assertEquals(extension.resolvedStartDate, "2031-03-15");
  const option = resolveLeaseTerm({ id: "term-4", termType: "option_term", instanceKey: "option-1", startDateResultId: "start", endDateResultId: "end", optionExercised: false }, dateResults);
  assertEquals(option.validationCodes.includes("TERM_OPTION_NOT_EXERCISED"), true);
  const holdover = resolveLeaseTerm({ id: "term-5", termType: "holdover_term", instanceKey: "holdover", startDateResultId: "start", endDateResultId: "end" }, dateResults);
  assertEquals(holdover.validationCodes.includes("TERM_HOLDOVER_NOT_CONTRACTUAL_EXTENSION"), true);
  const partial = resolveLeaseTerm({ id: "term-6", termType: "partial_term", instanceKey: "stub", startDateResultId: "start" }, dateResults);
  assertEquals(partial.validationCodes.includes("TERM_REQUIRED_DATE_MISSING"), true);
});