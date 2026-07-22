// @ts-nocheck

export function routeWorkflowTask(task: any, directory: any = {}) {
  if (task.assignmentType === "user") return { routeType: "user", assigneeId: task.assigneeId ?? null, assigneeKey: task.assigneeKey ?? null };
  if (task.assignmentType === "role") return { routeType: "role", assigneeIds: directory.roles?.[task.assigneeKey] ?? [], assigneeKey: task.assigneeKey };
  if (task.assignmentType === "team") return { routeType: "team", assigneeIds: directory.teams?.[task.assigneeKey] ?? [], assigneeKey: task.assigneeKey };
  return { routeType: "queue", queueKey: task.assigneeKey ?? "default" };
}

export function detectSlaBreaches(tasks: any[], now: string) {
  return tasks.filter((task) => !["completed", "cancelled"].includes(task.taskState) && task.dueAt && task.dueAt < now).map((task) => ({ taskKey: task.taskKey, reasonCode: "sla_breach", dueAt: task.dueAt }));
}
