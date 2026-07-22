import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeRentSchedule } from "../_shared/portfolio-intelligence/rent-schedule-normalizer.ts";
import { applyRentEscalation } from "../_shared/portfolio-intelligence/rent-escalation-engine.ts";
import { validateRentSchedule } from "../_shared/portfolio-intelligence/rent-schedule-validator.ts";

Deno.test("Release 8 rent schedule normalizes fixed steps and abatements", () => {
  const periods = normalizeRentSchedule({ leasedArea: 1000, periods: [{ startDate: "2030-01-01", endDate: "2030-12-31", amount: 10000, currency: "USD", frequency: "monthly" }, { startDate: "2031-01-01", amount: 0, currency: "USD", frequency: "monthly", sourceFieldKeys: ["free_rent"] }] });
  assertEquals(periods[0].amountPerArea, 10);
  assertEquals(periods[1].amount, 0);
});

Deno.test("Release 8 rent escalation does not calculate CPI without approved input", () => {
  const period = applyRentEscalation({ amount: 100 }, { type: "cpi" });
  assertEquals(period.status, "requires_assumption");
  assertEquals(period.amount, null);
});

Deno.test("Release 8 rent schedule validator detects overlap and gap", () => {
  const result = validateRentSchedule([{ startDate: "2030-01-01", endDate: "2030-01-31" }, { startDate: "2030-01-31", endDate: "2030-02-28" }, { startDate: "2030-03-05" }]);
  assert(!result.valid);
  assert(result.warnings.includes("overlapping_periods"));
});
