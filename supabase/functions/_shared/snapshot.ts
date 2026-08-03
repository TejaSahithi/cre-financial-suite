// @ts-nocheck
/**
 * Snapshot helper - preserves history while always making the latest row queryable.
 *
 * Strategy:
 *   1. Mark any existing row for the same logical compute scope as status='superseded'.
 *   2. INSERT a brand-new row with normalized inputs/outputs and deterministic metadata.
 *
 * Scope note:
 *   Some engines, such as CAM, persist property-, building-, and unit-level snapshots
 *   under the same (org, property, engine, fiscal_year) tuple. We therefore supersede
 *   by logical scope, not by property/year alone. See resolveSnapshotScope below for
 *   the exact rules on how a run's scope is determined and validated.
 */

import { LEGACY_SCOPE_DEFAULT_ENGINES, SCOPE_LEVELS } from "./scope.ts";
import { applySnapshotSeriesFilter, buildSnapshotSeriesIdentity } from "./snapshot-identity.ts";

export interface SnapshotData {
  org_id: string;
  property_id: string | null;
  engine_type: string;
  fiscal_year: number;
  /**
   * 1-12, or omitted/null for an annual series. No engine in this repo sets
   * this today (all six are annual — see _shared/snapshot-identity.ts's
   * docblock for the full audit); present for the first engine that needs
   * monthly-granularity publication to opt into without another migration.
   */
  month?: number | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  computed_by?: string;
  engine_version?: string;
  locked_at?: string | null;
  locked_by?: string | null;
}

function normalizeForSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForSnapshot);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeForSnapshot((value as Record<string, unknown>)[key]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForSnapshot(value));
}

export async function computeInputFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface ResolvedSnapshotScope {
  scope_level: string | null;
  scope_id: string | null;
}

function readPresentKey(obj: Record<string, unknown> | undefined | null, key: string): unknown {
  if (!obj || typeof obj !== "object" || !(key in obj)) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return value === null || value === undefined || String(value).trim() === "" ? undefined : value;
}

/**
 * Resolves the scope_level/scope_id to persist as real DB columns on
 * computation_snapshots (and to key supersede/idempotency matching by),
 * given an engine's raw inputs/outputs plus the property_id and
 * engine_type of the run being saved.
 *
 * Deliberately strict — an invalid or missing scope is a fail-closed error,
 * never silently coerced to "property":
 *   - scope_level "portfolio" (a budget-specific scope — see
 *     _shared/budget-scope.ts — deliberately NOT part of SCOPE_LEVELS,
 *     which is CAM/lease's property|building|unit enum): requires NO
 *     property_id (a portfolio has no single parent property) and a
 *     scope_id. Checked before the "no propertyId" branch below, since
 *     portfolio scope is exactly the "no property_id" case that branch
 *     would otherwise treat as "no scope at all".
 *   - No property_id at all, and scope_level isn't "portfolio" (org-level
 *     snapshot) -> {null, null}. There is no hierarchy node to scope under.
 *   - scope_level is explicitly present (a non-empty value) in inputs or
 *     outputs:
 *       - an unrecognized value -> throws. Never silently defaulted.
 *       - "property" with a scope_id that isn't exactly propertyId -> throws.
 *       - "building"/"unit" with no scope_id -> throws.
 *       - otherwise used verbatim.
 *   - scope_level is absent entirely:
 *       - engine_type is a documented legacy engine (see
 *         LEGACY_SCOPE_DEFAULT_ENGINES in _shared/scope.ts) -> defaults to
 *         {property, propertyId}.
 *       - any other engine_type -> throws. "cam" and "lease" both always
 *         provide an explicit scope by the time they call saveSnapshot; a
 *         missing scope from either indicates a bug upstream, not a
 *         legacy gap, and must surface as an error rather than be papered
 *         over here.
 */
