import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { completeWorkflowTask, startWorkflowInstance, startWorkflowsForEvent } from "../_shared/workflows/workflow-engine.ts";

Deno.test("Release 9 workflow engine starts configured workflow tasks", () => {
  const instance = startWorkflowInstance({ organizationId: "org", workflowKey: "lease_approval", aggregateId: "lease-1", aggregateType: "lease", now: "2030-01-01T00:00:00.000Z" });
  assertEquals(instance.tasks.length, 3);
  assertEquals(instance.tasks[0].taskState, "assigned");
  assertEquals(instance.workflowStatus, "active");
});

Deno.test("Release 9 workflow engine advances tasks to completion", () => {
  let instance = startWorkflowInstance({ organizationId: "org", workflowKey: "renewal_review", aggregateId: "date-1", aggregateType: "critical_date" });
  instance = completeWorkflowTask(instance, "renewal_notice_review", "user-1", "2030-01-01T01:00:00.000Z");
  assertEquals(instance.workflowStatus, "completed");
  assertEquals(instance.completedAt, "2030-01-01T01:00:00.000Z");
});

Deno.test("Release 9 workflow engine starts event-triggered workflows", () => {
  const instances = startWorkflowsForEvent({ organizationId: "org", eventKey: "rent-roll-variance.detected", aggregateId: "var-1", aggregateType: "variance", eventId: "event-1", occurredAt: "2030-01-01T00:00:00.000Z" });
  assertEquals(instances[0].workflowKey, "variance_investigation");
});
