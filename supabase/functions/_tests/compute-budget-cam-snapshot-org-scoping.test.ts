// @ts-nocheck
/**
 * PR-2: `org_id` filter security hotfix for compute-budget's CAM-snapshot
 * dependency lookup.
 *
 * compute-budget/index.ts's CAM-snapshot query (handleGenerate, step 2b) was
 * missing `.eq("org_id", orgId)`, unlike every other query in the same
 * function. Because Edge Functions read via an administrative Supabase
 * client, RLS cannot be relied on to compensate for a missing explicit org
 * filter — the query itself must scope by org.
 *
 * No live Supabase instance is available in this environment, so this test
 * exercises the exact `.eq()` filter chain as written in the file (copied
 * verbatim from compute-budget/index.ts's CAM-snapshot query, mirroring
 * this repo's existing convention of testing pure/reimplemented query logic
 * — see reconciliation.test.ts, budget-line-items.property.test.ts) against
 * an in-memory fake table seeded with two organizations that coincidentally
 * share the same property_id/fiscal_year — the exact scenario the query's
 * missing filter would have let through.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Minimal in-memory fake mirroring the subset of the Supabase JS
// query-builder API this query chain uses: .from().select().eq()...
// .order().limit()
// ---------------------------------------------------------------------------
function makeFakeAdmin(rows: Record<string, any>[]) {
  return {
    from(table: string) {
      let filtered = rows.filter((r) => r._table === table);
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: any) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        order(col: string, opts: { ascending: boolean }) {
          filtered = [...filtered].sort((a, b) =>
            opts.ascending ? a[col].localeCompare(b[col]) : b[col].localeCompare(a[col])
          );
          return builder;
        },
        limit(n: number) {
          return { data: filtered.slice(0, n), error: null };
        },
      };
      return builder;
    },
  };
}

// Two orgs' CAM snapshots for the SAME property_id/fiscal_year/engine_type —
// the scenario a missing org filter would conflate. Org B's is the more
// recent row, so an unscoped query ordered by computed_at desc would return
// it even when asked for org A's data.
function seedCrossOrgCamSnapshots() {
  return [
    {
      _table: "computation_snapshots",
      id: "snap-org-a",
      org_id: "org-A",
      property_id: "prop-shared",
      engine_type: "cam",
      fiscal_year: 2026,
      computed_at: "2026-01-01T00:00:00Z",
      outputs: { total_cam: 5000 },
    },
    {
      _table: "computation_snapshots",
      id: "snap-org-b",
      org_id: "org-B",
      property_id: "prop-shared",
      engine_type: "cam",
      fiscal_year: 2026,
      computed_at: "2026-06-01T00:00:00Z", // more recent than org A's
      outputs: { total_cam: 999999 },
    },
  ];
}

// Current (fixed) query — verbatim copy of compute-budget/index.ts's chain
// after PR-2, including the org_id filter.
function runFixedCamSnapshotQuery(admin: any, orgId: string, propertyId: string, fiscalYear: number) {
  return admin
    .from("computation_snapshots")
    .select("id, outputs")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1);
}

// Pre-PR-2 query — verbatim copy of the chain as it existed before this fix,
// kept here only to demonstrate the vulnerability it had.
function runPreFixCamSnapshotQuery(admin: any, _orgId: string, propertyId: string, fiscalYear: number) {
  return admin
    .from("computation_snapshots")
    .select("id, outputs")
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("Fixed query: org A's compute-budget run only ever sees org A's CAM snapshot", () => {
  const admin = makeFakeAdmin(seedCrossOrgCamSnapshots());
  const { data } = runFixedCamSnapshotQuery(admin, "org-A", "prop-shared", 2026);
  assertEquals(data.length, 1);
  assertEquals(data[0].id, "snap-org-a");
  assertEquals(data[0].outputs.total_cam, 5000);
});

Deno.test("Fixed query: org B's compute-budget run only ever sees org B's CAM snapshot", () => {
  const admin = makeFakeAdmin(seedCrossOrgCamSnapshots());
  const { data } = runFixedCamSnapshotQuery(admin, "org-B", "prop-shared", 2026);
  assertEquals(data.length, 1);
  assertEquals(data[0].id, "snap-org-b");
  assertEquals(data[0].outputs.total_cam, 999999);
});

Deno.test("Fixed query: an org with no CAM snapshot yet gets an empty result, not another org's row", () => {
  const admin = makeFakeAdmin(seedCrossOrgCamSnapshots());
  const { data } = runFixedCamSnapshotQuery(admin, "org-C", "prop-shared", 2026);
  assertEquals(data.length, 0);
});

Deno.test("Regression guard: same-org, same-scope lookup still returns the expected single row", () => {
  const admin = makeFakeAdmin(seedCrossOrgCamSnapshots());
  const { data } = runFixedCamSnapshotQuery(admin, "org-A", "prop-shared", 2026);
  assertEquals(data.length, 1);
});

Deno.test("Vulnerability demonstration: the pre-PR-2 query leaks org B's more-recent snapshot to an org A lookup", () => {
  const admin = makeFakeAdmin(seedCrossOrgCamSnapshots());
  const { data } = runPreFixCamSnapshotQuery(admin, "org-A", "prop-shared", 2026);
  // This is the bug PR-2 fixes: without the org_id filter, ordering by
  // computed_at desc + limit(1) returns whichever org's row is newest,
  // regardless of which org actually asked.
  assertEquals(data[0].id, "snap-org-b");
  assertEquals(data[0].org_id, "org-B");
});
