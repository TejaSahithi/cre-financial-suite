import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildCalculationInputHash, planFinancialCalculationRun, runPureFinancialCalculation } from "../_shared/extraction/lease-financial-schedule/calculation/calculation-service.ts";
import { validateAuthoritativeInputs, rejectExternalCalculationInput } from "../_shared/extraction/lease-financial-schedule/calculation/financial-validator.ts";

Deno.test("P4.5 integrated 62-70: input hash is row-order independent and generation/org/package fences block stale inputs", () => {
  const a = { context: { orgId: "org", packageId: "pkg", generationId: "gen" }, dateExpressions: [{ id: "b" }, { id: "a" }] };
  const b = { dateExpressions: [{ id: "a" }, { id: "b" }], context: { generationId: "gen", packageId: "pkg", orgId: "org" } };
  assertEquals(buildCalculationInputHash(a), buildCalculationInputHash(b));
  const validation = validateAuthoritativeInputs({ orgId: "org", packageId: "pkg", leaseId: "lease", extractionRunId: "run", generationId: "gen", activeGenerationId: "gen" }, [
    { id: "ok", orgId: "org", packageId: "pkg", leaseId: "lease", generationId: "gen", status: "asserted" },
    { id: "stale", orgId: "org", packageId: "pkg", leaseId: "lease", generationId: "old", status: "asserted" },
    { id: "foreign", orgId: "other", packageId: "pkg", leaseId: "lease", generationId: "gen", status: "asserted" },
  ]);
  assertEquals(validation.validationStatus, "needs_review");
  assertEquals(validation.validationCodes.includes("CALC_INPUT_GENERATION_MISMATCH"), true);
  assertEquals(validation.validationCodes.includes("CALC_INPUT_CROSS_ORG"), true);
});

Deno.test("P4.5 integrated 60-67: pure run records versions, assumptions, statuses, validation codes and source inputs", () => {
  const output = runPureFinancialCalculation({
    context: { orgId: "org", packageId: "pkg", generationId: "gen", extractionRunId: "run", mode: "off" },
    dateExpressions: [
      { id: "start", conceptKey: "commencement", expressionType: "fixed_date", explicitDate: "2024-01-15", sourceClaimIds: ["claim-start"] },
      { id: "end", conceptKey: "expiration", expressionType: "relative_to_date", anchorExpressionId: "start", offsetValue: 86, offsetUnit: "month", direction: "after", sourceClaimIds: ["claim-term"] },
      { id: "conflict", conceptKey: "ambiguous", expressionType: "fixed_date", status: "ambiguous", explicitDate: "2024-01-01", sourceClaimIds: ["claim-conflict"] },
    ],
    terms: [{ id: "term", termType: "initial_term", instanceKey: "initial", startDateResultId: "start", durationValue: 86, durationUnit: "month", sourceClaimIds: ["claim-term"] }],
  });
  assertEquals(output.run.calculationVersion, "lease-financial-calculation-v1");
  assertEquals(output.run.dateEngineVersion, "lease-date-resolution-engine-v1");
  assertEquals(output.run.mode, "off");
  assertEquals(output.run.status, "needs_review");
  assertEquals(output.dateResults.find((result) => result.dateExpressionId === "start")?.sourceClaimIds, ["claim-start"]);
  assertEquals(output.dateResults.find((result) => result.dateExpressionId === "end")?.provenance.sourceInputIds, ["start"]);
  assertEquals(output.conflicts.length > 0, true);
});

Deno.test("P4.5 integrated 80-90: no external/runtime scope leakage inputs are accepted as calculation inputs", () => {
  assertEquals(rejectExternalCalculationInput({ cpiFetchUrl: "https://example.invalid", salesFetchUrl: "https://example.invalid", providerUrl: "https://example.invalid", externalIndexFetch: true }), [
    "CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:cpiFetchUrl",
    "CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:salesFetchUrl",
    "CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:providerUrl",
    "CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:externalIndexFetch",
  ]);
  assertEquals(rejectExternalCalculationInput({ camAllocation: {}, recoverabilityResult: {}, expenseRules: [] }), [
    "CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:camAllocation",
    "CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:recoverabilityResult",
    "CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:expenseRules",
  ]);
});

Deno.test("P4.5 mode off 90: planning is pure and creates no runtime write description", () => {
  const plan = planFinancialCalculationRun({ context: { mode: "off", orgId: "org", generationId: "gen" }, dateExpressions: [{ id: "a" }], terms: [], charges: [], rentSchedules: [] });
  assertEquals(plan.mode, "off");
  assertEquals(plan.status, "running");
  assertEquals("runtimeCallSite" in plan, false);
  assertEquals("compatibilityOutput" in plan, false);
});