import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPortfolioLeaseFact } from "../_shared/portfolio-intelligence/portfolio-fact-builder.ts";
import { reconcileRentRoll } from "../_shared/portfolio-intelligence/rent-roll-reconciliation.ts";

Deno.test("Release 8 rent roll reconciliation classifies exact and material variance", () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org-1", documentFamilyId: "fam-1", generationId: "gen-1", leaseId: "lease-1", familyEffectiveValues: { tenant_name: "Acme", base_rent_current: { value: 1200, evidenceIds: ["ev"] }, expiration_date: "2030-01-01", premises_identifier: "Suite 1" } });
  const findings = reconcileRentRoll({ facts: [fact], rentRoll: [{ id: "rr-1", leaseId: "lease-1", tenant_name: "Acme", base_rent: 900, expiration_date: "2030-01-01", premises: "Suite 1" }], config: { amountTolerance: 1, percentageTolerance: 0.01 } });
  assertEquals(findings.some((finding) => finding.class === "material_variance" && finding.fieldKey === "base_rent_current"), true);
});

Deno.test("Release 8 rent roll reconciliation reports missing system record", () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org-1", documentFamilyId: "fam-2", generationId: "gen-1", familyEffectiveValues: { tenant_name: "Beta" } });
  assertEquals(reconcileRentRoll({ facts: [fact], rentRoll: [] })[0].class, "missing_in_rent_roll");
});
