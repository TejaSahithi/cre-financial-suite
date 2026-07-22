import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { rotateCredential } from "../_shared/enterprise-control/credential-rotation.ts";
import { credentialHealthSummary } from "../_shared/enterprise-control/credential-health.ts";

Deno.test("Release 10 credential rotation changes fingerprint without losing state", () => {
  const result = rotateCredential({ fingerprint: "old" }, { fingerprint: "new" }, "2026-07-22T00:00:00.000Z");
  assertEquals(result.rotated, true);
  assertEquals(result.previousFingerprint, "old");
  assertEquals(result.activeFingerprint, "new");
});

Deno.test("Release 10 credential health alerts on expiring credentials", () => {
  const result = credentialHealthSummary([{ fingerprint: "a", expiresAt: "2026-07-25T00:00:00.000Z" }], new Date("2026-07-22T00:00:00.000Z"));
  assertEquals(result.healthy, false);
  assertEquals(result.states, ["expiring"]);
});