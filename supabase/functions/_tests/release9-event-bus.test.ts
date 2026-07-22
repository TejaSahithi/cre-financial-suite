import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildIntegrationEvent } from "../_shared/events/event-bus.ts";
import { appendOnlyEventGuard } from "../_shared/events/event-store.ts";
import { planEventReplay } from "../_shared/events/event-replay.ts";

Deno.test("Release 9 event bus builds deterministic immutable events", async () => {
  const event = await buildIntegrationEvent({ organizationId: "org", eventKey: "lease.approved", aggregateId: "lease-1", generationId: "gen-1", payload: { b: 2, a: 1 } });
  const same = await buildIntegrationEvent({ organizationId: "org", eventKey: "lease.approved", aggregateId: "lease-1", generationId: "gen-1", payload: { a: 1, b: 2 } });
  assertEquals(event.eventId, same.eventId);
  assertEquals(appendOnlyEventGuard(event, same).reason, "duplicate_event");
});

Deno.test("Release 9 event bus rejects unsupported events", async () => {
  await assertRejects(() => buildIntegrationEvent({ organizationId: "org", eventKey: "raw.sql", aggregateId: "x", payload: {} }), Error, "unsupported_event");
});

Deno.test("Release 9 event replay is ordered and cursor bounded", () => {
  const replay = planEventReplay({ events: [{ eventId: "b", eventKey: "lease.approved", occurredAt: "2030-01-02" }, { eventId: "a", eventKey: "lease.approved", occurredAt: "2030-01-01" }], limit: 1 });
  assertEquals(replay.events[0].eventId, "a");
  assertEquals(replay.cursor, "a");
});
