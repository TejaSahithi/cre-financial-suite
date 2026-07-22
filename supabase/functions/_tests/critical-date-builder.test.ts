import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPortfolioLeaseFact } from "../_shared/portfolio-intelligence/portfolio-fact-builder.ts";
import { buildCriticalDates, filterCriticalDates } from "../_shared/portfolio-intelligence/critical-date-builder.ts";

Deno.test("Release 8 critical date builder creates renewal notice window and dedupes events", () => {
  const fact = buildPortfolioLeaseFact({ organizationId: "org-1", documentFamilyId: "fam-1", generationId: "gen-1", leaseId: "lease-1", familyEffectiveValues: { tenant_name: "Acme", expiration_date: { value: "2030-12-31", evidenceIds: ["ev-exp"] } } });
  const events = buildCriticalDates({ fact, noticeRules: [{ eventType: "renewal_notice_deadline", daysBefore: 180, windowDays: 30 }, { eventType: "renewal_notice_deadline", daysBefore: 180, windowDays: 30 }] });
  assertEquals(events.filter((event) => event.eventType === "renewal_notice_deadline").length, 1);
  const renewal = events.find((event) => event.eventType === "renewal_notice_deadline")!;
  assertEquals(renewal.eventDate, "2030-07-04");
  assertEquals(renewal.evidenceAvailable, true);
});

Deno.test("Release 8 critical date filter is deterministic and excludes estimated by default", () => {
  const events = [
    { eventType: "expiration", eventDate: "2030-01-02", documentFamilyId: "b", isEstimated: false, calculationStatus: "resolved" },
    { eventType: "expiration", eventDate: "2030-01-01", documentFamilyId: "a", isEstimated: true, calculationStatus: "resolved" },
  ];
  assertEquals(filterCriticalDates(events, { dateFrom: "2030-01-01", dateTo: "2030-12-31" }).map((event) => event.documentFamilyId), ["b"]);
});
