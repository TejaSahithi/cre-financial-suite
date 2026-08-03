// @ts-nocheck
/**
 * Canonical snapshot-series identity.
 *
 * A "snapshot series" is the logical timeline of computation_snapshots rows
 * that supersede one another over time for one calculation: the same
 * organization, property, engine, scope, and calculation period. This
 * module is the single place that defines what fields make up that
 * identity and how they're normalized — every function that needs to
 * filter, lock, or publish against a series (compute-cam's lock/historical/
 * prior-year lookups, _shared/snapshot.ts's publish flow) builds its query
 * from this, instead of each repeating its own ".eq(...).eq(...)..." chain.
 *
 * The database-side canonical implementation is
 * public.publish_computation_snapshot() (see
 * 20260902000000_snapshot_publish_rpc.sql) — it derives the same field set
 * for its advisory-lock key and row match. This module and that function
 * must stay in agreement on what fields participate in a series identity;
 * they do not share code (different runtimes) but must stay field-for-field
 * consistent. _tests/snapshot-identity-consistency.test.ts asserts this
 * agreement against the live database schema/function rather than just
 * trusting these comments.
 *
 * Period model — why `month` is here and why it's not `period_start`/
 * `period_end`:
 *   Audited every engine_type that exists in this repo (cam, budget,
 *   expense, revenue, reconciliation, lease) as of this review. Every one
 *   of them computes exactly one snapshot per (scope, fiscal_year) — a
 *   single ANNUAL result. Several embed a month-by-month breakdown *inside*
 *   that one snapshot's `outputs` (compute-revenue's monthly_projections,
 *   compute-lease's current_fy_months, compute-reconciliation's
 *   monthly_breakdown, compute-expense's monthly_breakdown) — none of them
 *   create a separate computation_snapshots ROW per month. So `month` is
 *   NOT required by any engine in current use, and is NOT added to every
 *   caller. It exists here, nullable, defaulting to null (= annual), for
 *   two concrete reasons: (1) computation_snapshots.month is already a real
 *   column, added before this review, currently unpopulated by every
 *   engine — leaving the identity model unaware of it would be a
 *   known-but-ignored landmine, not an absence of the concept; (2) a future
 *   engine that DOES need monthly granularity should not require another
 *   migration through every layer (identity, advisory-lock key, RPC,
 *   unique index, lookups) to get correct concurrency-safe publication —
 *   it should just start passing `month` and get the same guarantees for
 *   free. `period_start`/`period_end` (arbitrary date ranges) were
 *   considered and rejected: no engine, current or evidently planned,
 *   models its period as anything other than (fiscal_year, optional
 *   1-12 month) — every engine that deals with months already represents
 *   them as plain integers internally. Introducing a date-range period
 *   model would be speculative complexity with no grounding in actual
 *   engine behavior.
 */

export interface SnapshotSeriesIdentity {
  org_id: string;
  property_id: string | null;
  engine_type: string;
  scope_level: string | null;
  scope_id: string | null;
  fiscal_year: number;
  /** 1-12, or null for an annual (whole fiscal-year) series. Null for every engine as of this review — see module docblock. */
  month: number | null;
}

/**
 * Builds a normalized SnapshotSeriesIdentity. Throws on anything that would
 * make the identity ambiguous (missing org_id/engine_type, a non-finite
 * fiscal_year, an out-of-range month) rather than silently coercing — the
 * same fail-closed posture as _shared/scope.ts's assertValidScopeHierarchy
 * and _shared/snapshot.ts's resolveSnapshotScope.
 */
