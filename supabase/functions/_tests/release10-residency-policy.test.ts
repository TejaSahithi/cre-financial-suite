import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enforceResidency } from "../_shared/enterprise-control/residency-policy.ts";

Deno.test("Release 10 residency rejects prohibited cross-region processing", () => {
  const decision = enforceResidency({ allowedProcessingRegions: ["eastus"], allowedStorageRegions: ["eastus"], crossRegionBackupAllowed: false, crossRegionFailoverAllowed: false }, { kind: "processing", region: "westus" });
  assertEquals(decision.allowed, false);
  assertEquals(decision.reasonCodes, ["processing_region_not_allowed"]);
});