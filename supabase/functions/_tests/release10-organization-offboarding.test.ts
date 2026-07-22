import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildOffboardingReport } from "../_shared/enterprise-control/organization-offboarding.ts";

Deno.test("Release 10 organization offboarding requires every controlled step", () => {
  const report = buildOffboardingReport({ organizationId: "org-1", completedSteps: ["disable_ingestion", "disable_integrations"] });
  assertEquals(report.complete, false);
  assertEquals(report.missingSteps.includes("revoke_credentials"), true);
});