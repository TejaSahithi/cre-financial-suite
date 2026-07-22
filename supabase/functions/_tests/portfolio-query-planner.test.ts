import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planPortfolioQuery } from "../_shared/portfolio-intelligence/portfolio-query-planner.ts";
import { validatePortfolioSearchPlan } from "../_shared/portfolio-intelligence/portfolio-query-validator.ts";

Deno.test("Release 8 portfolio query planner translates structured expiration query", () => {
  const { plan, errors } = planPortfolioQuery({ query: "leases expiring in the next 18 months", today: "2030-01-01" });
  assertEquals(errors, []);
  assertEquals(plan!.entity, "critical_date");
  assertEquals(plan!.filters[0].operator, "between");
});

Deno.test("Release 8 portfolio query validator rejects unsupported fields, operators, and unbounded limits", () => {
  const result = validatePortfolioSearchPlan({ entity: "lease", filters: [{ field: "raw_sql", operator: "drop", value: "select *;" }], sort: [], limit: 5000 });
  assertEquals(result.valid, false);
  assertEquals(result.errors.includes("unsupported_field:raw_sql"), true);
  assertEquals(result.errors.includes("unsupported_operator:drop"), true);
  assertEquals(result.errors.includes("unbounded_result_set"), true);
});
