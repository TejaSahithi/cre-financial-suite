// @ts-nocheck

export function planEventReplay(args: { events: any[]; eventKeys?: string[]; since?: string | null; limit?: number }) {
  const limit = Math.min(Number(args.limit ?? 100), 1000);
  const events = (args.events ?? [])
    .filter((event) => !args.eventKeys?.length || args.eventKeys.includes(event.eventKey ?? event.event_key))
    .filter((event) => !args.since || String(event.occurredAt ?? event.occurred_at) >= args.since)
    .sort((a, b) => String(a.occurredAt ?? a.occurred_at).localeCompare(String(b.occurredAt ?? b.occurred_at)))
    .slice(0, limit);
  return { events, replayCount: events.length, cursor: events.at(-1)?.eventId ?? events.at(-1)?.event_id ?? null };
}
