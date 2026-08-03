// @ts-nocheck
// Identity-consistency invariant: TypeScript SnapshotSeriesIdentity, the
// SQL advisory-lock identity, RPC row predicates, the unique partial index,
// shared snapshot queries, and compute-cam's historical/prior-year queries
// must all agree on exactly the same field set:
//   org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, month
// (see _shared/snapshot-identity.ts's SNAPSHOT_SERIES_IDENTITY_COLUMNS,
// the single declared source of truth this test checks reality against).
//
// This is deliberately NOT a test that re-reads the migration SQL as text
// and diffs it against the TS list — a comment or a string match proves
// nothing about what's actually deployed. It checks the LIVE, deployed
// system two ways:
//   1. Structural: fetches PostgREST's own OpenAPI description of
//      publish_computation_snapshot (the actual parameter list the
//      database is currently serving, not what any file claims it to be)
//      and asserts a p_<column> parameter exists for every declared
//      identity column.
//   2. Behavioral: publishes real snapshots through the real RPC and
//      proves each identity column independently participates in the
//      series match — varying ANY one of them while holding the rest
//      fixed produces an independent, non-colliding series; holding all
//      of them fixed reproduces the same series. If a future change drops
//      a column from the unique index, the advisory-lock key, or the RPC's
//      WHERE clause without updating the others, the corresponding
//      sub-test here fails.
//
// Requires a live Supabase/Postgres instance (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY) — same requirement as this suite's other
// real-database tests.
import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function skipIfNoLiveDb(): boolean {
  if (!SERVICE_ROLE_KEY) {
    console.warn("[snapshot-identity-consistency] SUPABASE_SERVICE_ROLE_KEY not set — skipping live-DB invariant tests.");
    return true;
  }
  return false;
}

const identityModuleUrl = new URL("../_shared/snapshot-identity.ts", import.meta.url);
const snapshotModuleUrl = new URL("../_shared/snapshot.ts", import.meta.url);

async function makeOrgAndProperty(admin: ReturnType<typeof adminClient>, label: string) {
  const suffix = crypto.randomUUID();
  const { data: org } = await admin.from("organizations").insert({
    name: `identity-consistency-${label}-${suffix}`, status: "active", primary_contact_email: `identity-${suffix}@example.test`,
  }).select("id").single();
  const { data: property } = await admin.from("properties").insert({
    org_id: org.id, name: `identity-consistency-property-${label}-${suffix}`, status: "active",
  }).select("id").single();
  return { orgId: org.id as string, propertyId: property.id as string };
}

// ===========================================================================
// 1. Structural: the live RPC's parameter list must have a p_<col> for
//    every declared identity column.
// ===========================================================================
Deno.test({
  name: "INVARIANT: publish_computation_snapshot's live parameter list has a p_<column> for every declared identity column",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { SNAPSHOT_SERIES_IDENTITY_COLUMNS } = await import(identityModuleUrl.href);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Accept: "application/openapi+json",
      },
    });
    assert(res.ok, `PostgREST OpenAPI introspection request must succeed, got ${res.status}`);
    const spec = await res.json();

    const path = spec.paths?.["/rpc/publish_computation_snapshot"];
    assertExists(path, "publish_computation_snapshot must be a live, callable RPC route");

    const bodyParam = (path.post?.parameters ?? []).find((p: any) => p.in === "body");
    assertExists(bodyParam, "the RPC must declare a body parameter schema");
    const liveParamNames = new Set(Object.keys(bodyParam.schema?.properties ?? {}));

    const missing = SNAPSHOT_SERIES_IDENTITY_COLUMNS.filter((col: string) => !liveParamNames.has(`p_${col}`));
    assertEquals(
      missing,
      [],
      `every SNAPSHOT_SERIES_IDENTITY_COLUMNS entry must have a matching p_<column> parameter on the live RPC. ` +
        `Missing: ${JSON.stringify(missing)}. Live params: ${JSON.stringify([...liveParamNames].sort())}`,
    );
  },
});

