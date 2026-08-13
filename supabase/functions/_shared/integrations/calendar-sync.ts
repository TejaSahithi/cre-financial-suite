// @ts-nocheck

function escapeIcs(value: unknown) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toIcsDate(value: string) {
  return String(value ?? "").replace(/-/g, "");
}

export function buildIcsCalendar(args: { calendarName: string; events: any[] }) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ProForma OS//Release 9//EN", `X-WR-CALNAME:${escapeIcs(args.calendarName)}`];
  for (const event of args.events) {
    if (!event.eventDate && !event.windowEnd) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcs(event.eventId ?? event.id)}`);
    lines.push(`SUMMARY:${escapeIcs(event.label ?? event.eventType)}`);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(event.eventDate ?? event.windowEnd)}`);
    lines.push(`DESCRIPTION:${escapeIcs(`${event.eventType ?? "critical_date"} ${event.calculationStatus ?? "resolved"}`)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export function calendarSyncPlan(events: any[]) {
  return events.filter((event) => ["renewal_notice_deadline", "expiration", "insurance_renewal", "CAM_reconciliation", "termination_notice_deadline"].includes(event.eventType)).map((event) => ({ eventId: event.eventId ?? event.id, providerAction: "publish_read_only", eventType: event.eventType, eventDate: event.eventDate ?? event.windowEnd }));
}
