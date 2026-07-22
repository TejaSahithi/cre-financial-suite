import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateDrExercise, degradedModeDecision } from "../_shared/enterprise-control/disaster-recovery.ts";

Deno.test("Release 10 DR exercise validates RPO RTO and audit continuity", () => {
  const result = evaluateDrExercise({ tier: "tier0", observedRpoMinutes: 4, observedRtoMinutes: 50, auditContinuityPreserved: true });
  assertEquals(result.passed, true);
});

Deno.test("Release 10 Tier 0 degraded mode fails closed", () => {
  const result = degradedModeDecision("tier0", { unavailable: true });
  assertEquals(result.mode, "fail_closed");
});