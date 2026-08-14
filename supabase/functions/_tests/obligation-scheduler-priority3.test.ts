import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateObligationOccurrences } from "../_shared/obligations/obligation-engine.ts";
import {
  deliveryIdempotencyKey,
  obligationNotificationIdempotencyKey,
  occurrenceCanNotify,
  reminderMilestoneForOccurrence,
} from "../_shared/obligations/obligation-notifications.ts";

Deno.test("duplicate scheduler execution produces the same occurrence idempotency keys", () => {
  const input = {
    windowStart: "2026-01-01",
    windowEnd: "2026-03-31",
    asOfDate: "2026-02-15",
    obligation: {
      id: "obligation-1",
      org_id: "org-1",
      lease_id: "lease-1",
      property_id: "property-1",
      obligation_type: "sales_report",
      cadence: "monthly",
      due_rule: { offset_days: 10 },
      status: "active",
    },
  };

  const first = generateObligationOccurrences(input);
  const second = generateObligationOccurrences(input);
  assertEquals(first.map((row) => row.idempotency_key), second.map((row) => row.idempotency_key));
});

Deno.test("duplicate obligation notification attempts share one notification and delivery idempotency key", () => {
  const notificationKey = obligationNotificationIdempotencyKey({
    orgId: "org-1",
    occurrenceId: "occurrence-1",
    eventType: "obligation.due_soon",
    milestone: "7d",
  });
  const duplicateKey = obligationNotificationIdempotencyKey({
    orgId: "org-1",
    occurrenceId: "occurrence-1",
    eventType: "obligation.due_soon",
    milestone: "7d",
  });
  assertEquals(notificationKey, duplicateKey);
  assertEquals(
    deliveryIdempotencyKey({ notificationId: "notification-1", channel: "email", destination: "a@example.com" }),
    deliveryIdempotencyKey({ notificationId: "notification-1", channel: "email", destination: "A@EXAMPLE.COM" }),
  );
});

Deno.test("reminder milestones emit only configured due, today and overdue events", () => {
  const occurrence = { id: "occurrence-1", due_date: "2026-08-20", status: "open" };
  assertEquals(reminderMilestoneForOccurrence(occurrence, "2026-08-13", [14, 7, 1, 0, -1]), {
    days: 7,
    eventType: "obligation.due_soon",
    milestone: "7d",
  });
  assertEquals(reminderMilestoneForOccurrence(occurrence, "2026-08-20", [14, 7, 1, 0, -1]), {
    days: 0,
    eventType: "obligation.due_today",
    milestone: "0d",
  });
  assertEquals(reminderMilestoneForOccurrence(occurrence, "2026-08-21", [14, 7, 1, 0, -1]), {
    days: -1,
    eventType: "obligation.overdue",
    milestone: "-1d",
  });
  assertEquals(reminderMilestoneForOccurrence(occurrence, "2026-08-18", [14, 7, 1, 0, -1]), null);
});

Deno.test("satisfied waived and cancelled occurrences are not notifiable", () => {
  for (const status of ["satisfied", "waived", "cancelled", "canceled", "completed", "resolved"]) {
    const occurrence = { id: `occurrence-${status}`, due_date: "2026-08-20", status };
    assertEquals(occurrenceCanNotify(occurrence), false);
    assertEquals(reminderMilestoneForOccurrence(occurrence, "2026-08-20", [0]), null);
  }
});

Deno.test({
  name: "scheduler migration registers cron, status constraints, idempotency indexes and retry columns",
  permissions: { read: [new URL("../../migrations/20269900000076_obligation_scheduler_idempotency.sql", import.meta.url)] },
  async fn() {
    const sql = await Deno.readTextFile(new URL("../../migrations/20269900000076_obligation_scheduler_idempotency.sql", import.meta.url));
    assertStringIncludes(sql, "idx_notifications_org_idempotency_key");
    assertStringIncludes(sql, "idx_notification_deliveries_idempotency_key");
    assertStringIncludes(sql, "satisfied");
    assertStringIncludes(sql, "waived");
    assertStringIncludes(sql, "cancelled");
    assertStringIncludes(sql, "invoke_lease_obligation_occurrence_scheduler");
    assertStringIncludes(sql, "cron.schedule");
    assertStringIncludes(sql, "generate-obligation-occurrences");
  },
});

Deno.test({
  name: "dispatcher has separate delivery idempotency, failed retry handling and external delivery gate",
  permissions: { read: [new URL("../notification-dispatch-v9/index.ts", import.meta.url)] },
  async fn() {
    const source = await Deno.readTextFile(new URL("../notification-dispatch-v9/index.ts", import.meta.url));
    assertStringIncludes(source, "notificationIdempotencyKeyFor");
    assertStringIncludes(source, "sendDeliveryWithIdempotency");
    assertStringIncludes(source, "failed delivery retry disabled");
    assertStringIncludes(source, "external_delivery_allowed === false");
  },
});