export function resolveSnapshotScope(
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  propertyId: string | null,
  engineType: string,
): ResolvedSnapshotScope {
  const rawLevel = readPresentKey(inputs, "scope_level") ?? readPresentKey(outputs, "scope_level");
  const rawId = readPresentKey(inputs, "scope_id") ?? readPresentKey(outputs, "scope_id");

  if (rawLevel === "portfolio") {
    if (propertyId) {
      throw new Error(`Invalid scope: scope_level "portfolio" must not be paired with a property_id.`);
    }
    if (rawId === undefined) {
      throw new Error(`Invalid scope: scope_id is required when scope_level is "portfolio".`);
    }
    return { scope_level: "portfolio", scope_id: String(rawId) };
  }

  if (!propertyId) {
    return { scope_level: null, scope_id: null };
  }

  if (rawLevel === undefined) {
    if (LEGACY_SCOPE_DEFAULT_ENGINES.has(engineType)) {
      return { scope_level: "property", scope_id: propertyId };
    }
    throw new Error(
      `Missing scope_level for engine_type "${engineType}" — only documented legacy engines ` +
      `(${Array.from(LEGACY_SCOPE_DEFAULT_ENGINES).join(", ")}) may omit scope and default to ` +
      `property scope. "${engineType}" is expected to always provide an explicit scope_level/scope_id.`,
    );
  }

  const level = String(rawLevel);
  if (!(SCOPE_LEVELS as string[]).includes(level)) {
    throw new Error(
      `Invalid explicit scope_level "${level}" for engine_type "${engineType}" — must be one of: ` +
      `${SCOPE_LEVELS.join(", ")}. Refusing to silently default to "property".`,
    );
  }

  if (level === "property") {
    const id = rawId === undefined ? propertyId : String(rawId);
    if (id !== propertyId) {
      throw new Error(
        `Invalid scope: scope_id ("${id}") must equal property_id ("${propertyId}") when scope_level is "property".`,
      );
    }
    return { scope_level: "property", scope_id: propertyId };
  }

  // building | unit
  if (rawId === undefined) {
    throw new Error(`Invalid scope: scope_id is required when scope_level is "${level}".`);
  }
  return { scope_level: level, scope_id: String(rawId) };
}

function formatScopeKey(scope: ResolvedSnapshotScope): string {
  return `${scope.scope_level ?? "none"}:${scope.scope_id ?? "none"}`;
}

async function enrichInputs(inputs: Record<string, unknown>) {
  const normalizedInputs = (normalizeForSnapshot(inputs ?? {}) ?? {}) as Record<string, unknown>;
  const existingMeta =
    normalizedInputs._compute && typeof normalizedInputs._compute === "object"
      ? { ...(normalizedInputs._compute as Record<string, unknown>) }
      : {};

  if (!existingMeta.input_fingerprint) {
    existingMeta.input_fingerprint = await computeInputFingerprint(normalizedInputs);
  }

  return {
    ...normalizedInputs,
    _compute: existingMeta,
  };
}

export async function findMatchingCompletedSnapshot(
  supabaseAdmin: any,
  data: SnapshotData,
) {
  const inputs = await enrichInputs(data.inputs);
  const outputs = (normalizeForSnapshot(data.outputs ?? {}) ?? {}) as Record<string, unknown>;
  const targetScope = resolveSnapshotScope(inputs, outputs, data.property_id ?? null, data.engine_type);
  const targetScopeKey = formatScopeKey(targetScope);
  const targetFingerprint = String(
    (inputs._compute as Record<string, unknown>)?.input_fingerprint ?? "",
  );
  const identity = buildSnapshotSeriesIdentity({
    org_id: data.org_id,
    property_id: data.property_id ?? null,
    engine_type: data.engine_type,
    scope_level: targetScope.scope_level,
    scope_id: targetScope.scope_id,
    fiscal_year: data.fiscal_year,
    month: data.month ?? null,
  });

  const baseQuery = supabaseAdmin
    .from("computation_snapshots")
    .select("id, property_id, scope_level, scope_id, inputs, outputs, computed_at, status")
    .eq("status", "completed");
  // Full series identity applied in one place (see _shared/snapshot-identity.ts)
  // instead of each caller repeating its own org/property/engine/scope/year
  // filter chain.
  const query = applySnapshotSeriesFilter(baseQuery, identity);

  const { data: candidates, error } = await query.order("computed_at", { ascending: false });
  if (error || !candidates?.length) {
    return null;
  }

  return candidates.find((candidate: any) => {
    // Candidates are read directly from their own scope_level/scope_id
    // columns (authoritative post-migration — every row is backfilled),
    // not re-derived from their inputs/outputs JSONB.
    const candidateScopeKey = formatScopeKey({
      scope_level: candidate?.scope_level ?? null,
      scope_id: candidate?.scope_id ?? null,
    });
    const candidateInputs = (candidate?.inputs ?? {}) as Record<string, unknown>;
    const candidateFingerprint = String(
      candidateInputs?._compute?.input_fingerprint ?? "",
    );
    return candidateScopeKey === targetScopeKey && candidateFingerprint === targetFingerprint;
  }) ?? null;
}

