// @ts-nocheck

export const WORKFLOW_SCHEMA_VERSION = "workflow-instance-v1";

export const WORKFLOW_DEFINITIONS = {
  lease_approval: {
    triggerEvents: ["lease.reviewed"],
    tasks: [
      { taskKey: "legal_review", taskLabel: "Legal Review", assignmentType: "role", assigneeKey: "legal_reviewer", slaHours: 48 },
      { taskKey: "accounting_review", taskLabel: "Accounting Review", assignmentType: "role", assigneeKey: "accounting_reviewer", slaHours: 48 },
      { taskKey: "publish_lease_fact", taskLabel: "Publish Lease Fact", assignmentType: "queue", assigneeKey: "lease_publication", slaHours: 24 },
    ],
    completionEvent: "lease.approved",
  },
  portfolio_review: {
    triggerEvents: ["portfolio-snapshot.published", "risk.created"],
    tasks: [
      { taskKey: "portfolio_manager_review", taskLabel: "Portfolio Manager Review", assignmentType: "role", assigneeKey: "portfolio_manager", slaHours: 72 },
    ],
    completionEvent: "portfolio-fact.updated",
  },
  variance_investigation: {
    triggerEvents: ["rent-roll-variance.detected"],
    tasks: [
      { taskKey: "variance_triage", taskLabel: "Variance Triage", assignmentType: "queue", assigneeKey: "reconciliation", slaHours: 24 },
      { taskKey: "variance_resolution", taskLabel: "Variance Resolution", assignmentType: "role", assigneeKey: "accounting_reviewer", slaHours: 72 },
    ],
    completionEvent: "risk.resolved",
  },
  renewal_review: {
    triggerEvents: ["critical-date.created"],
    tasks: [
      { taskKey: "renewal_notice_review", taskLabel: "Renewal Notice Review", assignmentType: "role", assigneeKey: "leasing_manager", slaHours: 24 },
    ],
    completionEvent: "obligation.completed",
  },
};

export function getWorkflowDefinition(workflowKey: string) {
  return WORKFLOW_DEFINITIONS[workflowKey] ?? null;
}

export function workflowForEvent(eventKey: string) {
  return Object.entries(WORKFLOW_DEFINITIONS).filter(([, definition]) => definition.triggerEvents.includes(eventKey)).map(([key]) => key);
}
