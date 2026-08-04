// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3 unit
// tests for the pure time modules (date-math.ts, period-slicer.ts). Pure
// functions, no database required.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addDays,
  compareDates,
  daysInMonth,
  inclusiveDayCount,
  isLeapYear,
  maxDate,
  minDate,
  monthBounds,
  overlapRange,
} from "../_shared/cam-engine-v2/time/date-math.ts";
import {
  buildMonthlySlices,
  collectBoundaryDates,
  splitSegmentsAtBoundaries,
} from "../_shared/cam-engine-v2/time/period-slicer.ts";

// --- date-math.ts ---------------------------------------------------------

Deno.test("isLeapYear: 2024 and 2000 are leap years, 2023 and 1900 are not", () => {
  assertEquals(isLeapYear(2024), true);
  assertEquals(isLeapYear(2000), true);
  assertEquals(isLeapYear(2023), false);
  assertEquals(isLeapYear(1900), false);
});

Deno.test("daysInMonth: February is 29 days in a leap year, 28 otherwise", () => {
  assertEquals(daysInMonth(2024, 2), 29);
  assertEquals(daysInMonth(2023, 2), 28);
  assertEquals(daysInMonth(2024, 12), 31);
});

Deno.test("inclusiveDayCount: leap-year February counts 29 days, non-leap counts 28", () => {
  assertEquals(inclusiveDayCount("2024-02-01", "2024-02-29"), 29);
  assertEquals(inclusiveDayCount("2023-02-01", "2023-02-28"), 28);
  assertEquals(inclusiveDayCount("2024-01-01", "2024-12-31"), 366);
  assertEquals(inclusiveDayCount("2023-01-01", "2023-12-31"), 365);
});

Deno.test("inclusiveDayCount: same start and end is 1 day", () => {
  assertEquals(inclusiveDayCount("2026-06-15", "2026-06-15"), 1);
});

Deno.test("compareDates / maxDate / minDate", () => {
  assertEquals(compareDates("2026-01-01", "2026-06-01") < 0, true);
  assertEquals(compareDates("2026-06-01", "2026-01-01") > 0, true);
  assertEquals(compareDates("2026-06-01", "2026-06-01"), 0);
  assertEquals(maxDate("2026-01-01", "2026-06-01"), "2026-06-01");
  assertEquals(minDate("2026-01-01", "2026-06-01"), "2026-01-01");
});

Deno.test("addDays crosses month, year, and leap-day boundaries correctly", () => {
  assertEquals(addDays("2026-01-31", 1), "2026-02-01");
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
  assertEquals(addDays("2024-02-28", 1), "2024-02-29");
  assertEquals(addDays("2023-02-28", 1), "2023-03-01");
});

Deno.test("overlapRange: two bounded ranges that overlap", () => {
  const result = overlapRange("2026-01-01", "2026-06-30", "2026-04-01", "2026-12-31");
  assertEquals(result, { start: "2026-04-01", end: "2026-06-30", days: 91 });
});

Deno.test("overlapRange: two bounded ranges that do not overlap returns null", () => {
  assertEquals(overlapRange("2026-01-01", "2026-01-31", "2026-03-01", "2026-03-31"), null);
});

Deno.test("overlapRange: touching ranges (adjacent, not overlapping) return null", () => {
  assertEquals(overlapRange("2026-01-01", "2026-01-31", "2026-02-01", "2026-02-28"), null);
});

Deno.test("overlapRange: open-ended range (effective_to null) clipped by the other bounded range", () => {
  const result = overlapRange("2026-01-01", "2026-12-31", "2026-06-01", null);
  assertEquals(result, { start: "2026-06-01", end: "2026-12-31", days: 214 });
});

Deno.test("overlapRange: both ranges unbounded on the end returns null (finite window required)", () => {
  assertEquals(overlapRange("2026-01-01", null, "2026-06-01", null), null);
});

Deno.test("overlapRange: identical single-day ranges overlap for 1 day", () => {
  assertEquals(overlapRange("2026-06-15", "2026-06-15", "2026-06-15", "2026-06-15"), {
    start: "2026-06-15",
    end: "2026-06-15",
    days: 1,
  });
});

Deno.test("monthBounds returns correct first/last day including leap February", () => {
  assertEquals(monthBounds(2024, 2), { start: "2024-02-01", end: "2024-02-29" });
  assertEquals(monthBounds(2026, 4), { start: "2026-04-01", end: "2026-04-30" });
});

// --- period-slicer.ts ------------------------------------------------------

Deno.test("buildMonthlySlices: full calendar year produces 12 segments with correct leap-year day counts", () => {
  const segments = buildMonthlySlices("2024-01-01", "2024-12-31");
  assertEquals(segments.length, 12);
  assertEquals(segments[1], { start: "2024-02-01", end: "2024-02-29", monthIndex: 2 });
  assertEquals(inclusiveDayCount(segments[1].start, segments[1].end), 29);
});

Deno.test("buildMonthlySlices: non-leap year February segment is 28 days", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-12-31");
  assertEquals(segments[1], { start: "2026-02-01", end: "2026-02-28", monthIndex: 2 });
});

