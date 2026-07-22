import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPortfolioLeaseFact } from "../_shared/portfolio-intelligence/portfolio-fact-builder.ts";
import { evaluatePortfolioRisks } from "../_shared/portfolio-intelligence/portfolio-risk-evaluator.ts";
import { summarizePortfolioRisk } from "../_shared/portfolio-intelligence/portfolio-risk-summary.ts";

Deno.test("Release 8 portfolio risk evaluator returns explainable score contributions", () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org-1", documentFamilyId: "fam-1", generationId: "gen-1", leaseId: "lease-1", familyEffectiveValues: { tenant_name: "Acme", expiration_date: "2030-03-01", base_rent_current: { value: 1000, status: "resolved", evidenceIds: [] } } });
  const risks = evaluatePortfolioRisks({ facts: [fact], today: "2030-01-01" });
  assert(risks.some((risk) => risk.ruleKey === "expiration_within_180_days"));
  assert(risks.every((risk) => typeof risk.scoreContribution === "number" && risk.explanation));
  assertEquals(summarizePortfolioRisk(risks).totalScore > 0, true);
});

Deno.test("Release 8 portfolio risk evaluator includes rent roll variance", () => {
  const risks = evaluatePortfolioRisks({ facts: [], rentRollFindings: [{ class: "material_variance", factId: "fam-1", fieldKey: "base_rent_current" }] });
  assertEquals(risks[0].ruleKey, "rent_roll_material_variance");
});
