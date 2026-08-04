// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3, step 3:
// divide the recovery period into monthly segments, then further split
// each month at every effective-date boundary that falls strictly inside
// it (lease commencement/expiration, premises additions/surrenders, area
// changes, occupancy changes, policy/amendment effective dates, pool
// membership changes). ADR-CAM-001: "Every CAM run is calculated in
// monthly time slices, with daily proration for partial months."
import { addDays, compareDates, type ISODate, minDate, monthBounds } from "./date-math.ts";

export interface Segment {
  start: ISODate;
  end: ISODate;
  /** 1-based month number within the recovery period (for grouping/annual rollup). */
  monthIndex: number;
}

/**
 * Splits [periodStart, periodEnd] into calendar-month slices (clipped to
 * the period's own start/end for partial first/last months).
 */
export function buildMonthlySlices(periodStart: ISODate, periodEnd: ISODate): Segment[] {
  if (compareDates(periodStart, periodEnd) > 0) {
    throw new Error(`period_end (${periodEnd}) must not precede period_start (${periodStart})`);
  }
  const segments: Segment[] = [];
  let cursor = periodStart;
  let monthIndex = 1;
  while (compareDates(cursor, periodEnd) <= 0) {
    const [y, m] = cursor.split("-").map(Number);
    const bounds = monthBounds(y, m);
    const start = cursor;
    const end = minDate(bounds.end, periodEnd);
    segments.push({ start, end, monthIndex });
    cursor = addDays(end, 1);
    monthIndex += 1;
  }
  return segments;
}

/**
 * Further splits each monthly segment at every boundary date that falls
 * strictly inside it (not at a segment's own start, since that would
 * produce a zero-length split). A boundary at exactly a month's first day
 * is already naturally the segment start and needs no split. Boundaries
 * outside every segment (before periodStart or after periodEnd) are
 * ignored — they have no effect on this run's segmentation.
 */
export function splitSegmentsAtBoundaries(segments: Segment[], boundaryDates: ISODate[]): Segment[] {
  const sortedBoundaries = Array.from(new Set(boundaryDates)).sort(compareDates);
  const result: Segment[] = [];

  for (const segment of segments) {
    const cuts = sortedBoundaries.filter(
      (b) => compareDates(b, segment.start) > 0 && compareDates(b, segment.end) <= 0,
    );
    if (cuts.length === 0) {
      result.push(segment);
      continue;
    }
    let cursor = segment.start;
    for (const cut of cuts) {
      const segEnd = addDays(cut, -1);
      if (compareDates(cursor, segEnd) <= 0) {
        result.push({ start: cursor, end: segEnd, monthIndex: segment.monthIndex });
      }
      cursor = cut;
    }
    if (compareDates(cursor, segment.end) <= 0) {
      result.push({ start: cursor, end: segment.end, monthIndex: segment.monthIndex });
    }
  }
  return result;
}

/**
 * Collects every distinct effective-date boundary relevant to a lease's
 * segmentation within [periodStart, periodEnd]: lease commencement/
 * expiration, premises effective_from/effective_to, area period
 * effective_from/effective_to, occupancy period effective_from/effective_to,
 * policy effective_from/effective_to, and pool-scope-membership
 * effective_from/effective_to. Dates outside the period window are
 * included too (splitSegmentsAtBoundaries harmlessly ignores them) so
 * callers don't need to pre-filter.
 */
export function collectBoundaryDates(input: {
  leaseCommencement?: ISODate | null;
  leaseExpiration?: ISODate | null;
  premisesWindows?: Array<{ effective_from: ISODate; effective_to: ISODate | null }>;
  areaPeriodWindows?: Array<{ effective_from: ISODate; effective_to: ISODate | null }>;
  occupancyWindows?: Array<{ effective_from: ISODate; effective_to: ISODate | null }>;
  policyWindows?: Array<{ effective_from: ISODate; effective_to: ISODate | null }>;
  poolMembershipWindows?: Array<{ effective_from: ISODate; effective_to: ISODate | null }>;
}): ISODate[] {
  const dates: ISODate[] = [];
  const pushWindow = (w?: Array<{ effective_from: ISODate; effective_to: ISODate | null }>) => {
    for (const item of w ?? []) {
      dates.push(item.effective_from);
      if (item.effective_to) dates.push(addDays(item.effective_to, 1));
    }
  };
  if (input.leaseCommencement) dates.push(input.leaseCommencement);
  if (input.leaseExpiration) dates.push(addDays(input.leaseExpiration, 1));
  pushWindow(input.premisesWindows);
  pushWindow(input.areaPeriodWindows);
  pushWindow(input.occupancyWindows);
  pushWindow(input.policyWindows);
  pushWindow(input.poolMembershipWindows);
  return dates;
}
