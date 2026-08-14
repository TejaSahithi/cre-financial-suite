export const TERMINAL_OCCURRENCE_STATUSES = new Set([
  "completed",
  "dismissed",
  "resolved",
  "satisfied",
  "waived",
  "cancelled",
  "canceled",
]);

export const DEFAULT_REMINDER_MILESTONES = [30, 14, 7, 1, 0, -1, -7, -14, -30];

export function daysUntilDue(dueDate: string, asOfDate: string): number | null {
  const due = new Date(`${String(dueDate || "").slice(0, 10)}T00:00:00Z`);
  const asOf = new Date(`${String(asOfDate || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due.getTime()) || Number.isNaN(asOf.getTime())) return null;
  return Math.round((due.getTime() - asOf.getTime()) / 86400000);
}

export function normalizeReminderMilestones(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : DEFAULT_REMINDER_MILESTONES;
  const parsed = raw
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item <= 365 && item >= -365);
  return [...new Set(parsed)].sort((a, b) => b - a);
}

export function occurrenceIsTerminal(status: unknown): boolean {
  return TERMINAL_OCCURRENCE_STATUSES.has(String(status || "").trim().toLowerCase());
}

export function occurrenceCanNotify(occurrence: Record<string, unknown>): boolean {
  if (!occurrence || occurrenceIsTerminal(occurrence.status)) return false;
  const status = String(occurrence.status || "open").trim().toLowerCase();
  return ["open", "overdue", "active", "pending_review"].includes(status);
}

export function reminderMilestoneForOccurrence(
  occurrence: Record<string, unknown>,
  asOfDate: string,
  milestones: unknown = DEFAULT_REMINDER_MILESTONES,
) {
  if (!occurrenceCanNotify(occurrence)) return null;
  const days = daysUntilDue(String(occurrence.due_date || ""), asOfDate);
  if (days == null) return null;
  const allowed = normalizeReminderMilestones(milestones);
  if (!allowed.includes(days)) return null;
  if (days < 0) return { days, eventType: "obligation.overdue", milestone: `${days}d` };
  if (days === 0) return { days, eventType: "obligation.due_today", milestone: "0d" };
  return { days, eventType: "obligation.due_soon", milestone: `${days}d` };
}

export function obligationNotificationIdempotencyKey(input: {
  orgId: string;
  occurrenceId: string;
  eventType: string;
  milestone: string;
}) {
  return [
    "lease_obligation_occurrence",
    input.orgId,
    input.occurrenceId,
    input.eventType,
    input.milestone,
  ].join(":");
}

export function recipientIdempotencyKey(recipient: Record<string, unknown>) {
  if (recipient.userId) return `user:${recipient.userId}`;
  if (recipient.id) return `external:${recipient.externalType || "contact"}:${recipient.id}`;
  if (recipient.email) return `external:${recipient.externalType || "contact"}:${recipient.email}`;
  return "broadcast";
}

export function deliveryIdempotencyKey(input: {
  notificationId: string;
  channel: string;
  destination?: string | null;
}) {
  return [
    "notification_delivery",
    input.notificationId,
    input.channel,
    String(input.destination || "none").toLowerCase(),
  ].join(":");
}
