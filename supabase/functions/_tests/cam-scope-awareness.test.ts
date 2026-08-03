// @ts-nocheck
/**
 * PR-4: CAM computation snapshots, locks, historical/prior-year lookups,
 * and cam_calculations summaries become scope-aware
 * (property | building | unit), each identified by scope_level + scope_id
 * + the parent property_id — see _shared/scope.ts and
 * 20260901000000_cam_scope_columns.sql.
 *
 * This suite exercises the REAL implementations (_shared/scope.ts's
 * assertValidScopeHierarchy, _shared/snapshot.ts's saveSnapshot /
 * findMatchingCompletedSnapshot / resolveSnapshotScope) against an
 * in-memory fake Supabase admin client, plus reproductions of the exact
 * query chains now embedded in compute-cam/index.ts (which cannot be
 * imported directly here — Deno.serve() runs as an import-time side
 * effect, the same reason every other Edge-Function test in this repo
 * tests logic via extracted/reproduced pure chains rather than importing
 * index.ts — see reconciliation.test.ts, budget-line-items.property.test.ts).
 */

import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertValidScopeHierarchy } from "../_shared/scope.ts";
import {
  saveSnapshot,
  findMatchingCompletedSnapshot,
  resolveSnapshotScope,
} from "../_shared/snapshot.ts";

