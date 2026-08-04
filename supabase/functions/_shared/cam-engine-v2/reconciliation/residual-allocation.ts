// Enterprise CAM & Budget Implementation Blueprint v1.0 — Workstream B.3:
// deterministic largest-remainder residual allocation. Pure function.
//
// Applies ONLY to a genuine proportional split of a shared amount (e.g.
// CALCULATE_SHARE's area/fixed-percentage division of one pool's dollars
// across the leases participating in it) — never to amounts a cap,
// exclusion, or non-recoverable-expense determination has already reduced.
// The orchestrator enforces this by construction: it only ever builds a
// ResidualAllocationCandidate set from RAW CALCULATE_SHARE outputs, before
// any APPLY_CAP/APPLY_BASE_YEAR/APPLY_EXPENSE_STOP step has run — caps and
// exclusions are computed afterward, per lease, and are never part of the
// group this module reconciles.
export interface ResidualAllocationCandidate {
  /** Stable, unique identifier for this candidate within the group (e.g. lease_id) — also the deterministic tie-breaker key. */
  key: string;
  /** High-precision (unrounded) share, in the SAME units as targetTotal. */
  rawAmount: number;
}

export interface ResidualAllocationResult {
  key: string;
  /** The naive per-candidate rounding, before any residual correction. */
  naiveRoundedAmount: number;
  /** Final amount after residual correction — this is what should actually be used downstream. */
  finalAmount: number;
  /** finalAmount - naiveRoundedAmount. Zero for every candidate except the ones that absorbed the residual. */
  residualAdjustment: number;
}

export interface ResidualAllocationOutcome {
  results: ResidualAllocationResult[];
  /** Total residual units (at ledger precision) that were distributed. Zero if the naive rounding already tied out exactly. */
  residualUnitsDistributed: number;
}

/**
 * Standard largest-remainder method: round every candidate to the nearest
 * ledger unit, then add or remove the difference between that sum and the
 * (independently ledger-rounded) target total one unit at a time, ordered
 * by which candidates were rounded furthest from their true value.
 *
 *   residual > 0 (naive sum undershoots the target): the candidates with
 *     the LARGEST positive fractional remainder (rounded down the most)
 *     receive +1 unit each, largest remainder first.
 *   residual < 0 (naive sum overshoots the target): the candidates with
 *     the SMALLEST (most negative) fractional remainder (rounded up the
 *     most) lose 1 unit each, smallest remainder first.
 *
 * Tie-breaking is the candidate's own `key`, ascending — stable and
 * deterministic across reruns with byte-identical input (required for
 * "stable deterministic rerun").
 */
export function applyLargestRemainderAllocation(
  candidates: ResidualAllocationCandidate[],
  targetTotal: number,
  ledgerPlaces: number,
): ResidualAllocationOutcome {
  if (candidates.length === 0) {
    return { results: [], residualUnitsDistributed: 0 };
  }

  const factor = 10 ** ledgerPlaces;

  const rows = candidates.map((c) => {
    const scaled = c.rawAmount * factor;
    const naiveRoundedUnits = Math.round(scaled);
    return {
      key: c.key,
      rawAmount: c.rawAmount,
      naiveRoundedUnits,
      remainder: scaled - naiveRoundedUnits, // in (-0.5, 0.5]
      adjustmentUnits: 0,
    };
  });

  const sumNaiveUnits = rows.reduce((s, r) => s + r.naiveRoundedUnits, 0);
  const targetUnits = Math.round(targetTotal * factor);
  const residualUnits = targetUnits - sumNaiveUnits;

  if (residualUnits > 0) {
    const order = [...rows].sort((a, b) => (b.remainder - a.remainder) || a.key.localeCompare(b.key));
    for (let i = 0; i < residualUnits && i < order.length; i++) order[i].adjustmentUnits += 1;
  } else if (residualUnits < 0) {
    const order = [...rows].sort((a, b) => (a.remainder - b.remainder) || a.key.localeCompare(b.key));
    for (let i = 0; i < -residualUnits && i < order.length; i++) order[i].adjustmentUnits -= 1;
  }

  const results: ResidualAllocationResult[] = rows.map((r) => {
    const naiveRoundedAmount = round(r.naiveRoundedUnits / factor, ledgerPlaces);
    const finalAmount = round((r.naiveRoundedUnits + r.adjustmentUnits) / factor, ledgerPlaces);
    return {
      key: r.key,
      naiveRoundedAmount,
      finalAmount,
      residualAdjustment: round(finalAmount - naiveRoundedAmount, ledgerPlaces),
    };
  });

  return { results, residualUnitsDistributed: Math.abs(residualUnits) };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