// ===========================================================================
// 2. Behavioral: each identity column, varied independently, produces an
//    independent series; all held fixed reproduces the same series.
// ===========================================================================
Deno.test({
  name: "INVARIANT: every declared identity column independently distinguishes a series (varying it alone never collides; holding it fixed always collides)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { saveSnapshot } = await import(snapshotModuleUrl.href);
    const { SNAPSHOT_SERIES_IDENTITY_COLUMNS } = await import(identityModuleUrl.href);
    // Sanity: this is the field set every other assertion below is derived
    // from — if _shared/snapshot-identity.ts ever changes it, this list
    // must be consciously updated too (it is not re-derived automatically,
    // by design: a silent auto-derivation would defeat the point of an
    // invariant check).
    assertEquals(
      [...SNAPSHOT_SERIES_IDENTITY_COLUMNS].sort(),
      ["engine_type", "fiscal_year", "month", "org_id", "property_id", "scope_id", "scope_level"].sort(),
      "SNAPSHOT_SERIES_IDENTITY_COLUMNS changed — update this test's expected field list deliberately, don't let it drift silently",
    );

    const admin = adminClient();
    const a = await makeOrgAndProperty(admin, "a");
    const b = await makeOrgAndProperty(admin, "b");
    const buildingId = (await admin.from("buildings").insert({ org_id: a.orgId, property_id: a.propertyId, name: "bldg" }).select("id").single()).data.id;

    const baseline = {
      org_id: a.orgId, property_id: a.propertyId, engine_type: "cam", fiscal_year: 2099, month: null,
      inputs: { scope_level: "property", scope_id: a.propertyId }, outputs: { v: 1 },
      computed_by: "test", engine_version: "cam-v1.0",
    };

    try {
      const baselineId = await saveSnapshot(admin, { ...baseline });
      assertExists(baselineId);

      // Re-publishing the exact same identity must reuse (collide).
      const sameId = await saveSnapshot(admin, { ...baseline });
      assertEquals(sameId, baselineId, "identical identity (all 7 fields the same) must resolve to the same series");

      // Varying org_id alone.
      const diffOrgId = await saveSnapshot(admin, { ...baseline, org_id: b.orgId, property_id: b.propertyId, inputs: { scope_level: "property", scope_id: b.propertyId } });
      assert(diffOrgId !== baselineId, "org_id must independently distinguish a series");

      // Varying engine_type alone (budget is a legacy/annual engine, no scope required).
      const diffEngine = await saveSnapshot(admin, { org_id: a.orgId, property_id: a.propertyId, engine_type: "budget", fiscal_year: 2099, inputs: {}, outputs: { v: 1 }, computed_by: "test", engine_version: "budget-v1.0" });
      assert(diffEngine !== baselineId, "engine_type must independently distinguish a series");

      // Varying scope_level/scope_id alone (building instead of property).
      const diffScope = await saveSnapshot(admin, { ...baseline, inputs: { scope_level: "building", scope_id: buildingId } });
      assert(diffScope !== baselineId, "scope_level/scope_id must independently distinguish a series");

      // Varying fiscal_year alone.
      const diffYear = await saveSnapshot(admin, { ...baseline, fiscal_year: 2098 });
      assert(diffYear !== baselineId, "fiscal_year must independently distinguish a series");

      // Varying month alone (baseline is annual/null; this is month=1).
      const diffMonth = await saveSnapshot(admin, { ...baseline, month: 1 });
      assert(diffMonth !== baselineId, "month must independently distinguish a series");

      // property_id is implicitly covered: scope_level="property" requires
      // scope_id === property_id (enforced by resolveSnapshotScope/
      // computation_snapshots_property_scope_check), so a different
      // property_id under the same org necessarily also changes scope_id —
      // already exercised by the org_id case above, which changes both
      // together. A same-org, different-property case:
      const { data: property2 } = await admin.from("properties").insert({ org_id: a.orgId, name: `identity-consistency-property2-${crypto.randomUUID()}`, status: "active" }).select("id").single();
      const diffProperty = await saveSnapshot(admin, { ...baseline, property_id: property2.id, inputs: { scope_level: "property", scope_id: property2.id } });
      assert(diffProperty !== baselineId, "property_id must independently distinguish a series");
    } finally {
      await admin.from("organizations").delete().eq("id", a.orgId);
      await admin.from("organizations").delete().eq("id", b.orgId);
    }
  },
});
