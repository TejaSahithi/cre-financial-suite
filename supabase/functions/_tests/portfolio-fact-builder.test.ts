import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPortfolioLeaseFact } from "../_shared/portfolio-intelligence/portfolio-fact-builder.ts";

Deno.test("Release 8 portfolio fact builder prefers reviewer override and preserves lineage", () => {
  const fact = buildPortfolioLeaseFact({
    organizationId: "org-1",
    documentFamilyId: "fam-1",
    generationId: "gen-1",
    reviewerValues: { expiration_date: { value: "2031-12-31", status: "overridden", projectionId: "p-review", evidenceIds: ["ev-review"] } },
    familyEffectiveValues: { expiration_date: { value: "2030-12-31", status: "resolved", projectionId: "p-family", evidenceIds: ["ev-family"] }, tenant_name: { value: "Acme", status: "resolved", projectionId: "p-tenant", evidenceIds: ["ev-tenant"] } },
  });
  assertEquals(fact.fields.expiration_date.normalizedValue, "2031-12-31");
  assertEquals(fact.fields.expiration_date.sourceLayer, "reviewer_override");
  assertEquals(fact.lineage.reviewerOverrideFieldKeys, ["expiration_date"]);
  assert(fact.lineage.familyEffectiveFieldKeys.includes("tenant_name"));
});

Deno.test("Release 8 portfolio fact builder preserves missing statuses separately", () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org-1", documentFamilyId: "fam-2", generationId: "gen-1", familyEffectiveValues: { tenant_name: { value: "Beta", status: "resolved", evidenceIds: ["ev"] } } });
  assertEquals(fact.fields.premises_identifier.status, "not_found");
  assertEquals(fact.fields.premises_identifier.sourceLayer, "none");
  assert(fact.lineage.missingFieldKeys.includes("premises_identifier"));
  assert(fact.findings.some((finding) => finding.findingKey === "missing:premises_identifier"));
});

Deno.test("Release 8 portfolio fact builder labels legacy fallback", () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org-1", documentFamilyId: "fam-3", generationId: "gen-1", legacyValues: { tenant_name: "Legacy Tenant", expiration_date: "2030-01-01", premises_identifier: "Suite 1" } });
  assertEquals(fact.fields.tenant_name.sourceLayer, "legacy_fallback");
  assert(fact.findings.some((finding) => finding.reasonCodes.includes("legacy_fallback")));
});
