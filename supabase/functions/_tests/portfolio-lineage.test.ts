import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPortfolioLeaseFact } from "../_shared/portfolio-intelligence/portfolio-fact-builder.ts";
import { buildMetricLineage } from "../_shared/portfolio-intelligence/portfolio-fact-lineage.ts";

Deno.test("Release 8 portfolio metric lineage exposes contributing and excluded facts", () => {
  const included = buildPortfolioLeaseFact({ organizationId: "org", documentFamilyId: "fam-1", generationId: "gen", familyEffectiveValues: { base_rent_current: { value: 100, projectionId: "proj-1" } } });
  const excluded = buildPortfolioLeaseFact({ organizationId: "org", documentFamilyId: "fam-2", generationId: "gen", familyEffectiveValues: {} });
  const lineage = buildMetricLineage({ metricKey: "annualized_base_rent", facts: [included], excludedFacts: [excluded], sourceFieldKeys: ["base_rent_current"], aggregationMethod: "sum" });
  assertEquals(lineage.contributingFactIds, ["fam-1"]);
  assertEquals(lineage.excludedFactIds, ["fam-2"]);
  assertEquals(lineage.sourceProjectionIds, ["proj-1"]);
});