// ---------------------------------------------------------------------------
// In-memory fake Supabase admin client.
//
// Supports the subset of the query-builder API this test needs:
//   .from(table).select(cols).eq()/.in()/.is()/.not()
//     .order().limit().maybeSingle()/.single() -> {data, error}
//   .from(table).insert(row).select(cols).single() -> {data, error}
//   .from(table).update(patch).eq()/.in() -> {error}
//   .from(table).upsert(row, {onConflict}) -> {data, error}
// ---------------------------------------------------------------------------
function makeFakeAdmin(seed: Record<string, any[]>) {
  const tables: Record<string, any[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  let idCounter = 1;

  function selectBuilder(table: string, rows: any[]) {
    let filtered = [...rows];
    const builder: any = {
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: any[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      is(col: string, val: null) {
        filtered = filtered.filter((r) => r[col] === val || r[col] === undefined);
        return builder;
      },
      not(col: string, op: string, val: null) {
        // Only "is" null negation is used in this codebase.
        filtered = filtered.filter((r) => !(r[col] === val || r[col] === undefined));
        return builder;
      },
      order(col: string, opts: { ascending: boolean } = { ascending: true }) {
        filtered = [...filtered].sort((a, b) => {
          const av = a[col] ?? "";
          const bv = b[col] ?? "";
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return opts.ascending ? cmp : -cmp;
        });
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      maybeSingle() {
        if (filtered.length > 1) {
          return Promise.resolve({ data: null, error: { message: "multiple rows returned" } });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        if (filtered.length !== 1) {
          return Promise.resolve({ data: null, error: { message: "expected exactly one row" } });
        }
        return Promise.resolve({ data: filtered[0], error: null });
      },
      then(resolve: any) {
        // Allow `await query` without a terminal method (mirrors supabase-js).
        resolve({ data: filtered, error: null });
      },
    };
    return builder;
  }

  return {
    _tables: tables,
    from(table: string) {
      tables[table] = tables[table] ?? [];
      return {
        select(_cols?: string) {
          return selectBuilder(table, tables[table]);
        },
        insert(row: Record<string, any>) {
          const newRow = { id: row.id ?? `gen-${idCounter++}`, ...row };
          tables[table].push(newRow);
          return {
            select(_cols?: string) {
              return {
                single() {
                  return Promise.resolve({ data: newRow, error: null });
                },
              };
            },
          };
        },
        update(patch: Record<string, any>) {
          let targetRows: any[] = [];
          const builder: any = {
            in(col: string, vals: any[]) {
              targetRows = tables[table].filter((r) => vals.includes(r[col]));
              for (const r of targetRows) Object.assign(r, patch);
              return Promise.resolve({ error: null });
            },
            eq(col: string, val: any) {
              targetRows = tables[table].filter((r) => r[col] === val);
              for (const r of targetRows) Object.assign(r, patch);
              return Promise.resolve({ error: null });
            },
          };
          return builder;
        },
        upsert(row: Record<string, any>, opts: { onConflict: string }) {
          const conflictCols = opts.onConflict.split(",");
          const existing = tables[table].find((r) =>
            conflictCols.every((c) => r[c] === row[c])
          );
          if (existing) {
            Object.assign(existing, row);
          } else {
            tables[table].push({ id: `gen-${idCounter++}`, ...row });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    // Faithful in-memory simulation of
    // public.publish_computation_snapshot() (20260902000000_snapshot_
    // publish_rpc.sql) for computation_snapshots specifically — real
    // concurrency/transaction/rollback guarantees are covered against the
    // actual database in _tests/snapshot-publish-concurrency.test.ts; this
    // fake only needs to mirror the reuse-or-supersede-insert decision so
    // saveSnapshot's calling behavior (identity construction, response
    // interpretation) can be tested without a live database.
    rpc(name: string, params: Record<string, any>) {
      if (name !== "publish_computation_snapshot") {
        return Promise.resolve({ data: null, error: { message: `unmocked rpc: ${name}` } });
      }
      const table = (tables["computation_snapshots"] = tables["computation_snapshots"] ?? []);
      const matches = (r: any) =>
        r.org_id === params.p_org_id &&
        (r.property_id ?? null) === (params.p_property_id ?? null) &&
        r.engine_type === params.p_engine_type &&
        (r.scope_level ?? null) === (params.p_scope_level ?? null) &&
        (r.scope_id ?? null) === (params.p_scope_id ?? null) &&
        r.fiscal_year === params.p_fiscal_year &&
        (r.month ?? null) === (params.p_month ?? null) &&
        r.status === "completed";
      const current = table.find(matches);

      if (
        current &&
        current.input_hash != null &&
        current.input_hash === params.p_input_hash &&
        (current.engine_version ?? null) === (params.p_engine_version ?? null)
      ) {
        return Promise.resolve({ data: [{ ...current, publish_action: "reused", superseded_snapshot_id: null }], error: null });
      }

      let supersededId: string | null = null;
      if (current) {
        current.status = "superseded";
        supersededId = current.id;
      }

      if (params.p_outputs === null || params.p_inputs === null) {
        return Promise.resolve({ data: null, error: { message: "null value in column violates not-null constraint" } });
      }

      const newRow = {
        id: `gen-${idCounter++}`,
        org_id: params.p_org_id,
        property_id: params.p_property_id ?? null,
        engine_type: params.p_engine_type,
        fiscal_year: params.p_fiscal_year,
        month: params.p_month ?? null,
        scope_level: params.p_scope_level ?? null,
        scope_id: params.p_scope_id ?? null,
        inputs: params.p_inputs,
        outputs: params.p_outputs,
        status: "completed",
        computed_at: new Date().toISOString(),
        computed_by: params.p_computed_by ?? null,
        engine_version: params.p_engine_version ?? null,
        input_hash: params.p_input_hash ?? null,
        locked_at: params.p_locked_at ?? null,
        locked_by: params.p_locked_by ?? null,
      };
      table.push(newRow);
      return Promise.resolve({ data: [{ ...newRow, publish_action: "created", superseded_snapshot_id: supersededId }], error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// Shared fixture: one org, one property, two buildings, two units.
// ---------------------------------------------------------------------------
function seedHierarchy() {
  return {
    properties: [
      { id: "prop-1", org_id: "org-A" },
      { id: "prop-2", org_id: "org-B" }, // different org, for cross-org tests
    ],
    buildings: [
      { id: "bldg-1", org_id: "org-A", property_id: "prop-1" },
      { id: "bldg-2", org_id: "org-A", property_id: "prop-1" },
      { id: "bldg-foreign", org_id: "org-B", property_id: "prop-2" },
    ],
    units: [
      { id: "unit-1", org_id: "org-A", property_id: "prop-1", building_id: "bldg-1" },
      { id: "unit-2", org_id: "org-A", property_id: "prop-1", building_id: "bldg-2" },
      { id: "unit-foreign", org_id: "org-B", property_id: "prop-2", building_id: "bldg-foreign" },
    ],
  };
}

// ===========================================================================
// PART A — assertValidScopeHierarchy (real implementation)
// ===========================================================================

Deno.test("Hierarchy: valid property scope passes", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  const result = await assertValidScopeHierarchy(admin, "org-A", "prop-1", "property", "prop-1");
  assertEquals(result, { scope_level: "property", scope_id: "prop-1", property_id: "prop-1" });
});

Deno.test("Hierarchy: valid building scope (belongs to property+org) passes", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  const result = await assertValidScopeHierarchy(admin, "org-A", "prop-1", "building", "bldg-1");
  assertEquals(result, { scope_level: "building", scope_id: "bldg-1", property_id: "prop-1" });
});

Deno.test("Hierarchy: valid unit scope (belongs to property+org) passes", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  const result = await assertValidScopeHierarchy(admin, "org-A", "prop-1", "unit", "unit-2");
  assertEquals(result, { scope_level: "unit", scope_id: "unit-2", property_id: "prop-1" });
});

Deno.test("Hierarchy: fails closed for an invalid scope_level string", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  await assertRejects(
    () => assertValidScopeHierarchy(admin, "org-A", "prop-1", "portfolio", "prop-1"),
    Error,
    "Invalid scope_level",
  );
});

Deno.test("Hierarchy: fails closed when property scope_id does not equal property_id", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  await assertRejects(
    () => assertValidScopeHierarchy(admin, "org-A", "prop-1", "property", "some-other-id"),
    Error,
    "scope_id must equal property_id",
  );
});

Deno.test("Hierarchy: fails closed when scope_id is missing at building level", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  await assertRejects(
    () => assertValidScopeHierarchy(admin, "org-A", "prop-1", "building", ""),
    Error,
    "scope_id is required",
  );
});

Deno.test("Hierarchy: fails closed for a building belonging to a DIFFERENT property", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  // bldg-foreign belongs to prop-2, not prop-1 — invalid even within the
  // same org check alone, this proves the property_id join matters.
  const seeded = seedHierarchy();
  seeded.buildings.push({ id: "bldg-cross-property", org_id: "org-A", property_id: "prop-2" });
  const admin2 = makeFakeAdmin(seeded);
  await assertRejects(
    () => assertValidScopeHierarchy(admin2, "org-A", "prop-1", "building", "bldg-cross-property"),
    Error,
    "does not belong to property",
  );
});

Deno.test("Hierarchy: fails closed for a building belonging to a DIFFERENT organization", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  await assertRejects(
    () => assertValidScopeHierarchy(admin, "org-A", "prop-1", "building", "bldg-foreign"),
    Error,
    "does not belong to property",
  );
});

Deno.test("Hierarchy: fails closed for a unit belonging to a DIFFERENT organization", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  await assertRejects(
    () => assertValidScopeHierarchy(admin, "org-A", "prop-1", "unit", "unit-foreign"),
    Error,
    "does not belong to property",
  );
});

Deno.test("Hierarchy: fails closed when property itself does not belong to the organization", async () => {
  const admin = makeFakeAdmin(seedHierarchy());
  await assertRejects(
    () => assertValidScopeHierarchy(admin, "org-A", "prop-2", "property", "prop-2"),
    Error,
    "was not found in organization",
  );
});

// ===========================================================================
// PART B — resolveSnapshotScope (real implementation)
// ===========================================================================

Deno.test("resolveSnapshotScope: CAM's explicit scope_level/scope_id in inputs is used verbatim", () => {
  const inputs = { scope_level: "building", scope_id: "bldg-1" };
  assertEquals(resolveSnapshotScope(inputs, {}, "prop-1", "cam"), { scope_level: "building", scope_id: "bldg-1" });
});

Deno.test("resolveSnapshotScope: lease's explicit scope_level/scope_id in outputs is used verbatim", () => {
  // compute-lease writes scope_level/scope_id into outputs, not inputs.
  const outputs = { scope_level: "unit", scope_id: "unit-1" };
  assertEquals(resolveSnapshotScope({}, outputs, "prop-1", "lease"), { scope_level: "unit", scope_id: "unit-1" });
});

Deno.test("resolveSnapshotScope: documented legacy engines (budget/expense/revenue/reconciliation) with no scope key default to property", () => {
  // Exactly what compute-revenue/compute-expense/compute-budget/compute-reconciliation's
  // inputs look like today — no scope_level/scope_id key at all.
  const inputs = { property_id: "prop-1", fiscal_year: 2026 };
  for (const engine of ["budget", "expense", "revenue", "reconciliation"]) {
    assertEquals(resolveSnapshotScope(inputs, {}, "prop-1", engine), { scope_level: "property", scope_id: "prop-1" });
  }
});

Deno.test("resolveSnapshotScope: org-level snapshot (no property_id) resolves to null/null, never a sentinel", () => {
  assertEquals(resolveSnapshotScope({}, {}, null, "budget"), { scope_level: null, scope_id: null });
});

Deno.test("resolveSnapshotScope: fails closed — an unrecognized explicit scope_level is NEVER silently coerced to 'property'", () => {
  const inputs = { scope_level: "county", scope_id: "whatever" };
  assertThrows(
    () => resolveSnapshotScope(inputs, {}, "prop-1", "cam"),
    Error,
    'Invalid explicit scope_level "county"',
  );
});

Deno.test("resolveSnapshotScope: fails closed — 'portfolio' scope_level (budget-only, see _shared/budget-scope.ts) is rejected when paired with a property_id", () => {
  // "portfolio" is a real, recognized scope_level as of the budget scope/
  // period PR, but ONLY for a snapshot with no property_id at all (a
  // portfolio has no single parent property). A CAM call always has a
  // property_id, so this must still fail closed for CAM — just with a more
  // specific error now than the generic "unrecognized value" case above.
  const inputs = { scope_level: "portfolio", scope_id: "whatever" };
  assertThrows(
    () => resolveSnapshotScope(inputs, {}, "prop-1", "cam"),
    Error,
    'scope_level "portfolio" must not be paired with a property_id',
  );
});

Deno.test("resolveSnapshotScope: fails closed — a non-legacy engine (cam) with NO scope_level is an error, not a silent property default", () => {
  const inputs = { property_id: "prop-1", fiscal_year: 2026 }; // no scope_level key — should never happen for cam, but must not be papered over if it does
  assertThrows(
    () => resolveSnapshotScope(inputs, {}, "prop-1", "cam"),
    Error,
    'Missing scope_level for engine_type "cam"',
  );
});

Deno.test("resolveSnapshotScope: fails closed — a non-legacy engine (lease) with NO scope_level is an error", () => {
  assertThrows(
    () => resolveSnapshotScope({}, {}, "prop-1", "lease"),
    Error,
    'Missing scope_level for engine_type "lease"',
  );
});

Deno.test("resolveSnapshotScope: fails closed — explicit scope_level='property' with a mismatched scope_id", () => {
  const inputs = { scope_level: "property", scope_id: "some-other-property" };
  assertThrows(
    () => resolveSnapshotScope(inputs, {}, "prop-1", "cam"),
    Error,
    "must equal property_id",
  );
});

Deno.test("resolveSnapshotScope: fails closed — explicit scope_level='building' with no scope_id", () => {
  const inputs = { scope_level: "building" };
  assertThrows(
    () => resolveSnapshotScope(inputs, {}, "prop-1", "cam"),
    Error,
    "scope_id is required",
  );
});

Deno.test("resolveSnapshotScope: a documented legacy engine that DOES provide an explicit valid scope is honored, not forced to property", () => {
  // Legacy status only affects the *missing*-scope default; an engine in
  // the allowlist that starts sending real scope must still be respected.
  const inputs = { scope_level: "building", scope_id: "bldg-1" };
  assertEquals(resolveSnapshotScope(inputs, {}, "prop-1", "budget"), { scope_level: "building", scope_id: "bldg-1" });
});

// ===========================================================================
// PART C — saveSnapshot / findMatchingCompletedSnapshot (real implementation)
// ===========================================================================

function baseSnapshotData(overrides: Record<string, any> = {}) {
  return {
    org_id: "org-A",
    property_id: "prop-1",
    engine_type: "cam",
    fiscal_year: 2026,
    inputs: { scope_level: "property", scope_id: "prop-1" },
    outputs: { total_cam: 1000 },
    computed_by: "tester",
    engine_version: "cam-v1.0",
    ...overrides,
  };
}

Deno.test("saveSnapshot: persists scope_level/scope_id as real columns on insert", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  await saveSnapshot(admin, baseSnapshotData({
    inputs: { scope_level: "building", scope_id: "bldg-1" },
  }));
  const rows = admin._tables.computation_snapshots;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].scope_level, "building");
  assertEquals(rows[0].scope_id, "bldg-1");
});

Deno.test("saveSnapshot: property, building, and unit scope snapshots for the same property/year do not supersede each other", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "property", scope_id: "prop-1" } }));
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-1" } }));
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "unit", scope_id: "unit-1" } }));

  const rows = admin._tables.computation_snapshots;
  assertEquals(rows.length, 3);
  assertEquals(rows.filter((r: any) => r.status === "completed").length, 3, "all three scopes must remain completed, none superseded by another scope's run");
});