Deno.test("buildMonthlySlices: mid-year commencement clips the first segment", () => {
  const segments = buildMonthlySlices("2026-07-15", "2026-12-31");
  assertEquals(segments[0], { start: "2026-07-15", end: "2026-07-31", monthIndex: 1 });
  assertEquals(segments.length, 6);
});

Deno.test("buildMonthlySlices: mid-year expiration clips the last segment", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-09-10");
  assertEquals(segments.length, 9);
  assertEquals(segments[8], { start: "2026-09-01", end: "2026-09-10", monthIndex: 9 });
});

Deno.test("buildMonthlySlices: rejects an end date before the start date", () => {
  assertThrows(() => buildMonthlySlices("2026-06-01", "2026-01-01"), Error, "must not precede");
});

Deno.test("splitSegmentsAtBoundaries: mid-month amendment effective date splits the segment in two", () => {
  const segments = buildMonthlySlices("2026-06-01", "2026-06-30");
  const split = splitSegmentsAtBoundaries(segments, ["2026-06-16"]);
  assertEquals(split, [
    { start: "2026-06-01", end: "2026-06-15", monthIndex: 1 },
    { start: "2026-06-16", end: "2026-06-30", monthIndex: 1 },
  ]);
});

Deno.test("splitSegmentsAtBoundaries: boundary exactly at a segment's own start produces no split", () => {
  const segments = buildMonthlySlices("2026-06-01", "2026-06-30");
  const split = splitSegmentsAtBoundaries(segments, ["2026-06-01"]);
  assertEquals(split, segments);
});

Deno.test("splitSegmentsAtBoundaries: boundary outside every segment is harmlessly ignored", () => {
  const segments = buildMonthlySlices("2026-06-01", "2026-06-30");
  const split = splitSegmentsAtBoundaries(segments, ["2026-08-01"]);
  assertEquals(split, segments);
});

Deno.test("splitSegmentsAtBoundaries: multiple boundaries in the same segment produce three pieces", () => {
  const segments = buildMonthlySlices("2026-06-01", "2026-06-30");
  const split = splitSegmentsAtBoundaries(segments, ["2026-06-10", "2026-06-20"]);
  assertEquals(split, [
    { start: "2026-06-01", end: "2026-06-09", monthIndex: 1 },
    { start: "2026-06-10", end: "2026-06-19", monthIndex: 1 },
    { start: "2026-06-20", end: "2026-06-30", monthIndex: 1 },
  ]);
});

Deno.test("splitSegmentsAtBoundaries: duplicate boundary dates are de-duplicated", () => {
  const segments = buildMonthlySlices("2026-06-01", "2026-06-30");
  const split = splitSegmentsAtBoundaries(segments, ["2026-06-16", "2026-06-16"]);
  assertEquals(split.length, 2);
});

Deno.test("collectBoundaryDates: lease expiration boundary is the day AFTER expiration (so expiration day is the last full day included)", () => {
  const dates = collectBoundaryDates({ leaseExpiration: "2026-09-10" });
  assertEquals(dates, ["2026-09-11"]);
});

Deno.test("collectBoundaryDates: commencement, premises, area, occupancy, policy, and pool-membership windows all contribute", () => {
  const dates = collectBoundaryDates({
    leaseCommencement: "2026-01-01",
    leaseExpiration: "2026-12-31",
    premisesWindows: [{ effective_from: "2026-04-01", effective_to: "2026-06-30" }],
    areaPeriodWindows: [{ effective_from: "2026-07-01", effective_to: null }],
    occupancyWindows: [{ effective_from: "2026-02-01", effective_to: "2026-02-15" }],
    policyWindows: [{ effective_from: "2026-01-01", effective_to: null }],
    poolMembershipWindows: [{ effective_from: "2026-03-01", effective_to: "2026-03-31" }],
  });
  assertEquals(dates.includes("2026-01-01"), true); // commencement
  assertEquals(dates.includes("2027-01-01"), true); // day after expiration
  assertEquals(dates.includes("2026-04-01"), true); // premises start
  assertEquals(dates.includes("2026-07-01"), true); // premises end + 1
  assertEquals(dates.includes("2026-07-01"), true); // area period start (open-ended, no end boundary added)
});

Deno.test("End-to-end: amendment effective mid-period produces a clean split at the exact boundary, both halves summing to the full period", () => {
  const segments = buildMonthlySlices("2026-01-01", "2026-12-31");
  const boundaries = collectBoundaryDates({ leaseCommencement: "2026-01-01", leaseExpiration: "2026-12-31" }).concat(["2026-07-16"]);
  const split = splitSegmentsAtBoundaries(segments, boundaries);
  const totalDays = split.reduce((sum, s) => sum + inclusiveDayCount(s.start, s.end), 0);
  assertEquals(totalDays, 365);
  assertEquals(split.some((s) => s.start === "2026-07-16"), true);
  assertEquals(split.some((s) => s.end === "2026-07-15"), true);
});
