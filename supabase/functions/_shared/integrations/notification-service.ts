// @ts-nocheck

export const NOTIFICATION_TEMPLATES = {
  renewal_notice: { channels: ["email", "in_app"], title: "Renewal notice window" },
  critical_expiration: { channels: ["email", "in_app", "slack", "teams"], title: "Critical lease expiration" },
  review_assignment: { channels: ["email", "in_app"], title: "Review assignment" },
  workflow_escalation: { channels: ["email", "in_app", "slack", "teams"], title: "Workflow escalation" },
  risk_alert: { channels: ["email", "in_app", "webhook"], title: "Portfolio risk alert" },
  integration_failure: { channels: ["email", "in_app", "webhook"], title: "Integration failure" },
  export_complete: { channels: ["email", "in_app"], title: "Export complete" },
};

export function buildNotification(args: { organizationId: string; templateKey: string; channel: string; recipientType: string; recipientKey: string; payload: any; eventId?: string | null; workflowTaskId?: string | null; scheduledAt?: string }) {
  const template = NOTIFICATION_TEMPLATES[args.templateKey];
  if (!template) throw new Error(`unsupported_notification_template:${args.templateKey}`);
  if (!template.channels.includes(args.channel)) throw new Error(`unsupported_channel_for_template:${args.channel}`);
  return {
    organizationId: args.organizationId,
    eventId: args.eventId ?? null,
    workflowTaskId: args.workflowTaskId ?? null,
    channel: args.channel,
    templateKey: args.templateKey,
    recipientType: args.recipientType,
    recipientKey: args.recipientKey,
    notificationPayload: { title: template.title, ...args.payload },
    notificationStatus: "queued",
    scheduledAt: args.scheduledAt ?? new Date(0).toISOString(),
  };
}