Deno.test("saveSnapshot: two different buildings do not supersede each other", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-1" } }));
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-2" } }));

  const rows = admin._tables.computation_snapshots;
  assertEquals(rows.filter((r: any) => r.status === "completed").length, 2);
});

Deno.test("saveSnapshot: two different units do not supersede each other", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "unit", scope_id: "unit-1" } }));
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "unit", scope_id: "unit-2" } }));

  const rows = admin._tables.computation_snapshots;
  assertEquals(rows.filter((r: any) => r.status === "completed").length, 2);
});

Deno.test("saveSnapshot: a second run for the SAME scope supersedes the first, not any other scope", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-1", run: 1 }, outputs: { total_cam: 1000 } }));
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "unit", scope_id: "unit-1", run: 1 }, outputs: { total_cam: 500 } }));
  // Re-run building bldg-1 with genuinely different inputs (not just
  // outputs) — publish_computation_snapshot correctly treats identical
  // inputs + engine_version as an idempotent reuse regardless of outputs
  // (deterministic calculation is the whole premise), so a *new* run must
  // vary inputs, not just outputs, to exercise the supersede path.
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-1", run: 2 }, outputs: { total_cam: 1200 } }));

  const rows = admin._tables.computation_snapshots;
  const bldg1Rows = rows.filter((r: any) => r.scope_id === "bldg-1");
  assertEquals(bldg1Rows.length, 2, "old and new bldg-1 runs both persist (history preserved)");
  assertEquals(bldg1Rows.filter((r: any) => r.status === "completed").length, 1, "only the latest bldg-1 run is completed");
  assertEquals(bldg1Rows.find((r: any) => r.status === "completed").outputs.total_cam, 1200);

  const unit1Row = rows.find((r: any) => r.scope_id === "unit-1");
  assertEquals(unit1Row.status, "completed", "unit-1's run must be untouched by bldg-1's rerun");
});

