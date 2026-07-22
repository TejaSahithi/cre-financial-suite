import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectSlaBreaches, routeWorkflowTask } from "../_shared/workflows/workflow-routing.ts";

Deno.test("Release 9 workflow routing supports role and queue assignments", () => {
  assertEquals(routeWorkflowTask({ assignmentType: "role", assigneeKey: "legal" }, { roles: { legal: ["u1"] } }).assigneeIds, ["u1"]);
  assertEquals(routeWorkflowTask({ assignmentType: "queue", assigneeKey: "reconciliation" }).queueKey, "reconciliation");
});

Deno.test("Release 9 workflow routing detects SLA breaches", () => {
  const breaches = detectSlaBreaches([{ taskKey: "t1", taskState: "assigned", dueAt: "2030-01-01T00:00:00.000Z" }], "2030-01-02T00:00:00.000Z");
  assertEquals(breaches[0].reasonCode, "sla_breach");
});
