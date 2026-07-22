import { assertStringIncludes, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildIcsCalendar, calendarSyncPlan } from "../_shared/integrations/calendar-sync.ts";

Deno.test("Release 9 calendar sync builds read-only ICS from critical dates", () => {
  const events = [{ eventId: "e1", eventType: "expiration", label: "Lease Expiration", eventDate: "2030-12-31", calculationStatus: "resolved" }];
  assertEquals(calendarSyncPlan(events)[0].providerAction, "publish_read_only");
  assertStringIncludes(buildIcsCalendar({ calendarName: "Dates", events }), "BEGIN:VCALENDAR");
});