Deno.test("findMatchingCompletedSnapshot: idempotent rerun with identical inputs reuses the existing scoped snapshot", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  const data = baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-1" }, outputs: { total_cam: 1000 } });
  await saveSnapshot(admin, data);

  const match = await findMatchingCompletedSnapshot(admin, data);
  assertEquals(match !== null, true, "identical inputs for the same scope must be found as a match");
});

Deno.test("findMatchingCompletedSnapshot: does not match a different scope even with identical inputs otherwise", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  await saveSnapshot(admin, baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-1" }, outputs: { total_cam: 1000 } }));

  const differentScopeQuery = baseSnapshotData({ inputs: { scope_level: "building", scope_id: "bldg-2" }, outputs: { total_cam: 1000 } });
  const match = await findMatchingCompletedSnapshot(admin, differentScopeQuery);
  assertEquals(match, null, "bldg-2's lookup must never match bldg-1's snapshot");
});

Deno.test("Legacy row readability: a row written by a scope-unaware engine (no scope_level/scope_id in inputs — exactly how compute-budget/compute-revenue/compute-expense write today) is backfilled to property scope and remains findable", async () => {
  const admin = makeFakeAdmin({ computation_snapshots: [] });
  const legacyShapedData = {
    org_id: "org-A",
    property_id: "prop-1",
    engine_type: "budget",
    fiscal_year: 2026,
    inputs: { property_id: "prop-1", fiscal_year: 2026 }, // no scope_level/scope_id key
    outputs: { line_items: {} },
  };

  const savedId = await saveSnapshot(admin, legacyShapedData);
  const savedRow = admin._tables.computation_snapshots.find((r: any) => r.id === savedId);
  assertEquals(savedRow.scope_level, "property", "engines that never mention scope must still be backfilled to property scope on save");
  assertEquals(savedRow.scope_id, "prop-1");

  // A later idempotent rerun with the same data (same shape older code has
  // always produced, still no scope keys) must find the same row.
  const match = await findMatchingCompletedSnapshot(admin, legacyShapedData);
  assertEquals(match?.id, savedId);
});

