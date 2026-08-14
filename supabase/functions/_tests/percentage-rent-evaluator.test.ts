import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluatePercentageRent } from "../_shared/percentage-rent/percentage-rent-evaluator.ts";

Deno.test("percentage rent calculates only sales above approved breakpoint", () => {
  const result = evaluatePercentageRent({
    asOfDate: "2026-06-30",
    term: {
      lease_id: "lease-1",
      status: "approved",
      percentage_rate: 6,
      breakpoint_amount: 100000,
      effective_start: "2026-01-01",
      effective_end: "2026-12-31",
    },
    salesReport: {
      lease_id: "lease-1",
      status: "approved",
      period_start: "2026-06-01",
      period_end: "2026-06-30",
      gross_sales_amount: 140000,
      exclusions_amount: 10000,
    },
  });

  assertEquals(result.status, "calculated");
  assertEquals(result.amount, 1800);
  assertEquals(result.inputs.excessSales, 30000);
});

Deno.test("percentage rent is zero when sales do not exceed breakpoint", () => {
  const result = evaluatePercentageRent({
    term: { lease_id: "lease-1", status: "approved", percentage_rate: 5, breakpoint_amount: 50000 },
    salesReport: {
      lease_id: "lease-1",
      status: "approved",
      period_start: "2026-07-01",
      period_end: "2026-07-31",
      net_reportable_sales: 42000,
    },
  });

  assertEquals(result.status, "calculated");
  assertEquals(result.amount, 0);
  assertEquals(result.inputs.excessSales, 0);
});

Deno.test("percentage rent blocks unapproved sales reports", () => {
  const result = evaluatePercentageRent({
    term: { lease_id: "lease-1", status: "approved", percentage_rate: 5, breakpoint_amount: 50000 },
    salesReport: {
      lease_id: "lease-1",
      status: "submitted",
      period_start: "2026-07-01",
      period_end: "2026-07-31",
      net_reportable_sales: 75000,
    },
  });

  assertEquals(result.status, "blocked");
  assertEquals(result.reasonCodes, ["SALES_REPORT_NOT_APPROVED"]);
});
