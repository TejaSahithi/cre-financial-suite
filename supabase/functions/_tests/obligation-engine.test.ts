import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateObligationOccurrences } from "../_shared/obligations/obligation-engine.ts";

Deno.test("obligation engine generates stable monthly occurrences", () => {
  const occurrences = generateObligationOccurrences({
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
  });

  assertEquals(occurrences.length, 3);
  assertEquals(occurrences[0].due_date, "2026-02-10");
  assertEquals(occurrences[0].status, "overdue");
  assertEquals(occurrences[0].idempotency_key, "obligation-1:2026-01-01:2026-02-10");
  assertEquals(occurrences[2].status, "open");
});

Deno.test("obligation engine skips inactive obligations", () => {
  const occurrences = generateObligationOccurrences({
    windowStart: "2026-01-01",
    windowEnd: "2026-12-31",
    obligation: {
      id: "obligation-1",
      org_id: "org-1",
      obligation_type: "coi_renewal",
      status: "paused",
    },
  });

  assertEquals(occurrences, []);
});