// ===========================================================================
// PART D — compute-cam/index.ts's exact modified query chains, reproduced
// verbatim (see compute-cam/index.ts for the live source):
//   - lock lookup (~line 685-696)
//   - historical lookup (~line 824-834)
//   - prior-year lookup (~line 880-892)
//   - cam_calculations upsert conflict target (~line 919-921)
// ===========================================================================

function runLockLookup(admin: any, orgId: string, propertyId: string, fiscalYear: number, scopeLevel: string, scopeId: string) {
  return admin
    .from("computation_snapshots")
    .select("id, locked_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("fiscal_year", fiscalYear)
    .eq("scope_level", scopeLevel)
    .eq("scope_id", scopeId)
    .eq("status", "completed")
    .not("locked_at", "is", null)
    .limit(1)
    .maybeSingle();
}

function runHistoricalLookup(admin: any, orgId: string, propertyId: string, years: number[], scopeLevel: string, scopeId: string) {
  return admin
    .from("computation_snapshots")
    .select("fiscal_year, outputs, computed_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("scope_level", scopeLevel)
    .eq("scope_id", scopeId)
    .in("fiscal_year", years)
    .order("computed_at", { ascending: false });
}

function runPriorYearLookup(admin: any, orgId: string, propertyId: string, fiscalYear: number, scopeLevel: string, scopeId: string) {
  return admin
    .from("computation_snapshots")
    .select("id, outputs")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("scope_level", scopeLevel)
    .eq("scope_id", scopeId)
    .eq("fiscal_year", fiscalYear - 1)
    .order("computed_at", { ascending: false })
    .limit(1);
}

function seedTwoScopesSameYear() {
  return {
    computation_snapshots: [
      {
        id: "snap-property", org_id: "org-A", property_id: "prop-1", scope_level: "property", scope_id: "prop-1",
        engine_type: "cam", fiscal_year: 2026, status: "completed", locked_at: "2026-01-01T00:00:00Z",
        outputs: { total_cam: 9999 }, computed_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "snap-building", org_id: "org-A", property_id: "prop-1", scope_level: "building", scope_id: "bldg-1",
        engine_type: "cam", fiscal_year: 2026, status: "completed", locked_at: null,
        outputs: { total_cam: 111 }, computed_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "snap-org-b", org_id: "org-B", property_id: "prop-2", scope_level: "property", scope_id: "prop-2",
        engine_type: "cam", fiscal_year: 2026, status: "completed", locked_at: "2026-01-01T00:00:00Z",
        outputs: { total_cam: 42 }, computed_at: "2026-01-01T00:00:00Z",
      },
    ],
  };
}

Deno.test("Lock lookup: a locked property-scope snapshot does not block a building-scope run", async () => {
  const admin = makeFakeAdmin(seedTwoScopesSameYear());
  const result = await runLockLookup(admin, "org-A", "prop-1", 2026, "building", "bldg-1");
  assertEquals(result.data, null, "building scope is not locked even though property scope is");
});

Deno.test("Lock lookup: a lock blocks only its own exact scope", async () => {
  const admin = makeFakeAdmin(seedTwoScopesSameYear());
  const result = await runLockLookup(admin, "org-A", "prop-1", 2026, "property", "prop-1");
  assertEquals(result.data?.id, "snap-property");
});

Deno.test("Lock lookup: cross-organization lock never blocks another org's run", async () => {
  const admin = makeFakeAdmin(seedTwoScopesSameYear());
  const result = await runLockLookup(admin, "org-A", "prop-1", 2026, "property", "prop-2");
  assertEquals(result.data, null, "org-A's lookup must never see org-B's locked snapshot, even by coincidental property/scope id reuse");
});

Deno.test("Historical lookup: property and building scope do not cross-contaminate historical basis", async () => {
  const admin = makeFakeAdmin(seedTwoScopesSameYear());
  const { data: propertyHistory } = await runHistoricalLookup(admin, "org-A", "prop-1", [2026], "property", "prop-1");
  const { data: buildingHistory } = await runHistoricalLookup(admin, "org-A", "prop-1", [2026], "building", "bldg-1");
  assertEquals(propertyHistory.length, 1);
  assertEquals(propertyHistory[0].outputs.total_cam, 9999);
  assertEquals(buildingHistory.length, 1);
  assertEquals(buildingHistory[0].outputs.total_cam, 111);
});

Deno.test("Prior-year lookup: uses the same scope as the current computation, not a different one", async () => {
  const seed = seedTwoScopesSameYear();
  seed.computation_snapshots.push({
    id: "snap-building-prior", org_id: "org-A", property_id: "prop-1", scope_level: "building", scope_id: "bldg-1",
    engine_type: "cam", fiscal_year: 2025, status: "completed", locked_at: null,
    outputs: { total_cam: 50 }, computed_at: "2025-01-01T00:00:00Z",
  });
  seed.computation_snapshots.push({
    id: "snap-property-prior", org_id: "org-A", property_id: "prop-1", scope_level: "property", scope_id: "prop-1",
    engine_type: "cam", fiscal_year: 2025, status: "completed", locked_at: null,
    outputs: { total_cam: 8000 }, computed_at: "2025-01-01T00:00:00Z",
  });
  const admin = makeFakeAdmin(seed);

  const { data: buildingPrior } = await runPriorYearLookup(admin, "org-A", "prop-1", 2026, "building", "bldg-1");
  assertEquals(buildingPrior[0]?.outputs.total_cam, 50, "building-scope run must get building-scope prior year, not the property's 8000");
});

Deno.test("cam_calculations upsert: property, building, and unit rows for the same property/year all coexist", async () => {
  const admin = makeFakeAdmin({ cam_calculations: [] });
  const conflictTarget = "org_id,property_id,scope_level,scope_id,fiscal_year";

  await admin.from("cam_calculations").upsert(
    { org_id: "org-A", property_id: "prop-1", scope_level: "property", scope_id: "prop-1", fiscal_year: 2026, annual_cam: 9999 },
    { onConflict: conflictTarget },
  );
  await admin.from("cam_calculations").upsert(
    { org_id: "org-A", property_id: "prop-1", scope_level: "building", scope_id: "bldg-1", fiscal_year: 2026, annual_cam: 111 },
    { onConflict: conflictTarget },
  );
  await admin.from("cam_calculations").upsert(
    { org_id: "org-A", property_id: "prop-1", scope_level: "unit", scope_id: "unit-1", fiscal_year: 2026, annual_cam: 22 },
    { onConflict: conflictTarget },
  );

  assertEquals(admin._tables.cam_calculations.length, 3, "property/building/unit summaries must not overwrite each other");
});

Deno.test("cam_calculations upsert: re-running the SAME scope updates in place rather than duplicating (idempotent)", async () => {
  const admin = makeFakeAdmin({ cam_calculations: [] });
  const conflictTarget = "org_id,property_id,scope_level,scope_id,fiscal_year";
  const row = { org_id: "org-A", property_id: "prop-1", scope_level: "building", scope_id: "bldg-1", fiscal_year: 2026, annual_cam: 111 };

  await admin.from("cam_calculations").upsert(row, { onConflict: conflictTarget });
  await admin.from("cam_calculations").upsert({ ...row, annual_cam: 222 }, { onConflict: conflictTarget });

  const rows = admin._tables.cam_calculations;
  assertEquals(rows.length, 1, "same scope must upsert in place, not create a second row");
  assertEquals(rows[0].annual_cam, 222, "the latest run's value must win");
});
