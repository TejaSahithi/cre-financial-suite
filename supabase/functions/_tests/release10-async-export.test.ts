import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { asyncExportDecision } from "../_shared/enterprise-control/async-export-policy.ts";

Deno.test("Release 10 enterprise exports require async encryption and expiration", () => {
  const decision = asyncExportDecision({ rowCount: 10, estimatedBytes: 1000, encryptionRequested: false }, { maxRows: 100, maxBytes: 5000 });
  assertEquals(decision.accepted, false);
  assertEquals(decision.reasonCodes.includes("export_encryption_required"), true);
});