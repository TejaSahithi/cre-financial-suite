import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildEnterpriseAuditEvent } from "../_shared/enterprise-control/compliance-evidence.ts";
import { failClosedWhenAuditUnavailable } from "../_shared/enterprise-control/authorization-policy.ts";

Deno.test("Release 10 audit events sanitize sensitive metadata", () => {
  const event = buildEnterpriseAuditEvent({ id: "a1", organizationId: "org-1", actorType: "user", actorId: "u1", action: "lease.approve", resourceType: "lease", outcome: "success", reasonCodes: [], metadata: { leaseText: "secret", safe: "ok", token: "hidden" }, occurredAt: "2026-07-22T00:00:00.000Z" });
  assertEquals(event.metadata, { safe: "ok" });
});

Deno.test("Release 10 privileged writes fail closed when audit persistence is unavailable", () => {
  const decision = failClosedWhenAuditUnavailable({ action: "lease.approve", auditAvailable: false });
  assertEquals(decision.allowed, false);
  assertEquals(decision.reasonCodes, ["audit_unavailable_fail_closed"]);
});