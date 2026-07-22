import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildConnectorPayload, sanitizeConnectorTelemetry } from "../_shared/integrations/connector-adapters.ts";
import { projectContract } from "../_shared/integrations/integration-contracts.ts";

Deno.test("Release 9 connector framework projects stable contracts", () => {
  const contract = projectContract("lease-fact-v1", { leaseId: "l1", documentFamilyId: "f1", tenantName: "Acme", extra: "hidden" });
  assertEquals(contract.extra, undefined);
  const payload = buildConnectorPayload({ connectorKey: "netsuite", contractVersion: "lease-fact-v1", payload: contract });
  assertEquals(payload.writeBackAllowed, false);
});

Deno.test("Release 9 connector framework rejects unsupported connector contracts", () => {
  assertThrows(() => buildConnectorPayload({ connectorKey: "maximo", contractVersion: "lease-fact-v1", payload: {} }), Error, "unsupported_contract_for_connector");
});

Deno.test("Release 9 connector telemetry excludes sensitive values", () => {
  const telemetry = sanitizeConnectorTelemetry({ connectorKey: "sap", status: "enabled", tenantName: "Secret", rentValue: 100, successCount: 2 });
  assertEquals("tenantName" in telemetry, false);
  assertEquals(telemetry.successCount, 2);
});