/**
 * Publish a computation snapshot, preserving previous runs as 'superseded'.
 *
 * Publication happens through the public.publish_computation_snapshot()
 * Postgres RPC (20260902000000_snapshot_publish_rpc.sql), which runs the
 * whole read-current -> reuse-or-supersede -> insert sequence as one
 * transaction serialized per snapshot series by a transaction-level
 * advisory lock, backstopped by a partial unique index (at most one
 * status='completed' row per series). This function must NOT go back to a
 * select-then-insert flow — that was the exact race this RPC replaces
 * (concurrent identical requests could each pass a "no existing row" check
 * before either had inserted, producing duplicate completed rows; see
 * _tests/snapshot-publish-concurrency.test.ts).
 *
 * @returns The id of the published (reused or newly created) snapshot row, or null on error.
 */
export async function saveSnapshot(
  supabaseAdmin: any,
  data: SnapshotData,
): Promise<string | null> {
  const inputs = await enrichInputs(data.inputs);
  const outputs = (normalizeForSnapshot(data.outputs ?? {}) ?? {}) as Record<string, unknown>;
  const targetScope = resolveSnapshotScope(inputs, outputs, data.property_id ?? null, data.engine_type);
  const identity = buildSnapshotSeriesIdentity({
    org_id: data.org_id,
    property_id: data.property_id ?? null,
    engine_type: data.engine_type,
    scope_level: targetScope.scope_level,
    scope_id: targetScope.scope_id,
    fiscal_year: data.fiscal_year,
    month: data.month ?? null,
  });

  // Extract the SHA-256 fingerprint already computed by enrichInputs so it is
  // also stored in the top-level input_hash column for direct SQL querying.
  const inputHash =
    String((inputs._compute as Record<string, unknown>)?.input_fingerprint ?? "") || null;

  const startedAt = (globalThis.performance ?? Date).now();
  const { data: rows, error } = await supabaseAdmin.rpc("publish_computation_snapshot", {
    p_org_id: identity.org_id,
    p_property_id: identity.property_id,
    p_engine_type: identity.engine_type,
    p_scope_level: identity.scope_level,
    p_scope_id: identity.scope_id,
    p_fiscal_year: identity.fiscal_year,
    p_month: identity.month,
    p_engine_version: data.engine_version ?? null,
    p_input_hash: inputHash,
    p_inputs: inputs,
    p_outputs: outputs,
    p_computed_by: data.computed_by ?? null,
    p_locked_at: data.locked_at ?? null,
    p_locked_by: data.locked_by ?? null,
  });
  const durationMs = Math.round((globalThis.performance ?? Date).now() - startedAt);

  if (error) {
    // Structured failure log — see the module docblock's "metrics" note.
    console.error(JSON.stringify({
      event: "snapshot_publish_failed",
      engine_type: identity.engine_type,
      org_id: identity.org_id,
      property_id: identity.property_id,
      scope_level: identity.scope_level,
      scope_id: identity.scope_id,
      fiscal_year: identity.fiscal_year,
      month: identity.month,
      duration_ms: durationMs,
      error: error.message,
    }));
    return null;
  }

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.id) {
    console.error(JSON.stringify({
      event: "snapshot_publish_failed",
      engine_type: identity.engine_type,
      org_id: identity.org_id,
      property_id: identity.property_id,
      scope_level: identity.scope_level,
      scope_id: identity.scope_id,
      fiscal_year: identity.fiscal_year,
      month: identity.month,
      duration_ms: durationMs,
      error: "RPC returned no row",
    }));
    return null;
  }

  // Structured success log: reused | created (+ superseded_snapshot_id when
  // a prior completed row for this series was superseded). Lock wait
  // duration is approximated by total RPC round-trip time — under
  // contention this is dominated by the transaction-level advisory lock
  // wait inside publish_computation_snapshot; it also includes normal
  // network/DB execution time, so treat it as an upper bound, not a
  // lock-only measurement.
  console.log(JSON.stringify({
    event: row.publish_action === "reused" ? "snapshot_reused" : "snapshot_created",
    engine_type: identity.engine_type,
    org_id: identity.org_id,
    property_id: identity.property_id,
    scope_level: identity.scope_level,
    scope_id: identity.scope_id,
    fiscal_year: identity.fiscal_year,
    month: identity.month,
    snapshot_id: row.id,
    superseded_snapshot_id: row.superseded_snapshot_id ?? null,
    duration_ms: durationMs,
  }));

  return row.id ?? null;
}
