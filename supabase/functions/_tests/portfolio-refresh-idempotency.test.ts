import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { portfolioRefreshIdempotencyKey, planPortfolioRefresh } from "../_shared/portfolio-intelligence/portfolio-intelligence-refresh.ts";

Deno.test("Release 8 portfolio refresh idempotency key is generation safe", () => {
  const a = portfolioRefreshIdempotencyKey({ organizationId: "org", documentFamilyId: "fam", sourceGenerationId: "gen-1" });
  const b = portfolioRefreshIdempotencyKey({ organizationId: "org", documentFamilyId: "fam", sourceGenerationId: "gen-1" });
  const c = portfolioRefreshIdempotencyKey({ organizationId: "org", documentFamilyId: "fam", sourceGenerationId: "gen-2" });
  assertEquals(a, b);
  assertEquals(a === c, false);
});

Deno.test("Release 8 portfolio refresh plans incremental family rebuild", () => {
  const plan = planPortfolioRefresh({ changeType: "reviewer_override", organizationId: "org", documentFamilyId: "fam" });
  assertEquals(plan.scope, "document_family");
  assertEquals(plan.affectedDocumentFamilyIds, ["fam"]);
});
