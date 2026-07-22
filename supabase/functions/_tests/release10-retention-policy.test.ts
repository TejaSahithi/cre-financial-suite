import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateRetention } from "../_shared/enterprise-control/retention-policy.ts";

Deno.test("Release 10 retention allows deletion only after policy window", () => {
  const decision = evaluateRetention({ retentionDays: 30, minimumComplianceDays: 10 }, { createdAt: "2026-06-01T00:00:00.000Z" }, new Date("2026-07-22T00:00:00.000Z"));
  assertEquals(decision.deletable, true);
});