// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3 / 3B
// orchestrator: wires the pure time/pool/policy/reconciliation modules into
// a single CamRunInput -> CamRunOutput pipeline. Step 1 (live readiness
// re-check) and step 14 (transactional persistence) are the calling edge
// function's responsibility, not this module's, since this module has no
// database access by design.
//
// Phase 3B product decision 1 — MULTI-POOL, NOT single-pool resolution: a
// lease may recover from any number of pools simultaneously. Each eligible
// (lease, pool, category, segment) combination is calculated independently
// and summed into the lease's final_recovery. There is no "pick one pool"
// step anywhere in this file.
//
// Phase 3B product decision 2 — pool eligibility authority chain, all of
// which must hold before a dollar is computed for a (lease, pool, category)
// triple:
//   Gate 1 (pools/pool-builder.ts::assembleSegmentAmounts): the expense
//     input's dollars are IN the pool at all, via an explicit, balanced
//     cam_input_pool_assignments row. A trigger in migration
//     20269900000016 additionally prevents any input's assignments from
//     summing past its own source amount — the DB-level double-recovery
//     guard. validateNoOverAssignment() below is the same check re-run
//     inside the pure engine as defense-in-depth, since this module cannot
//     assume the snapshot it was handed was built by a DB that still has
//     that trigger (e.g. a hand-built or replayed snapshot).
//   Gate 2 (resolveActiveParticipantPools): the LEASE has an explicit,
//     active recovery_pool_lease_participants row for this pool covering
//     this segment. Spatial/building overlap is NEVER consulted as
//     authority — only used to scope a participating lease's OWN numerator
//     area down to the premises actually inside a given pool's physical
//     scope (poolScopedNumeratorArea), which is a different question
//     ("how much of this pool does the tenant's presence there represent")
//     from "is the tenant allowed to recover from this pool at all."
//   Gate 3 (categoryPoolsForLease): the pool's own category
//     inclusion/exclusion list accepts the category the lease's policy is
//     written for (or the pool is open/uncategorized).
//   Gate 4: effective dates — the unified segmentation itself.
//
// Real double recovery only exists when TWO active policies for the SAME
// lease cover the SAME category with an OVERLAPPING effective window —
// that would compute the SAME pool+category dollar pot twice. Recovering
// the SAME category from TWO DIFFERENT pools is NOT double recovery,
// because Gate 1's balance trigger guarantees those pools' dollars for a
// given source expense never overlap in the first place.
import { buildMonthlySlices, collectBoundaryDates, splitSegmentsAtBoundaries, type Segment } from "../time/period-slicer.ts";
import { compareDates, inclusiveDayCount, overlapRange } from "../time/date-math.ts";
import { applyCategoryInclusionExclusion, assembleSegmentAmounts, type PoolSegmentAmount } from "../pools/pool-builder.ts";
import { applyGrossUp } from "../pools/gross-up.ts";
import { computeDenominatorArea, computeOccupiedArea, computeTenantNumeratorArea } from "../pools/denominator.ts";
import { runPolicySteps } from "../policies/policy-step-runner.ts";
import { reconcileEstimates } from "../reconciliation/estimate-reconciliation.ts";
import { applyLargestRemainderAllocation } from "../reconciliation/residual-allocation.ts";
import type { CamRunInput, CamRunLeaseContext } from "../contracts/cam-input.ts";
import type { CalcException, CalculationLine, CamRunOutput, LeaseResult, PoolResult } from "../contracts/cam-output.ts";
import type { LeasePremises, LeasePremisesAreaPeriod, LeasePremisesSpace, RecoveryPoolCategory, RoundingScope } from "../contracts/cam-domain-types.ts";

const segKey = (s: { start: string; end: string }) => `${s.start}|${s.end}`;
const UNCATEGORIZED = "__uncategorized__";

type AugmentedPool = CamRunInput["pools"][number];
type AugmentedPolicy = CamRunInput["policies"][number];
type AugmentedPremises = LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] };

/** Stable (key-sorted) JSON stringification so input_hash does not depend on property insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

export async function computeInputHash(input: CamRunInput): Promise<string> {
  // readiness_at_snapshot_time is EXCLUDED from the hash deliberately: it
  // carries a live evaluated_at timestamp from evaluate_cam_readiness(),
  // which changes on every live re-check even when the underlying source
  // data it read is byte-identical. Including it would make input_hash
  // change on every call and permanently defeat idempotent-rerun detection
  // (Phase 3 step 16 / Phase 3B-D requirement 10) — the hash must reflect
  // the DATA the run was computed from, not incidental metadata about when
  // readiness happened to be checked.
  const { readiness_at_snapshot_time: _readinessAtSnapshotTime, ...hashableInput } = input;
  const bytes = new TextEncoder().encode(stableStringify(hashableInput));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Resolve the configured annual rounding scope from a RoundingPolicy.
 * Falls back to LEASE_POOL_PERIOD if the field is absent (backward
 * compatibility with runs persisted before Phase 4B).
 */
function annualRoundingScope(policy: CamRunInput["run"]["rounding_policy"]): RoundingScope {
  // annual_rounding_scope is a declared, required field on RoundingPolicy, so
  // the previous `policy as Record<string, unknown>` cast was both unnecessary
  // and a hard TS2352 error (RoundingPolicy has no string index signature),
  // which blocked `deno check` across every module importing this file. The
  // runtime `??` fallback is retained deliberately: runs persisted before
  // Phase 4B can carry a rounding_policy JSON blob without this key, and a
  // replayed snapshot must still round at the documented default.
  return policy?.annual_rounding_scope ?? "LEASE_POOL_PERIOD";
}

