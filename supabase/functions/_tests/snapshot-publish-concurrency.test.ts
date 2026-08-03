// @ts-nocheck
// Real-database concurrency tests for transactional snapshot publication —
// 20260902000000_snapshot_publish_rpc.sql's public.publish_computation_snapshot()
// RPC, called through _shared/snapshot.ts's saveSnapshot().
//
// These tests require a live Supabase/Postgres instance (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY) — same requirement as this
// repo's other "HTTP ..." integration tests (see budget-hardening-phase4.
// property.test.ts). They are skipped with a clear message if those aren't
// set, rather than failing with an opaque client-construction error.
//
// The first test below ("REGRESSION: ...") is the retained reproduction of
// the pre-fix duplicate-snapshot race: run against the code as it existed
// before 20260902000000_snapshot_publish_rpc.sql (saveSnapshot doing a
// plain select-then-insert with no transaction and no unique constraint),
// 5 genuinely concurrent identical calls produced 5 duplicate 'completed'
// rows for the same series. If saveSnapshot or the RPC ever regress back
// toward that select-then-insert shape, this test starts failing again —
// that is its job.
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const snapshotModuleUrl = new URL("../_shared/snapshot.ts", import.meta.url);

async function importSaveSnapshot() {
  const mod = await import(snapshotModuleUrl.href);
  return mod.saveSnapshot as (admin: unknown, data: Record<string, unknown>) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Disposable fixtures — every test creates its own org (+ property/building
// as needed) and deletes the org at the end; ON DELETE CASCADE takes
// everything else (properties, buildings, computation_snapshots rows) with
// it, so nothing from this suite is ever left behind in a real environment.
// ---------------------------------------------------------------------------
async function makeOrgAndProperty(admin: ReturnType<typeof adminClient>, label: string) {
  const suffix = crypto.randomUUID();
  const { data: org, error: orgErr } = await admin.from("organizations").insert({
    name: `snapshot-race-${label}-${suffix}`,
    status: "active",
    primary_contact_email: `snapshot-race-${suffix}@example.test`,
  }).select("id").single();
  if (orgErr) throw new Error(`org insert failed: ${orgErr.message}`);

  const { data: property, error: propErr } = await admin.from("properties").insert({
    org_id: org.id,
    name: `snapshot-race-property-${label}-${suffix}`,
    status: "active",
  }).select("id").single();
  if (propErr) throw new Error(`property insert failed: ${propErr.message}`);

  return { orgId: org.id as string, propertyId: property.id as string };
}

async function makeBuilding(admin: ReturnType<typeof adminClient>, orgId: string, propertyId: string) {
  const { data: building, error } = await admin.from("buildings").insert({
    org_id: orgId, property_id: propertyId, name: `bldg-${crypto.randomUUID()}`,
  }).select("id").single();
  if (error) throw new Error(`building insert failed: ${error.message}`);
  return building.id as string;
}

async function cleanupOrg(admin: ReturnType<typeof adminClient>, orgId: string) {
  await admin.from("organizations").delete().eq("id", orgId);
}

async function completedRowsFor(
  admin: ReturnType<typeof adminClient>,
  filters: { org_id: string; property_id?: string; engine_type: string; scope_level?: string; scope_id?: string; fiscal_year: number; month?: number | null },
) {
  let query = admin
    .from("computation_snapshots")
    .select("id, status, engine_version, input_hash, computed_at, outputs, month")
    .eq("org_id", filters.org_id)
    .eq("engine_type", filters.engine_type)
    .eq("fiscal_year", filters.fiscal_year)
    .eq("status", "completed");
  if (filters.property_id) query = query.eq("property_id", filters.property_id);
  if (filters.scope_level) query = query.eq("scope_level", filters.scope_level);
  if (filters.scope_id) query = query.eq("scope_id", filters.scope_id);
  // month is only filtered when the caller explicitly asks (distinguishing
  // "don't care" from "must be null") — existing callers that never
  // mention month are unaffected.
  if (filters.month !== undefined) {
    query = filters.month === null ? query.is("month", null) : query.eq("month", filters.month);
  }
  const { data, error } = await query;
  if (error) throw new Error(`completed-rows query failed: ${error.message}`);
  return data;
}

function skipIfNoLiveDb(): boolean {
  if (!SERVICE_ROLE_KEY) {
    console.warn("[snapshot-publish-concurrency] SUPABASE_SERVICE_ROLE_KEY not set — skipping live-DB concurrency tests.");
    return true;
  }
  return false;
}

// ===========================================================================
// 1. REGRESSION — two identical concurrent requests
// ===========================================================================
Deno.test({
  name: "REGRESSION: two identical concurrent requests for the same series never produce more than one completed row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "identical");
    try {
      const payload = {
        org_id: orgId,
        property_id: propertyId,
        engine_type: "cam",
        fiscal_year: 2099,
        inputs: { scope_level: "property", scope_id: propertyId, marker: "identical-payload" },
        outputs: { total_cam: 111 },
        computed_by: "test",
        engine_version: "cam-v1.0",
      };

      const ids = await Promise.all(Array.from({ length: 6 }, () => saveSnapshot(admin, { ...payload })));
      assert(ids.every((id) => typeof id === "string"), `all 6 concurrent calls must return a snapshot id, got: ${JSON.stringify(ids)}`);
      assertEquals(new Set(ids).size, 1, "all 6 concurrent identical requests must resolve to the SAME snapshot id");

      const rows = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099 });
      assertEquals(rows.length, 1, `exactly one completed row must exist for this series, found ${rows.length}`);
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

// ===========================================================================
// 2. Two different-input concurrent requests for the same series
// ===========================================================================
Deno.test({
  name: "Two different-input concurrent requests for the same series: exactly one completed row survives, the other is superseded, both are retained in history",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "different-inputs");
    try {
      const basePayload = {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
        computed_by: "test", engine_version: "cam-v1.0",
      };
      const [idA, idB] = await Promise.all([
        saveSnapshot(admin, { ...basePayload, inputs: { scope_level: "property", scope_id: propertyId, marker: "A" }, outputs: { total_cam: 100 } }),
        saveSnapshot(admin, { ...basePayload, inputs: { scope_level: "property", scope_id: propertyId, marker: "B" }, outputs: { total_cam: 200 } }),
      ]);
      assertExists(idA);
      assertExists(idB);

      const completed = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099 });
      assertEquals(completed.length, 1, "exactly one completed row must survive when two different-input requests race for the same series");

      const { data: allRows } = await admin
        .from("computation_snapshots")
        .select("id, status")
        .eq("org_id", orgId).eq("property_id", propertyId).eq("engine_type", "cam").eq("fiscal_year", 2099);
      assertEquals(allRows.length, 2, "append-only history: both attempts must be retained as rows (one completed, one superseded), neither deleted");
      assertEquals(allRows.filter((r: { status: string }) => r.status === "superseded").length, 1, "the losing attempt must be marked superseded, not deleted");
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

// ===========================================================================
// 3. Property and building requests running concurrently (different series)
// ===========================================================================
Deno.test({
  name: "Property-scope and building-scope requests running concurrently do not interfere — both get their own completed row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "property-vs-building");
    const buildingId = await makeBuilding(admin, orgId, propertyId);
    try {
      const [propertyRunId, buildingRunId] = await Promise.all([
        saveSnapshot(admin, {
          org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
          inputs: { scope_level: "property", scope_id: propertyId }, outputs: { total_cam: 500 },
          computed_by: "test", engine_version: "cam-v1.0",
        }),
        saveSnapshot(admin, {
          org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
          inputs: { scope_level: "building", scope_id: buildingId }, outputs: { total_cam: 75 },
          computed_by: "test", engine_version: "cam-v1.0",
        }),
      ]);
      assertExists(propertyRunId);
      assertExists(buildingRunId);
      assert(propertyRunId !== buildingRunId, "property-scope and building-scope runs must produce distinct snapshot rows");

      const propertyCompleted = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099 });
      const buildingCompleted = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "building", scope_id: buildingId, fiscal_year: 2099 });
      assertEquals(propertyCompleted.length, 1);
      assertEquals(buildingCompleted.length, 1);
      assertEquals(propertyCompleted[0].outputs.total_cam, 500);
      assertEquals(buildingCompleted[0].outputs.total_cam, 75);
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

// ===========================================================================
// 4. Different organizations running concurrently
// ===========================================================================
Deno.test({
  name: "Concurrent requests from different organizations never collide, even for coincidentally-identical fiscal years/scope shapes",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const orgA = await makeOrgAndProperty(admin, "org-a");
    const orgB = await makeOrgAndProperty(admin, "org-b");
    try {
      const [idA, idB] = await Promise.all([
        saveSnapshot(admin, {
          org_id: orgA.orgId, property_id: orgA.propertyId, engine_type: "cam", fiscal_year: 2099,
          inputs: { scope_level: "property", scope_id: orgA.propertyId }, outputs: { total_cam: 10 },
          computed_by: "test", engine_version: "cam-v1.0",
        }),
        saveSnapshot(admin, {
          org_id: orgB.orgId, property_id: orgB.propertyId, engine_type: "cam", fiscal_year: 2099,
          inputs: { scope_level: "property", scope_id: orgB.propertyId }, outputs: { total_cam: 20 },
          computed_by: "test", engine_version: "cam-v1.0",
        }),
      ]);
      assertExists(idA);
      assertExists(idB);
      assert(idA !== idB);

      const rowsA = await completedRowsFor(admin, { org_id: orgA.orgId, property_id: orgA.propertyId, engine_type: "cam", scope_level: "property", scope_id: orgA.propertyId, fiscal_year: 2099 });
      const rowsB = await completedRowsFor(admin, { org_id: orgB.orgId, property_id: orgB.propertyId, engine_type: "cam", scope_level: "property", scope_id: orgB.propertyId, fiscal_year: 2099 });
      assertEquals(rowsA.length, 1);
      assertEquals(rowsB.length, 1);
      assertEquals(rowsA[0].outputs.total_cam, 10, "org A must never see org B's concurrently-published value");
      assertEquals(rowsB[0].outputs.total_cam, 20, "org B must never see org A's concurrently-published value");
    } finally {
      await cleanupOrg(admin, orgA.orgId);
      await cleanupOrg(admin, orgB.orgId);
    }
  },
});

// ===========================================================================
// 5. New engine version with identical inputs
// ===========================================================================
Deno.test({
  name: "A new engine_version with byte-identical inputs is treated as a new result, not reused",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "engine-version");
    try {
      const inputs = { scope_level: "property", scope_id: propertyId, marker: "same-inputs" };
      const idV1 = await saveSnapshot(admin, {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
        inputs, outputs: { total_cam: 300 }, computed_by: "test", engine_version: "cam-v1.0",
      });
      const idV2 = await saveSnapshot(admin, {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
        inputs, outputs: { total_cam: 300 }, computed_by: "test", engine_version: "cam-v2.0",
      });
      assertExists(idV1);
      assertExists(idV2);
      assert(idV1 !== idV2, "a new engine_version must produce a new snapshot row even with identical inputs — old results can't be assumed valid under new calculation logic");

      const completed = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099 });
      assertEquals(completed.length, 1);
      assertEquals(completed[0].engine_version, "cam-v2.0", "the v2 run must be the current completed row");

      // Idempotency still holds WITHIN a version: re-publishing v2 with the
      // same inputs again must reuse, not create a third row.
      const idV2Again = await saveSnapshot(admin, {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
        inputs, outputs: { total_cam: 300 }, computed_by: "test", engine_version: "cam-v2.0",
      });
      assertEquals(idV2Again, idV2, "re-publishing the same engine_version with identical inputs must reuse, not create another row");
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

// ===========================================================================
// 6. Transaction rollback after forced insertion failure
// ===========================================================================
Deno.test({
  name: "A failure after supersede but before insert rolls back the whole transaction, leaving the previous snapshot completed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "forced-failure");
    try {
      const baselineId = await saveSnapshot(admin, {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
        inputs: { scope_level: "property", scope_id: propertyId, marker: "baseline" },
        outputs: { total_cam: 999 }, computed_by: "test", engine_version: "cam-v1.0",
      });
      assertExists(baselineId);

      // Call the RPC directly (bypassing saveSnapshot's own JSON handling)
      // with p_outputs explicitly NULL — computation_snapshots.outputs is
      // NOT NULL, so this must fail the INSERT *after* the function has
      // already matched and superseded the baseline row above. If that
      // supersede were not rolled back with the rest of the transaction,
      // the baseline row would be left 'superseded' with no replacement —
      // an orphaned series with zero completed rows.
      const { error } = await admin.rpc("publish_computation_snapshot", {
        p_org_id: orgId,
        p_property_id: propertyId,
        p_engine_type: "cam",
        p_scope_level: "property",
        p_scope_id: propertyId,
        p_fiscal_year: 2099,
        p_engine_version: "cam-v1.0",
        p_input_hash: "deliberately-different-hash-to-force-past-reuse-check",
        p_inputs: { marker: "forced-failure-attempt" },
        p_outputs: null,
        p_computed_by: "test",
      });
      assertExists(error, "the RPC call must fail when p_outputs is NULL (NOT NULL constraint)");

      const { data: baselineRow } = await admin
        .from("computation_snapshots")
        .select("id, status")
        .eq("id", baselineId)
        .single();
      assertEquals(baselineRow.status, "completed", "the baseline snapshot must still be 'completed' — the failed publish's supersede must have been rolled back, not left applied");

      const completed = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099 });
      assertEquals(completed.length, 1, "the series must still have exactly one completed row — never zero (orphaned by a half-applied supersede) and never two");
      assertEquals(completed[0].id, baselineId);
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

// ===========================================================================
// 7. One and only one current completed snapshot per series — aggregate
//    invariant checked directly at the database level after a burst of
//    mixed concurrent activity across several series.
// ===========================================================================
Deno.test({
  name: "Invariant: after a burst of mixed concurrent publishes across several series, every series has at most one completed row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "invariant-burst");
    const buildingId = await makeBuilding(admin, orgId, propertyId);
    try {
      const calls: Promise<string | null>[] = [];
      for (let i = 0; i < 4; i++) {
        calls.push(saveSnapshot(admin, {
          org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
          inputs: { scope_level: "property", scope_id: propertyId, i },
          outputs: { total_cam: i }, computed_by: "test", engine_version: "cam-v1.0",
        }));
        calls.push(saveSnapshot(admin, {
          org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
          inputs: { scope_level: "building", scope_id: buildingId, i },
          outputs: { total_cam: i }, computed_by: "test", engine_version: "cam-v1.0",
        }));
        calls.push(saveSnapshot(admin, {
          org_id: orgId, property_id: propertyId, engine_type: "budget", fiscal_year: 2099,
          inputs: { i }, outputs: { noi: i }, computed_by: "test", engine_version: "budget-v1.0",
        }));
      }
      const results = await Promise.all(calls);
      assert(results.every((id) => typeof id === "string"), `every publish call must succeed: ${JSON.stringify(results)}`);

      const { data: allCompleted } = await admin
        .from("computation_snapshots")
        .select("org_id, property_id, engine_type, scope_level, scope_id, fiscal_year")
        .eq("org_id", orgId)
        .eq("status", "completed");

      const seen = new Map<string, number>();
      for (const row of allCompleted) {
        const key = `${row.org_id}|${row.property_id}|${row.engine_type}|${row.scope_level}|${row.scope_id}|${row.fiscal_year}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      assertEquals(seen.size, 3, "exactly 3 distinct series were exercised (cam/property, cam/building, budget/property)");
      for (const [key, count] of seen) {
        assertEquals(count, 1, `series ${key} must have exactly one completed row, found ${count}`);
      }
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

// ===========================================================================
// 8. Period identity (month) — no current engine populates month (see
//    _shared/snapshot-identity.ts's docblock for the full per-engine audit
//    this finding is based on), but the identity model, advisory-lock key,
//    RPC match/insert, and unique index all carry it so a future
//    monthly-granularity engine gets correct concurrency-safe publication
//    for free. These tests exercise that mechanism directly via
//    saveSnapshot's optional `month` field, standing in for what a future
//    monthly engine's SnapshotData would look like.
// ===========================================================================
Deno.test({
  name: "Period identity: January and February snapshots for the same series do not supersede each other",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "jan-feb");
    try {
      const base = {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
        computed_by: "test", engine_version: "cam-v1.0",
      };
      const [januaryId, februaryId] = await Promise.all([
        saveSnapshot(admin, { ...base, month: 1, inputs: { scope_level: "property", scope_id: propertyId, month: 1 }, outputs: { total_cam: 100 } }),
        saveSnapshot(admin, { ...base, month: 2, inputs: { scope_level: "property", scope_id: propertyId, month: 2 }, outputs: { total_cam: 200 } }),
      ]);
      assertExists(januaryId);
      assertExists(februaryId);
      assert(januaryId !== februaryId, "January and February must be distinct snapshot rows, not one superseding the other");

      const januaryRows = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099, month: 1 });
      const februaryRows = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099, month: 2 });
      assertEquals(januaryRows.length, 1, "January must have exactly one completed row");
      assertEquals(februaryRows.length, 1, "February must have exactly one completed row");
      assertEquals(januaryRows[0].outputs.total_cam, 100, "January's value must be untouched by February's concurrent publish");
      assertEquals(februaryRows[0].outputs.total_cam, 200, "February's value must be untouched by January's concurrent publish");
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

Deno.test({
  name: "Period identity: concurrent identical requests for the SAME month still collapse to one row (idempotency holds within a month)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "same-month-identical");
    try {
      const payload = {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099, month: 3,
        inputs: { scope_level: "property", scope_id: propertyId, month: 3 }, outputs: { total_cam: 999 },
        computed_by: "test", engine_version: "cam-v1.0",
      };
      const ids = await Promise.all(Array.from({ length: 5 }, () => saveSnapshot(admin, { ...payload })));
      assertEquals(new Set(ids).size, 1, "5 concurrent identical requests for the same month must resolve to one snapshot id");

      const marchRows = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099, month: 3 });
      assertEquals(marchRows.length, 1);
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});

Deno.test({
  name: "Period identity: an annual (month=null) publish and a specific-month publish for the same year are independent series",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const saveSnapshot = await importSaveSnapshot();
    const { orgId, propertyId } = await makeOrgAndProperty(admin, "annual-vs-month");
    try {
      const base = {
        org_id: orgId, property_id: propertyId, engine_type: "cam", fiscal_year: 2099,
        computed_by: "test", engine_version: "cam-v1.0",
      };
      const [annualId, monthId] = await Promise.all([
        saveSnapshot(admin, { ...base, inputs: { scope_level: "property", scope_id: propertyId, kind: "annual" }, outputs: { total_cam: 1200 } }), // month omitted -> null
        saveSnapshot(admin, { ...base, month: 6, inputs: { scope_level: "property", scope_id: propertyId, month: 6 }, outputs: { total_cam: 100 } }),
      ]);
      assertExists(annualId);
      assertExists(monthId);
      assert(annualId !== monthId, "an annual series and a specific-month series must never collide even for the same org/property/scope/year");

      const annualRows = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099, month: null });
      const juneRows = await completedRowsFor(admin, { org_id: orgId, property_id: propertyId, engine_type: "cam", scope_level: "property", scope_id: propertyId, fiscal_year: 2099, month: 6 });
      assertEquals(annualRows.length, 1);
      assertEquals(juneRows.length, 1);
    } finally {
      await cleanupOrg(admin, orgId);
    }
  },
});
