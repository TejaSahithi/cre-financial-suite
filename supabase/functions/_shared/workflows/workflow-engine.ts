// @ts-nocheck

import { WORKFLOW_SCHEMA_VERSION, getWorkflowDefinition, workflowForEvent } from "./workflow-definitions.ts";

function addHours(value: string, hours: number) {
  const date = new Date(value);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

export function startWorkflowInstance(args: { organizationId: string; workflowKey: string; aggregateId: string; aggregateType: string; triggerEventId?: string | null; context?: any; now?: string }) {
  const definition = getWorkflowDefinition(args.workflowKey);
  if (!definition) throw new Error(`unsupported_workflow:${args.workflowKey}`);
  const now = args.now ?? new Date(0).toISOString();
  return {
    organizationId: args.organizationId,
    workflowKey: args.workflowKey,
    triggerEventId: args.triggerEventId ?? null,
    aggregateId: args.aggregateId,
    aggregateType: args.aggregateType,
    workflowStatus: "active",
    currentStepKey: definition.tasks[0]?.taskKey ?? null,
    context: args.context ?? {},
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    startedAt: now,
    completedAt: null,
    tasks: definition.tasks.map((task: any, index: number) => ({
      taskKey: task.taskKey,
      taskLabel: task.taskLabel,
      assignmentType: task.assignmentType,
      assigneeKey: task.assigneeKey,
      taskState: index === 0 ? "assigned" : "pending",
      dueAt: addHours(now, task.slaHours ?? 24),
      escalationAt: addHours(now, Math.max(1, Math.floor((task.slaHours ?? 24) * 0.8))),
      taskPayload: { workflowKey: args.workflowKey, aggregateId: args.aggregateId },
    })),
  };
}

export function startWorkflowsForEvent(event: any) {
  return workflowForEvent(event.eventKey).map((workflowKey) => startWorkflowInstance({ organizationId: event.organizationId, workflowKey, aggregateId: event.aggregateId, aggregateType: event.aggregateType, triggerEventId: event.eventId, context: { eventKey: event.eventKey }, now: event.occurredAt }));
}

export function completeWorkflowTask(instance: any, taskKey: string, actorId: string, now = new Date(0).toISOString()) {
  const tasks = (instance.tasks ?? []).map((task: any) => task.taskKey === taskKey ? { ...task, taskState: "completed", completedBy: actorId, completedAt: now } : task);
  const next = tasks.find((task: any) => task.taskState === "pending");
  const updatedTasks = next ? tasks.map((task: any) => task.taskKey === next.taskKey ? { ...task, taskState: "assigned" } : task) : tasks;
  return { ...instance, tasks: updatedTasks, currentStepKey: next?.taskKey ?? null, workflowStatus: next ? "active" : "completed", completedAt: next ? null : now };
}