/**
 * Defense-in-depth mirror of migration 20269900000016's
 * enforce_cam_pool_assignment_balance trigger: no published expense input's
 * pool assignments may sum past its own amount. Run inside the pure engine
 * because this module must not assume every caller building a CamRunInput
 * is the live, trigger-protected database (a hand-built or replayed
 * snapshot could violate it).
 */
function validateNoOverAssignment(input: CamRunInput): CalcException[] {
  const exceptions: CalcException[] = [];
  const byInput = new Map<string, number>();
  for (const a of input.pool_assignments) {
    byInput.set(a.cam_expense_input_id, (byInput.get(a.cam_expense_input_id) ?? 0) + a.amount);
  }
  const amountsById = new Map(input.published_expense_inputs.map((i) => [i.id, i.amount]));
  for (const [expenseInputId, assignedTotal] of byInput) {
    const sourceAmount = amountsById.get(expenseInputId);
    if (sourceAmount === undefined) continue; // POOL_ASSIGNMENT_ORPHANED, already reported by assembleSegmentAmounts
    if (assignedTotal > sourceAmount + 0.01) {
      exceptions.push({
        severity: "blocking", code: "POOL_ASSIGNMENT_OVER_ALLOCATED", entity_type: "cam_expense_inputs", entity_id: expenseInputId,
        message: `Expense input ${expenseInputId}'s pool assignments total ${assignedTotal}, which exceeds its own amount ${sourceAmount} — an input may be split across pools only through balanced assignments that never exceed its own amount (prevents double recovery)`,
      });
    }
  }
  return exceptions;
}

/**
 * A pool's eligible area scope for a segment: active scope_members if any
 * are configured (building/unit pools, or a property pool with explicit
 * member overrides), otherwise the pool's own property/building identity.
 */
function resolveEligibleScopeIds(pool: AugmentedPool, segment: Segment): string[] {
  const activeMembers = pool.scope_members.filter((m) => m.include_in_denominator && overlapRange(segment.start, segment.end, m.effective_from, m.effective_to));
  if (activeMembers.length > 0) return activeMembers.map((m) => m.scope_id);
  if (pool.scope_type === "property") return [pool.property_id];
  if (pool.scope_type === "building" && pool.scope_id) return [pool.scope_id];
  return [];
}

function activePremisesFor(lease: CamRunLeaseContext, segment: Segment): AugmentedPremises[] {
  return lease.premises.filter((p) => p.status !== "superseded" && overlapRange(segment.start, segment.end, p.effective_from, p.effective_to));
}

/**
 * A pool-SCOPED numerator: only the lease's premises whose spaces actually
 * fall inside this pool's physical scope contribute area to this pool's
 * recovery ("parking pool applying only to selected premises" — a
 * multi-suite lease with one premises in a building the parking pool
 * covers and another premises elsewhere only recovers parking CAM for the
 * first). Property-scoped pools cover every premises in that property
 * (their scope IS the whole property); building/custom pools are
 * restricted to premises whose spaces resolve into that pool's eligible
 * scope ids for this segment.
 */
function poolScopedPremises(lease: CamRunLeaseContext, pool: AugmentedPool, segment: Segment): AugmentedPremises[] {
  const premises = activePremisesFor(lease, segment);
  if (pool.scope_type === "property") {
    return premises.filter((p) => p.spaces.some((s) => s.property_id === pool.property_id));
  }
  const eligibleScopeIds = new Set(resolveEligibleScopeIds(pool, segment));
  return premises.filter((p) => p.spaces.some((s) => (s.building_id && eligibleScopeIds.has(s.building_id)) || (s.unit_id && eligibleScopeIds.has(s.unit_id))));
}

/**
 * Explicit, authoritative lease<->pool eligibility (product decisions 1/2)
 * — the ONLY source of truth for "may this lease recover from this pool."
 */
function resolveActiveParticipantPoolIds(lease: CamRunLeaseContext, segment: Segment, participants: CamRunInput["pool_lease_participants"]): Set<string> {
  const ids = new Set<string>();
  for (const p of participants) {
    if (p.lease_id !== lease.id || p.status !== "active") continue;
    if (overlapRange(segment.start, segment.end, p.effective_from, p.effective_to)) ids.add(p.pool_id);
  }
  return ids;
}

/** Which of a set of pools accept a given category, per that pool's own inclusion/exclusion configuration (Gate 3). */
function categoryPoolsFor(pools: AugmentedPool[], category: string | null, poolCategoriesById: Map<string, RecoveryPoolCategory[]>): AugmentedPool[] {
  return pools.filter((pool) => {
    const cats = poolCategoriesById.get(pool.id) ?? [];
    if (cats.length === 0) return true; // open pool: accepts any category
    if (category === null) return false;
    const excluded = cats.find((c) => c.expense_category_id === category && c.inclusion_mode === "exclude");
    if (excluded) return false;
    const included = cats.find((c) => c.expense_category_id === category && c.inclusion_mode === "include");
    const hasAnyInclude = cats.some((c) => c.inclusion_mode === "include");
    return Boolean(included) || !hasAnyInclude;
  });
}

