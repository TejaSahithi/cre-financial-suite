import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPortfolioLeaseFact } from "../_shared/portfolio-intelligence/portfolio-fact-builder.ts";
import { buildPortfolioAnalyticsSnapshot } from "../_shared/portfolio-intelligence/portfolio-analytics-snapshot.ts";
import { buildPortfolioIntelligencePayloadV1 } from "../_shared/portfolio-intelligence/portfolio-payload-v1.ts";

Deno.test("Release 8 portfolio payload v1 discloses coverage and lineage diagnostics", async () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org", portfolioId: "portfolio", documentFamilyId: "fam", generationId: "gen", familyEffectiveValues: { tenant_name: "Acme", expiration_date: "2030-01-01", base_rent_current: { value: 100, evidenceIds: ["ev"] }, base_rent_frequency: "monthly", leased_area: 1000 } });
  const snapshot = await buildPortfolioAnalyticsSnapshot({ organizationId: "org", portfolioId: "portfolio", facts: [fact], snapshotDate: "2030-01-01" });
  const payload = buildPortfolioIntelligencePayloadV1({ organizationId: "org", portfolioId: "portfolio", snapshot });
  assertEquals(payload.schemaVersion, "portfolio-intelligence-payload-v1");
  assertEquals(payload.summary.exclusionsDisclosed, true);
  assertEquals(payload.coverage.totalLeaseFamilies, 1);
  assertEquals(payload.diagnostics.metricLineageCount, 1);
});