export function buildSnapshotSeriesIdentity(input: {
  org_id: string;
  property_id?: string | null;
  engine_type: string;
  scope_level?: string | null;
  scope_id?: string | null;
  fiscal_year: number;
  month?: number | null;
}): SnapshotSeriesIdentity {
  const orgId = typeof input.org_id === "string" ? input.org_id.trim() : "";
  if (!orgId) {
    throw new Error("buildSnapshotSeriesIdentity: org_id is required");
  }

  const engineType = typeof input.engine_type === "string" ? input.engine_type.trim() : "";
  if (!engineType) {
    throw new Error("buildSnapshotSeriesIdentity: engine_type is required");
  }

  const fiscalYear = Number(input.fiscal_year);
  if (!Number.isFinite(fiscalYear)) {
    throw new Error(`buildSnapshotSeriesIdentity: fiscal_year must be a finite number, got "${input.fiscal_year}"`);
  }

  let month: number | null = null;
  if (input.month !== undefined && input.month !== null) {
    const m = Number(input.month);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new Error(`buildSnapshotSeriesIdentity: month must be an integer 1-12 or null/omitted for an annual series, got "${input.month}"`);
    }
    month = m;
  }

  const propertyId = input.property_id ? String(input.property_id) : null;
  const scopeLevel = input.scope_level ? String(input.scope_level) : null;
  const scopeId = input.scope_id ? String(input.scope_id) : null;

  return {
    org_id: orgId,
    property_id: propertyId,
    engine_type: engineType,
    scope_level: scopeLevel,
    scope_id: scopeId,
    fiscal_year: Math.trunc(fiscalYear),
    month,
  };
}

/**
 * Applies everything about a SnapshotSeriesIdentity EXCEPT fiscal_year —
 * i.e. "this exact org/property/engine/scope/month, any fiscal year" — as
 * filters on a Supabase query builder, handling the null-safety that plain
 * .eq() gets wrong for property_id/scope_level/scope_id/month (all
 * legitimately nullable).
 *
 * `month` is deliberately included here (not treated like fiscal_year) —
 * for a historical/prior-period comparison you want the SAME month fixed
 * across years (e.g. "March 2026 vs March 2025"), not "any month in the
 * prior year"; it behaves like a scope-narrowing field, not like the
 * dimension that legitimately varies across a historical range.
 *
 * Split out from applySnapshotSeriesFilter for lookups that need a
 * fiscal-year range rather than an exact match (compute-cam's
 * historical-years lookup uses .in("fiscal_year", [...])).
 */
export function applySnapshotSeriesScopeFilter<Q extends {
  eq: (col: string, val: unknown) => Q;
  is: (col: string, val: null) => Q;
}>(query: Q, identity: Omit<SnapshotSeriesIdentity, "fiscal_year">): Q {
  let q = query.eq("org_id", identity.org_id).eq("engine_type", identity.engine_type);
  q = identity.property_id ? q.eq("property_id", identity.property_id) : q.is("property_id", null);
  q = identity.scope_level ? q.eq("scope_level", identity.scope_level) : q.is("scope_level", null);
  q = identity.scope_id ? q.eq("scope_id", identity.scope_id) : q.is("scope_id", null);
  q = identity.month != null ? q.eq("month", identity.month) : q.is("month", null);
  return q;
}

/**
 * Applies a SnapshotSeriesIdentity (including an exact fiscal_year match)
 * as filters on a Supabase query builder.
 *
 * Used for read-side lookups that need to match "this exact series"
 * (compute-cam's lock check, prior-year lookup) so the field list lives in
 * one place instead of being repeated at each call site.
 */
export function applySnapshotSeriesFilter<Q extends {
  eq: (col: string, val: unknown) => Q;
  is: (col: string, val: null) => Q;
}>(query: Q, identity: SnapshotSeriesIdentity): Q {
  return applySnapshotSeriesScopeFilter(query, identity).eq("fiscal_year", identity.fiscal_year);
}

/**
 * The complete, ordered list of column names that make up a snapshot
 * series identity at the database level. Used by
 * _tests/snapshot-identity-consistency.test.ts to assert this list matches
 * both the live partial unique index's indexed columns and
 * publish_computation_snapshot's parameter list — a single source of truth
 * for "what fields participate in identity" that a test can check against
 * reality instead of trusting a comment.
 */
export const SNAPSHOT_SERIES_IDENTITY_COLUMNS = [
  "org_id",
  "property_id",
  "engine_type",
  "scope_level",
  "scope_id",
  "fiscal_year",
  "month",
] as const;