/** A policy's own governing category — every step materialize_lease_recovery_policy generates for one rule shares the same expense_category_id. */
function policyCategoryOf(policy: AugmentedPolicy): string | null {
  return policy.steps.find((s) => s.expense_category_id !== null)?.expense_category_id ?? null;
}

/** A policy's own gross-up target (fraction, e.g. 0.95), or null if it has no GROSS_UP_VARIABLE step. */
function policyGrossUpTarget(policy: AugmentedPolicy): number | null {
  for (const step of policy.steps) {
    if (step.step_type !== "GROSS_UP_VARIABLE") continue;
    const raw = step.parameters?.target_occupancy_pct;
    if (typeof raw === "number") return raw / 100;
  }
  return null;
}

interface PoolSegmentRaw {
  includedAmounts: PoolSegmentAmount[];
  rawTotal: number;
  excludedTotal: number;
  denominatorArea: number;
  actualOccupancyPct: number;
}

interface CategoryAdjustedResult {
  perCategory: Map<string, number>;
  perCategoryControl: Map<string, { controllable: number; uncontrollable: number }>;
  grossUpAdjustment: number;
}

export async function runCamEngine(input: CamRunInput): Promise<CamRunOutput> {
  const exceptions: CalcException[] = [...validateNoOverAssignment(input)];
  const lines: CalculationLine[] = [];
  const internalPlaces = input.run.rounding_policy.internal_decimal_places ?? 6;
  const ledgerPlaces = input.run.rounding_policy.ledger_decimal_places ?? 2;
  // Frozen onto every boundary-crossing calculation line so a reader can see
  // which policy actually produced the number, without re-deriving it.
  const roundingPolicyDisclosure = {
    internal_decimal_places: internalPlaces,
    ledger_decimal_places: ledgerPlaces,
    annual_rounding_scope: annualRoundingScope(input.run.rounding_policy),
    estimate_rounding_scope: input.run.rounding_policy.estimate_rounding_scope ?? "MONTH",
    residual_allocation: input.run.rounding_policy.residual_allocation ?? "largest_remainder",
  };
  const input_hash = await computeInputHash(input);

  if (compareDates(input.recovery_period.start_date, input.recovery_period.end_date) > 0) {
    exceptions.push({
      severity: "blocking", code: "RECOVERY_PERIOD_INVALID", entity_type: "recovery_periods", entity_id: input.recovery_period.id,
      message: `recovery_period.end_date (${input.recovery_period.end_date}) precedes start_date (${input.recovery_period.start_date})`,
    });
    return { input_hash, pool_results: [], lease_results: [], calculation_lines: [], exceptions, ready_to_post: false };
  }

  const fiscalYearDays = inclusiveDayCount(input.recovery_period.start_date, input.recovery_period.end_date);

  const allPremisesWindows = input.leases.flatMap((l) => l.premises.filter((p) => p.status !== "superseded").map((p) => ({ effective_from: p.effective_from, effective_to: p.effective_to })));
  const allAreaPeriodWindows = input.leases.flatMap((l) => l.premises.flatMap((p) => p.area_periods.map((ap) => ({ effective_from: ap.effective_from, effective_to: ap.effective_to }))));
  const allOccupancyWindows = input.occupancy_periods.map((o) => ({ effective_from: o.effective_from, effective_to: o.effective_to }));
  const allPolicyWindows = input.policies.map((p) => ({ effective_from: p.effective_from, effective_to: p.effective_to }));
  const allPoolMembershipWindows = input.pools.flatMap((p) => p.scope_members.map((m) => ({ effective_from: m.effective_from, effective_to: m.effective_to })));
  const allParticipantWindows = input.pool_lease_participants.map((p) => ({ effective_from: p.effective_from, effective_to: p.effective_to }));

  const boundaries = collectBoundaryDates({
    premisesWindows: allPremisesWindows,
    areaPeriodWindows: allAreaPeriodWindows,
    occupancyWindows: allOccupancyWindows,
    policyWindows: allPolicyWindows,
    poolMembershipWindows: [...allPoolMembershipWindows, ...allParticipantWindows],
  });
  const segments = splitSegmentsAtBoundaries(buildMonthlySlices(input.recovery_period.start_date, input.recovery_period.end_date), boundaries);

  const poolCategoriesById = new Map(input.pools.map((p) => [p.id, p.categories]));
  const poolsById = new Map(input.pools.map((p) => [p.id, p]));

  // ---- Pass 1: per pool, per segment — assemble raw (pre-gross-up) totals, denominator area, and occupancy inputs. ----
  // Gross-up itself is deferred to Pass 2 because Phase 3B product decision
  // 3 makes the target occupancy potentially LEASE-specific — the pool
  // cannot precompute one canonical adjusted total when different leases
  // reading from it may specify different targets.
  const poolResults: PoolResult[] = [];
  const poolRaw = new Map<string, Map<string, PoolSegmentRaw>>();
  // Memoizes resolveGrossedCategoryAmounts by `${poolId}|${segmentKey}|${target ?? 'none'}` so multiple
  // leases sharing the same effective target don't repeat identical gross-up math.
  const categoryAdjustedCache = new Map<string, CategoryAdjustedResult>();

  for (const pool of input.pools) {
    const relevantAssignments = input.pool_assignments.filter((a) => a.recovery_pool_id === pool.id);
    const { amounts, exceptions: assemblyExceptions } = assembleSegmentAmounts(segments, input.published_expense_inputs, relevantAssignments);
    exceptions.push(...assemblyExceptions);
    const { included, excluded, exceptions: categoryExceptions } = applyCategoryInclusionExclusion(amounts, { [pool.id]: pool.categories });
    exceptions.push(...categoryExceptions);

    let poolActual = 0, poolExcluded = 0;
    const segmentRawMap = new Map<string, PoolSegmentRaw>();

    for (const segment of segments) {
      const key = segKey(segment);
      const includedForSegment = included.filter((a) => segKey(a.segment) === key);
      const excludedForSegment = excluded.filter((a) => segKey(a.segment) === key);
      const rawTotal = roundTo(includedForSegment.reduce((s, a) => s + a.amount, 0), internalPlaces);
      const excludedTotal = roundTo(excludedForSegment.reduce((s, a) => s + a.amount, 0), internalPlaces);
      poolActual += rawTotal;
      poolExcluded += excludedTotal;

      const scopeIds = resolveEligibleScopeIds(pool, segment);
      const { area: denominatorArea, exceptions: denomExceptions } = includedForSegment.length > 0
        ? computeDenominatorArea(segment, scopeIds, input.area_measurements)
        : { area: 0, exceptions: [] as CalcException[] };
      if (includedForSegment.length > 0) exceptions.push(...denomExceptions);
      const occupiedArea = computeOccupiedArea(segment, scopeIds, input.occupancy_periods);
      const actualOccupancyPct = denominatorArea > 0 ? occupiedArea / denominatorArea : 0;

      segmentRawMap.set(key, { includedAmounts: includedForSegment, rawTotal, excludedTotal, denominatorArea, actualOccupancyPct });

      if (includedForSegment.length > 0) {
        lines.push({
          lease_id: null, pool_id: pool.id, sequence: 0, line_type: "POOL_SOURCE", category: null, formula_code: "POOL_ASSEMBLY",
          input_amount: roundTo(rawTotal + excludedTotal, ledgerPlaces), output_amount: roundTo(rawTotal, ledgerPlaces), adjustment: roundTo(-excludedTotal, ledgerPlaces),
          policy_step_id: null, explanation: `Pool ${pool.name}: ${rawTotal} included, ${excludedTotal} excluded by category rules`,
          segment_start: segment.start, segment_end: segment.end,
        });
      }
    }

    poolRaw.set(pool.id, segmentRawMap);

    // Reference gross-up for the pool-level aggregate row/lines: uses the
    // pool's OWN default_gross_up_target_pct (or none). This is a baseline
    // view for explainability/reporting only — a lease with its own
    // GROSS_UP_VARIABLE override computes and stores ITS OWN adjusted
    // amount separately in its calculation lines (see Pass 2); the two can
    // legitimately differ, by design (product decision 3).
    const referenceTarget = pool.default_gross_up_target_pct !== null ? pool.default_gross_up_target_pct / 100 : null;
    let poolGrossUp = 0, poolAdjusted = 0;
    for (const segment of segments) {
      const key = segKey(segment);
      const raw = segmentRawMap.get(key)!;
      if (raw.includedAmounts.length === 0) continue;
      const { result: grossUp, exceptions: grossUpExceptions } = applyGrossUp(pool.id, raw.includedAmounts, raw.actualOccupancyPct, referenceTarget);
      exceptions.push(...grossUpExceptions);
      poolGrossUp += grossUp.grossUpAdjustment;
      poolAdjusted += grossUp.adjustedPool;
      if (grossUp.grossUpAdjustment !== 0) {
        lines.push({
          lease_id: null, pool_id: pool.id, sequence: 0, line_type: "GROSS_UP", category: null, formula_code: "GROSS_UP_VARIABLE_REFERENCE",
          input_amount: roundTo(raw.rawTotal, ledgerPlaces), output_amount: roundTo(grossUp.adjustedPool, ledgerPlaces), adjustment: roundTo(grossUp.grossUpAdjustment, ledgerPlaces),
          policy_step_id: null, explanation: `Pool-default reference gross-up: actual occupancy ${(raw.actualOccupancyPct * 100).toFixed(2)}% -> target ${((referenceTarget ?? 0) * 100).toFixed(2)}% (individual leases may compute their own target separately)`,
          segment_start: segment.start, segment_end: segment.end,
        });
      }
    }

    poolResults.push({
      pool_id: pool.id, actual_amount: roundTo(poolActual, ledgerPlaces), excluded_amount: roundTo(poolExcluded, ledgerPlaces),
      gross_up_adjustment: roundTo(poolGrossUp, ledgerPlaces), amortization: 0, adjusted_pool: roundTo(poolAdjusted, ledgerPlaces),
      denominator_metrics: {},
    });
  }

  /** On-demand, memoized per-category gross-up for an arbitrary (possibly lease-specific) target. */
  function resolveGrossedCategoryAmounts(pool: AugmentedPool, segment: Segment, targetPct: number | null): CategoryAdjustedResult {
    const key = segKey(segment);
    const cacheKey = `${pool.id}|${key}|${targetPct ?? "none"}`;
    const cached = categoryAdjustedCache.get(cacheKey);
    if (cached) return cached;

    const raw = poolRaw.get(pool.id)?.get(key);
    const perCategory = new Map<string, number>();
    const perCategoryControl = new Map<string, { controllable: number; uncontrollable: number }>();
    if (!raw || raw.includedAmounts.length === 0) {
      const empty = { perCategory, perCategoryControl, grossUpAdjustment: 0 };
      categoryAdjustedCache.set(cacheKey, empty);
      return empty;
    }

    const { result: grossUp } = applyGrossUp(pool.id, raw.includedAmounts, raw.actualOccupancyPct, targetPct);
    const includedTotalRaw = raw.includedAmounts.reduce((s, a) => s + a.amount, 0);
    for (const a of raw.includedAmounts) {
      const shareOfSegment = includedTotalRaw > 0 ? a.amount / includedTotalRaw : 0;
      // Keyed by canonical expense_category_id: this map is read below with
      // the policy's own lease_recovery_policy_steps.expense_category_id
      // (a public.expense_categories UUID). Keying it by the free-text
      // label instead made every lookup miss, so each tenant's eligible
      // input amount resolved to 0 (specification 8.3).
      const categoryKey = a.expense_category_id ?? UNCATEGORIZED;
      const adjustedShare = grossUp.adjustedPool * shareOfSegment;
      perCategory.set(categoryKey, (perCategory.get(categoryKey) ?? 0) + adjustedShare);
      const split = perCategoryControl.get(categoryKey) ?? { controllable: 0, uncontrollable: 0 };
      if (a.controllability === "controllable") split.controllable += adjustedShare;
      else if (a.controllability === "uncontrollable") split.uncontrollable += adjustedShare;
      perCategoryControl.set(categoryKey, split);
    }
    const result = { perCategory, perCategoryControl, grossUpAdjustment: grossUp.grossUpAdjustment };
    categoryAdjustedCache.set(cacheKey, result);
    return result;
  }

  // ---- Pass 2: per lease, per segment — resolve every eligible (pool, category), run the CALCULATE_SHARE step only, defer the rest. ----
  // Workstream B.3: residual allocation must happen strictly at the raw
  // proportional-share stage, BEFORE any cap/base-year/expense-stop/fee
  // step can reduce a tenant's amount for a real business reason — so this
  // pass only computes each lease's raw share (and, for DIRECT_ASSIGN or
  // exclusion-only policies with no CALCULATE_SHARE step at all, the FULL
  // result immediately, since there is no shared pool to reconcile
  // against). Resolution/eligibility/duplicate-detection logic is
  // unchanged from before this pass was split.
  interface PendingContribution {
    leaseId: string;
    groupKey: string | null; // null => fully resolved already (no CALCULATE_SHARE step in this policy)
    rawShareAmount: number;
    shareLines: CalculationLine[];
    shareExceptions: CalcException[];
    remainingSteps: AugmentedPolicy["steps"];
    ctx: Parameters<typeof runPolicySteps>[2];
  }
  const pendingContributions: PendingContribution[] = [];

  const policiesByLease = new Map<string, AugmentedPolicy[]>();
  for (const policy of input.policies) {
    const list = policiesByLease.get(policy.lease_id) ?? [];
    list.push(policy);
    policiesByLease.set(policy.lease_id, list);
  }

  for (const lease of input.leases) {
    const leasePolicies = policiesByLease.get(lease.id) ?? [];

    for (const segment of segments) {
      const key = segKey(segment);
      const activePolicies = leasePolicies.filter((p) => p.status === "approved" && overlapRange(segment.start, segment.end, p.effective_from, p.effective_to));
      if (activePolicies.length === 0) continue;

      const participantPoolIds = resolveActiveParticipantPoolIds(lease, segment, input.pool_lease_participants);
      const participantPools = input.pools.filter((p) => participantPoolIds.has(p.id));

      // Group this lease's active policies by category to detect real
      // duplicate-recovery-path conflicts (product decision 1's closing
      // clause: "ambiguity exists only when overlapping configuration
      // would recover the same allocation more than once").
      const policiesByCategory = new Map<string, AugmentedPolicy[]>();
      for (const policy of activePolicies) {
        const category = policyCategoryOf(policy) ?? UNCATEGORIZED;
        const list = policiesByCategory.get(category) ?? [];
        list.push(policy);
        policiesByCategory.set(category, list);
      }

      for (const [categoryKey, categoryPolicies] of policiesByCategory) {
        const policyCategory = categoryKey === UNCATEGORIZED ? null : categoryKey;
        const eligiblePools = categoryPoolsFor(participantPools, policyCategory, poolCategoriesById);

        if (eligiblePools.length === 0) {
          exceptions.push({
            severity: "blocking", code: "LEASE_POOL_UNRESOLVED", entity_type: "lease_recovery_policies", entity_id: categoryPolicies[0].id,
            message: `Lease ${lease.id} has an active policy for category ${policyCategory ?? "(none)"} but no pool it explicitly participates in accepts that category for segment ${segment.start}..${segment.end} — add an explicit recovery_pool_lease_participants grant or correct the pool's category configuration`,
          });
          continue;
        }

        if (categoryPolicies.length > 1) {
          const targets = categoryPolicies.map((p) => policyGrossUpTarget(p));
          const distinctTargets = new Set(targets.filter((t): t is number => t !== null));
          if (distinctTargets.size > 1) {
            exceptions.push({
              severity: "blocking", code: "GROSS_UP_TARGET_CONFLICT", entity_type: "lease_recovery_policies", entity_id: categoryPolicies[0].id,
              message: `Lease ${lease.id} has ${categoryPolicies.length} simultaneously-active policies for category ${policyCategory ?? "(none)"} with conflicting gross-up targets (${[...distinctTargets].join(", ")}) for segment ${segment.start}..${segment.end} — resolve which policy governs before this run can post`,
            });
          } else {
            exceptions.push({
              severity: "blocking", code: "DUPLICATE_RECOVERY_PATH", entity_type: "lease_recovery_policies", entity_id: categoryPolicies[0].id,
              message: `Lease ${lease.id} has ${categoryPolicies.length} simultaneously-active policies for category ${policyCategory ?? "(none)"} for segment ${segment.start}..${segment.end} — computing all of them would recover the same pool allocation more than once; supersede the stale policy before this run can post`,
            });
          }
          continue; // never compute a duplicated/conflicting path
        }

        const policy = categoryPolicies[0];
        const leaseGrossUpTarget = policyGrossUpTarget(policy);
        const priorCamHistory = input.prior_cam_history.filter((h) => h.lease_id === lease.id);

        // Product decision 1: MULTIPLE eligible pools are aggregated, not
        // chosen between. Gate 1's balance trigger guarantees a source
        // expense's dollars never appear in more than one of these pools
        // at once, so summing across pools here is not double recovery.
        for (const pool of eligiblePools) {
          const effectiveTarget = leaseGrossUpTarget ?? (pool.default_gross_up_target_pct !== null ? pool.default_gross_up_target_pct / 100 : null);
          const { perCategory, perCategoryControl } = resolveGrossedCategoryAmounts(pool, segment, effectiveTarget);
          const inputAmount = perCategory.get(categoryKey) ?? 0;
          const control = perCategoryControl.get(categoryKey) ?? { controllable: 0, uncontrollable: 0 };

          const scopedPremises = poolScopedPremises(lease, pool, segment);
          const { area: numeratorArea, exceptions: numExceptions } = scopedPremises.length > 0
            ? computeTenantNumeratorArea(segment, scopedPremises)
            : { area: 0, exceptions: [] as CalcException[] };
          if (scopedPremises.length === 0) {
            exceptions.push({
              severity: "blocking", code: "PREMISES_MISSING", entity_type: "lease_premises", entity_id: null,
              message: `Lease ${lease.id} participates in pool ${pool.id} but has no premises within that pool's physical scope for segment ${segment.start}..${segment.end}`,
            });
          } else {
            exceptions.push(...numExceptions);
          }

          const denominatorArea = poolRaw.get(pool.id)?.get(key)?.denominatorArea ?? 0;
          const baseYearSnapshots = input.base_year_snapshots.filter((s) => s.pool_id === pool.id);

          const ctx = {
            leaseId: lease.id, poolId: pool.id, segment, fiscalYearDays, numeratorArea, denominatorArea,
            priorCamHistory, baseYearSnapshots, controllableInputAmount: control.controllable, uncontrollableInputAmount: control.uncontrollable,
          };

          // Split at the CALCULATE_SHARE step (if any): everything up to
          // and including it runs now, so its raw output can join a
          // residual-allocation group with every OTHER lease drawing from
          // the same pool+category+segment; everything after it is
          // deferred until the group's residual correction is known.
          // Policies with no CALCULATE_SHARE step (DIRECT_ASSIGN-only,
          // exclusion-only) have nothing to reconcile against a shared
          // pool total, so they run to completion immediately.
          const sortedSteps = [...policy.steps].sort((a, b) => a.sequence - b.sequence);
          const shareIdx = sortedSteps.findIndex((s) => s.step_type === "CALCULATE_SHARE");

          if (shareIdx === -1) {
            const stepResult = runPolicySteps(policy.steps, inputAmount, ctx);
            exceptions.push(...stepResult.exceptions);
            lines.push(...stepResult.lines);
            pendingContributions.push({ leaseId: lease.id, groupKey: null, rawShareAmount: stepResult.finalAmount, shareLines: [], shareExceptions: [], remainingSteps: [], ctx });
            continue;
          }

          const shareOnlyResult = runPolicySteps(sortedSteps.slice(0, shareIdx + 1), inputAmount, ctx);
          pendingContributions.push({
            leaseId: lease.id, groupKey: `${pool.id}|${categoryKey}|${key}`, rawShareAmount: shareOnlyResult.finalAmount,
            shareLines: shareOnlyResult.lines, shareExceptions: shareOnlyResult.exceptions,
            remainingSteps: sortedSteps.slice(shareIdx + 1), ctx,
          });
        }
      }
    }
  }

  // ---- Residual allocation (Workstream B.3): group pending share
  // contributions by (pool, category, segment); a group of 2+ leases has
  // its naive rounding reconciled back to the group's own exact total via
  // deterministic largest-remainder allocation. A group of exactly one
  // lease is left byte-for-byte as computed above — there is no residual
  // concept for a single recipient, and this also guarantees every
  // existing single-lease-per-pool scenario is completely unaffected. ----
  const residualGroups = new Map<string, PendingContribution[]>();
  for (const pc of pendingContributions) {
    if (pc.groupKey === null) continue;
    const list = residualGroups.get(pc.groupKey) ?? [];
    list.push(pc);
    residualGroups.set(pc.groupKey, list);
  }

  // Phase 5 rounding correction — residual allocation NO LONGER runs here.
  //
  // It previously ran per (pool, category, SEGMENT): it rounded each tenant's
  // segment share to ledger precision and fed that ROUNDED value into the
  // remaining policy steps. With twelve monthly segments that injected ledger
  // rounding twelve times per pool, mid-calculation, and the errors compounded
  // through base-year, cap and fee steps — the source of the observed annual
  // drift.
  //
  // The authoritative rule is now: intermediate values stay at full precision,
  // aggregation happens at lease + pool + period, rounding happens ONCE at
  // that boundary, and largest-remainder allocation is used ONLY to distribute
  // that already-rounded authoritative total among its child lines. That work
  // now happens in the boundary block below.
  //
  // residualGroups is still built above because it is what marks a contribution
  // as belonging to a shared pool; it simply no longer mutates any amount.
  void residualGroups;

  // ---- Finalize: run each contribution's remaining steps (from its
  // possibly-residual-corrected share), accumulate per lease at FULL
  // INTERNAL PRECISION — never round mid-accumulation. Rounding to
  // ledger precision happens ONCE at the configured annual boundary
  // (LEASE_POOL_PERIOD by default) in the lease-result loop below. ----
  //
  // Phase 4B rounding correction: the previous implementation called
  // roundTo(..., ledgerPlaces) inside stepResult and then added those
  // already-rounded values together, making the annual total a
  // sum-of-rounded-parts. This produces a different (and incorrect)
  // result from the single-boundary rounding that lease contracts
  // specify — especially visible in multi-segment, multi-pool scenarios
  // (e.g. mid-year effective-date changes). The fix: accumulate at
  // internalPlaces precision, round exactly once at the annual boundary.
  //
  // annualRecoveryByLease stores UNROUNDED internal-precision totals.
  // Every contribution now runs its remaining steps from its OWN full-precision
  // share. Nothing is rounded here, and nothing is rounded between steps.
  // Accumulation is keyed by the configured aggregation boundary.
  const boundaryScope = annualRoundingScope(input.run.rounding_policy);
  // LEASE_POOL_PERIOD (default) aggregates per lease per pool; LEASE_PERIOD
  // aggregates a lease across all its pools. Both round exactly once.
  const boundaryKeyFor = (leaseId: string, poolId: string | null) =>
    boundaryScope === "LEASE_PERIOD" ? `${leaseId}|__all_pools__` : `${leaseId}|${poolId ?? "__no_pool__"}`;

  interface BoundaryBucket { leaseId: string; poolId: string | null; raw: number; }
  const boundaryBuckets = new Map<string, BoundaryBucket>();

  for (const pc of pendingContributions) {
    exceptions.push(...pc.shareExceptions);
    lines.push(...pc.shareLines);

    let contribution: number;
    if (pc.groupKey === null) {
      contribution = pc.rawShareAmount;
    } else {
      const stepResult = runPolicySteps(pc.remainingSteps, pc.rawShareAmount, pc.ctx);
      exceptions.push(...stepResult.exceptions);
      lines.push(...stepResult.lines);
      contribution = stepResult.finalAmount;
    }

    const bKey = boundaryKeyFor(pc.leaseId, pc.ctx.poolId ?? null);
    const bucket = boundaryBuckets.get(bKey) ?? { leaseId: pc.leaseId, poolId: pc.ctx.poolId ?? null, raw: 0 };
    bucket.raw += contribution; // full precision — never rounded here
    boundaryBuckets.set(bKey, bucket);
  }

  // ---- THE rounding boundary. Round once per (lease, pool, period), and use
  // largest-remainder ONLY to distribute the already-rounded authoritative
  // pool total across the leases sharing it, so that
  //     SUM(round(lease_pool_i)) == round(SUM(lease_pool_i))
  // for every pool, with a deterministic, reproducible tie-break. ----
  const roundedByBoundary = new Map<string, { rounded: number; raw: number; residual: number }>();
  const bucketsByPool = new Map<string, BoundaryBucket[]>();
  for (const b of boundaryBuckets.values()) {
    const poolKey = b.poolId ?? "__no_pool__";
    const list = bucketsByPool.get(poolKey) ?? [];
    list.push(b);
    bucketsByPool.set(poolKey, list);
  }

  for (const [poolKey, members] of bucketsByPool) {
    // Deterministic ordering so repeated runs allocate residuals identically.
    members.sort((a, b) => a.leaseId.localeCompare(b.leaseId));
    const authoritativeTotal = roundTo(members.reduce((s, m) => s + m.raw, 0), ledgerPlaces);
    const { results } = applyLargestRemainderAllocation(
      members.map((m) => ({ key: m.leaseId, rawAmount: m.raw })),
      authoritativeTotal, ledgerPlaces,
    );
    results.forEach((r, i) => {
      const m = members[i]; // applyLargestRemainderAllocation preserves input order
      const key = boundaryKeyFor(m.leaseId, m.poolId);
      roundedByBoundary.set(key, { rounded: r.finalAmount, raw: m.raw, residual: roundTo(r.finalAmount - m.raw, internalPlaces) });

      if (r.residualAdjustment !== 0) {
        lines.push({
          lease_id: m.leaseId, pool_id: m.poolId, sequence: 0, line_type: "RESIDUAL_ALLOCATION", category: null,
          formula_code: "LARGEST_REMAINDER",
          input_amount: r.naiveRoundedAmount, output_amount: r.finalAmount, adjustment: r.residualAdjustment,
          policy_step_id: null,
          explanation:
            `Deterministic largest-remainder allocation at ${boundaryScope}: ${r.residualAdjustment > 0 ? "added" : "removed"} ` +
            `${Math.abs(r.residualAdjustment)} so the ${members.length} leases sharing pool ${poolKey} sum exactly to the ` +
            `rounded authoritative total ${authoritativeTotal}. Applied to an already-rounded total only — never mid-calculation.`,
          segment_start: input.recovery_period.start_date, segment_end: input.recovery_period.end_date,
          unrounded_aggregate: m.raw, rounding_scope: boundaryScope,
          rounded_amount: r.finalAmount, rounding_residual: r.residualAdjustment,
          rounding_policy: roundingPolicyDisclosure,
        });
      }
    });
  }

  // Lease annual recovery = sum of its rounded (lease, pool, period) amounts.
  const annualRecoveryByLease = new Map<string, number>();
  const unroundedByLease = new Map<string, number>();
  for (const [key, v] of roundedByBoundary) {
    const leaseId = key.split("|")[0];
    annualRecoveryByLease.set(leaseId, roundTo((annualRecoveryByLease.get(leaseId) ?? 0) + v.rounded, ledgerPlaces));
    unroundedByLease.set(leaseId, (unroundedByLease.get(leaseId) ?? 0) + v.raw);
  }

  const leaseResults: LeaseResult[] = [];
  const scopeLabel = annualRoundingScope(input.run.rounding_policy);

  for (const lease of input.leases) {
    // The unrounded aggregate: full internal precision accumulated above.
    const unroundedAggregate = unroundedByLease.get(lease.id) ?? 0;

    // Round ONCE at the configured annual boundary (LEASE_POOL_PERIOD by
    // default — per Phase 4B decision 1). Monthly estimate charges are
    // always rounded at MONTH inside reconcileEstimates, independent of
    // this boundary.
    // Already rounded once at the boundary above (and residual-allocated
    // there). Do NOT round again — this is a sum of ledger-precision values.
    const annualRecovery = annualRecoveryByLease.get(lease.id) ?? 0;
    const residualAdjustment = roundTo(annualRecovery - unroundedAggregate, internalPlaces);

    // Emit the mandatory ROUNDING_DETAIL line so the ledger is always
    // self-explaining: unrounded aggregate, scope, rounded amount, residual.
    lines.push({
      lease_id: lease.id, pool_id: null, sequence: 0,
      line_type: "ROUNDING_DETAIL",
      category: null,
      formula_code: "ANNUAL_BOUNDARY_ROUND",
      input_amount: unroundedAggregate,
      output_amount: annualRecovery,
      adjustment: residualAdjustment,
      policy_step_id: null,
      explanation: `Annual CAM recovery rounded once at ${scopeLabel}: unrounded aggregate ${unroundedAggregate} → ${annualRecovery}` +
        (residualAdjustment !== 0 ? ` (residual ${residualAdjustment > 0 ? "+" : ""}${residualAdjustment})` : " (exact, no residual)") +
        `. No intermediate policy step was rounded; ledger precision is applied at this boundary only.`,
      unrounded_aggregate: unroundedAggregate,
      rounding_scope: scopeLabel,
      rounded_amount: annualRecovery,
      rounding_residual: residualAdjustment,
      rounding_policy: roundingPolicyDisclosure,
      segment_start: input.recovery_period.start_date,
      segment_end: input.recovery_period.end_date,
    });

    const { result: reconciliation, exceptions: reconExceptions } = reconcileEstimates(
      lease.id, input.recovery_period.id, annualRecovery, input.estimate_schedules, input.prior_period_adjustments,
      input.recovery_period.start_date, input.recovery_period.end_date, input.run.run_mode,
    );
    exceptions.push(...reconExceptions);
    lines.push({ ...reconciliation.line, sequence: 0 });

    leaseResults.push({
      lease_id: lease.id, final_recovery: annualRecovery,
      estimates_billed: reconciliation.estimatesBilled, amount_due_credit: reconciliation.amountDueOrCredit,
    });
  }

  // Deterministic, stable sequence assignment across the whole run — sorted
  // by (segment_start, pool_id, lease_id, original emission order) so two
  // runs against the identical snapshot always produce identical sequence
  // numbers, never relying on the module-level counter inside
  // policy-step-runner.ts (which is process-lifetime, not run-scoped, and
  // must not leak into the persisted ordering).
  const orderedLines = lines
    .map((line, originalIndex) => ({ line, originalIndex }))
    .sort((a, b) => {
      const byDate = compareDates(a.line.segment_start, b.line.segment_start);
      if (byDate !== 0) return byDate;
      const byPool = (a.line.pool_id ?? "").localeCompare(b.line.pool_id ?? "");
      if (byPool !== 0) return byPool;
      const byLease = (a.line.lease_id ?? "").localeCompare(b.line.lease_id ?? "");
      if (byLease !== 0) return byLease;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ line }, i) => ({ ...line, sequence: i + 1 }));

  const blockingCount = exceptions.filter((e) => e.severity === "blocking").length;

  return {
    input_hash,
    pool_results: poolResults,
    lease_results: leaseResults,
    calculation_lines: orderedLines,
    exceptions,
    ready_to_post: blockingCount === 0,
  };
}
