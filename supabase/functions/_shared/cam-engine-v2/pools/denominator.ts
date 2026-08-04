// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3, step 7:
// effective-dated numerator (tenant's own recovery area) and denominator
// (pool's eligible area) for one segment. ADR-CAM-004: current unit square
// footage cannot be used for historical CAM — every figure here is
// resolved from the effective-dated Phase 1 tables (space_area_
// measurements, lease_premises_area_periods), not a live snapshot of
// today's units.square_footage.
import { overlapRange } from "../time/date-math.ts";
import type { Segment } from "../time/period-slicer.ts";
import type { LeasePremises, LeasePremisesAreaPeriod, SpaceAreaMeasurement, SpaceOccupancyPeriod } from "../contracts/cam-domain-types.ts";
import type { CalcException } from "../contracts/cam-output.ts";

/**
 * Denominator: sum of area_sqft for every scope_id (building/unit or the
 * property itself) eligible for this pool, weighted by how many days of
 * the segment each measurement actually covers (so a mid-segment
 * measurement change still contributes proportionally rather than an
 * all-or-nothing pick). Default denominator mode is TOTAL_ELIGIBLE_AREA
 * (vacant space included) per the blueprint's own default product
 * decision (section 19) — OCCUPIED_ELIGIBLE_AREA is a pool-level policy
 * choice not yet wired into this function; see the Phase 3 report for
 * this gap.
 */
export function computeDenominatorArea(
  segment: Segment,
  eligibleScopeIds: string[],
  areaMeasurements: SpaceAreaMeasurement[],
): { area: number; exceptions: CalcException[] } {
  const exceptions: CalcException[] = [];
  let total = 0;

  for (const scopeId of eligibleScopeIds) {
    const measurementsForScope = areaMeasurements.filter((m) => m.scope_id === scopeId && m.area_type === "rentable");
    if (measurementsForScope.length === 0) {
      exceptions.push({
        severity: "blocking",
        code: "AREA_MISSING",
        entity_type: "space_area_measurements",
        entity_id: scopeId,
        message: `No rentable area measurement found for scope ${scopeId} during segment ${segment.start}..${segment.end}`,
      });
      continue;
    }
    let scopeContribution = 0;
    let coveredDays = 0;
    const segmentDays = overlapRange(segment.start, segment.end, segment.start, segment.end)!.days;
    for (const measurement of measurementsForScope) {
      const overlap = overlapRange(segment.start, segment.end, measurement.effective_from, measurement.effective_to);
      if (!overlap) continue;
      scopeContribution += measurement.area_sqft * overlap.days;
      coveredDays += overlap.days;
    }
    if (coveredDays < segmentDays) {
      exceptions.push({
        severity: "blocking",
        code: "AREA_MISSING",
        entity_type: "space_area_measurements",
        entity_id: scopeId,
        message: `Scope ${scopeId} has a gap in area measurement coverage during segment ${segment.start}..${segment.end}`,
      });
    }
    total += coveredDays > 0 ? scopeContribution / coveredDays : 0;
  }

  return { area: round2(total), exceptions };
}

/**
 * Numerator: the tenant's own effective recovery area for this segment,
 * summed across every premises record (multi-suite leases) that overlaps
 * it, each weighted by day-coverage the same way as the denominator above.
 */
export function computeTenantNumeratorArea(
  segment: Segment,
  premises: (LeasePremises & { area_periods: LeasePremisesAreaPeriod[] })[],
): { area: number; exceptions: CalcException[] } {
  const exceptions: CalcException[] = [];
  let total = 0;

  const relevantPremises = premises.filter(
    (p) => p.status !== "superseded" && overlapRange(segment.start, segment.end, p.effective_from, p.effective_to),
  );

  if (relevantPremises.length === 0) {
    exceptions.push({
      severity: "blocking",
      code: "PREMISES_MISSING",
      entity_type: "lease_premises",
      entity_id: null,
      message: `No effective premises found for segment ${segment.start}..${segment.end}`,
    });
    return { area: 0, exceptions };
  }

  for (const p of relevantPremises) {
    const areaPeriods = p.area_periods.filter((ap) => overlapRange(segment.start, segment.end, ap.effective_from, ap.effective_to));
    if (areaPeriods.length === 0) {
      exceptions.push({
        severity: "blocking",
        code: "AREA_MISSING",
        entity_type: "lease_premises",
        entity_id: p.id,
        message: `Premises ${p.id} has no effective recovery area for segment ${segment.start}..${segment.end}`,
      });
      continue;
    }
    for (const ap of areaPeriods) {
      const overlap = overlapRange(segment.start, segment.end, ap.effective_from, ap.effective_to)!;
      const area = ap.recovery_area_sqft ?? ap.contractual_area_sqft;
      if (area === null || area === undefined) {
        exceptions.push({
          severity: "blocking",
          code: "AREA_MISSING",
          entity_type: "lease_premises_area_periods",
          entity_id: ap.id,
          message: `Area period ${ap.id} for premises ${p.id} has neither recovery_area_sqft nor contractual_area_sqft set`,
        });
        continue;
      }
      const segmentDays = overlapRange(segment.start, segment.end, segment.start, segment.end)!.days;
      total += (area * overlap.days) / segmentDays;
    }
  }

  return { area: round2(total), exceptions };
}

/**
 * Occupied area for gross-up's actual-occupancy input: same day-weighted
 * scope aggregation as computeDenominatorArea, restricted to
 * occupancy_status === 'occupied'. A scope with zero occupancy rows for the
 * segment contributes 0 (vacant), not a blocking exception — vacancy is a
 * normal, expected state that gross-up exists to correct for, not a data
 * defect.
 */
export function computeOccupiedArea(
  segment: Segment,
  eligibleScopeIds: string[],
  occupancyPeriods: SpaceOccupancyPeriod[],
): number {
  let total = 0;
  const segmentDays = overlapRange(segment.start, segment.end, segment.start, segment.end)!.days;

  for (const scopeId of eligibleScopeIds) {
    const periods = occupancyPeriods.filter((p) => p.scope_id === scopeId && p.occupancy_status === "occupied");
    let scopeContribution = 0;
    for (const period of periods) {
      const overlap = overlapRange(segment.start, segment.end, period.effective_from, period.effective_to);
      if (!overlap || period.occupied_area_sqft === null) continue;
      scopeContribution += (period.occupied_area_sqft * overlap.days) / segmentDays;
    }
    total += scopeContribution;
  }

  return round2(total);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
