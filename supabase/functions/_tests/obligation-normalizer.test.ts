import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPortfolioLeaseFact } from "../_shared/portfolio-intelligence/portfolio-fact-builder.ts";
import { normalizeObligations } from "../_shared/portfolio-intelligence/obligation-normalizer.ts";
import { buildObligationSchedule } from "../_shared/portfolio-intelligence/obligation-schedule-builder.ts";

Deno.test("Release 8 obligation normalizer supports recurring relative obligations without fabricating dates", () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org-1", documentFamilyId: "fam-1", generationId: "gen-1", familyEffectiveValues: { tenant_name: "Acme", expiration_date: "2030-12-31", insurance_requirement: { value: { required: true }, status: "resolved", evidenceIds: ["ev-ins"] } } });
  const obligations = normalizeObligations({ fact, clauses: [{ id: "c1", text: "Tenant must deliver sales report annually 30 days before fiscal year end." }] });
  assertEquals(obligations.some((item) => item.obligationType === "sales_report" && item.status === "missing_anchor"), true);
  assertEquals(obligations.some((item) => item.obligationType === "insurance_certificate"), true);
});

Deno.test("Release 8 obligation schedule resolves relative deadline when anchor exists", () => {
  const scheduled = buildObligationSchedule({ dueRule: { relation: "before", anchor: "policy_expiration", offsetDays: 30 } }, { policy_expiration: "2030-12-31" });
  assertEquals(scheduled.status, "resolved");
  assertEquals(scheduled.nextDueDate, "2030-12-01");
});
