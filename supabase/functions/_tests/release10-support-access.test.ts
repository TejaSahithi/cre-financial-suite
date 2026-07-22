import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { approveSupportAccess, isSupportAccessActive } from "../_shared/enterprise-control/support-policy.ts";

Deno.test("Release 10 support access requires independent approval and expires", () => {
  const approved = approveSupportAccess({ operatorId: "support-1", reason: "debug ticket", ticketReference: "T-1" }, { approverId: "lead-1", expiresAt: "2026-07-22T00:00:00.000Z", allowedActions: ["audit.read"] });
  assertEquals(approved.status, "approved");
  assertEquals(isSupportAccessActive(approved, new Date("2026-07-23T00:00:00.000Z")), false);
});