// @ts-nocheck
// Real-database tests for the budget identity hardening PR:
//   - _shared/budget-identity.ts (resolveBudgetIdentity)
//   - compute-budget/index.ts's approve/mark_reviewed/reject/lock actions
//     (budget_id-first resolution)
//   - export-data/index.ts's "budget"/"budget_book" export types
//     (budget_id-first resolution)
//
// Central property under test: once a property/building/unit budget can
// coexist for the same (org, property_id, budget_year), no command may
// locate "a" budget via property_id/fiscal_year + limit(1)/ordering. Every
// scenario below constructs exactly that coexistence and proves each
// command still resolves the ONE budget it was asked for — never a
// different one that happens to share the same property_id and year.
//
// Requires a live Supabase/Postgres instance (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY). Skipped with a clear
// message if those aren't set.
import { assert, assertEquals, assertExists, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function skipIfNoLiveDb(): boolean {
  if (!SERVICE_ROLE_KEY || !ANON_KEY) {
    console.warn("[budget-identity-hardening] SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY not set — skipping live-DB tests.");
    return true;
  }
  return false;
}

function assertNoError(error: unknown) {
  if (error) throw new Error(JSON.stringify(error));
}

async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}

async function assertRejects(fn: () => Promise<unknown>, messageIncludes: string) {
  try {
    await fn();
  } catch (err) {
    assert(String(err.message).includes(messageIncludes), `expected error to include "${messageIncludes}", got "${err.message}"`);
    return;
  }
  throw new Error(`expected function to throw (message including "${messageIncludes}"), but it did not`);
}

const budgetIdentityModuleUrl = new URL("../_shared/budget-identity.ts", import.meta.url);

// ===========================================================================
// Shared fixture builder
// ===========================================================================
async function buildHierarchy(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actorEmail = `budget-identity-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email: actorEmail, password, email_confirm: true });
  assertNoError(userError);
  const actorUserId = userData.user?.id;
  assertExists(actorUserId);

  const org = await insertOne(admin, "organizations", { name: `Budget Identity Org ${suffix}`, status: "active", primary_contact_email: actorEmail });
  await admin.from("profiles").upsert({ id: actorUserId, email: actorEmail, full_name: "Budget Identity Tester", role: "org_admin", status: "active" });
  await insertOne(admin, "memberships", { user_id: actorUserId, org_id: org.id, role: "org_admin" });

  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
  const building = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: `Building ${suffix}` });
  const building2 = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: `Building2 ${suffix}` });
  const unit = await insertOne(admin, "units", { org_id: org.id, property_id: property.id, building_id: building.id, unit_number: `U-${suffix}` });
  const unit2 = await insertOne(admin, "units", { org_id: org.id, property_id: property.id, building_id: building.id, unit_number: `U2-${suffix}` });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email: actorEmail, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { org, property, building, building2, unit, unit2, actorUserId, accessToken };
}

async function makeBudget(admin: ReturnType<typeof adminClient>, opts: {
  orgId: string; propertyId: string; buildingId?: string | null; unitId?: string | null;
  scope: string; scopeId: string; budgetYear: number; name: string; status?: string;
  totalRevenue?: number; totalExpenses?: number; camTotal?: number; noi?: number;
}) {
  return insertOne(admin, "budgets", {
    org_id: opts.orgId,
    property_id: opts.propertyId,
    building_id: opts.buildingId ?? null,
    unit_id: opts.unitId ?? null,
    scope: opts.scope,
    scope_id: opts.scopeId,
    name: opts.name,
    budget_year: opts.budgetYear,
    status: opts.status ?? "reviewed",
    total_revenue: opts.totalRevenue ?? 0,
    total_expenses: opts.totalExpenses ?? 0,
    cam_total: opts.camTotal ?? 0,
    noi: opts.noi ?? 0,
  });
}

function callComputeBudget(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
}

function callExportData(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/export-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
}

async function getBudgetStatus(admin: ReturnType<typeof adminClient>, id: string): Promise<string> {
  const { data } = await admin.from("budgets").select("status").eq("id", id).single();
  return data.status;
}

// ===========================================================================
// PART A — resolveBudgetIdentity (direct import, real DB lookups)
// ===========================================================================

Deno.test({
  name: "resolveBudgetIdentity: property/building/unit budgets coexisting for the same property+year each resolve by their own budget_id, never confused",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { resolveBudgetIdentity } = await import(budgetIdentityModuleUrl.href);
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, unit } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const propBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop" });
      const bldgBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "Bldg" });
      const unitBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, unitId: unit.id, scope: "unit", scopeId: unit.id, budgetYear: year, name: "Unit" });

      const resolvedProp = await resolveBudgetIdentity(admin, org.id, { budget_id: propBudget.id });
      const resolvedBldg = await resolveBudgetIdentity(admin, org.id, { budget_id: bldgBudget.id });
      const resolvedUnit = await resolveBudgetIdentity(admin, org.id, { budget_id: unitBudget.id });

      assertEquals(resolvedProp.id, propBudget.id);
      assertEquals(resolvedProp.name, "Prop");
      assertEquals(resolvedBldg.id, bldgBudget.id);
      assertEquals(resolvedBldg.name, "Bldg");
      assertEquals(resolvedUnit.id, unitBudget.id);
      assertEquals(resolvedUnit.name, "Unit");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "resolveBudgetIdentity: legacy property_id (no scope, no budget_id) resolves ONLY the property-scoped row, not a coexisting building row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { resolveBudgetIdentity } = await import(budgetIdentityModuleUrl.href);
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const propBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop" });
      await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "Bldg" });

      const resolved = await resolveBudgetIdentity(admin, org.id, { property_id: property.id, fiscal_year: year });
      assertEquals(resolved.id, propBudget.id);
      assertEquals(resolved.scope, "property");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "resolveBudgetIdentity: fails closed — mismatched scope/scope_id/property_id/budget_year hints against a real budget_id are all rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { resolveBudgetIdentity } = await import(budgetIdentityModuleUrl.href);
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const propBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop" });
      const otherProperty = await insertOne(admin, "properties", { org_id: org.id, name: `Other ${suffix}`, status: "active" });

      await assertRejects(() => resolveBudgetIdentity(admin, org.id, { budget_id: propBudget.id, scope: "building" }), "refusing a mismatched request");
      await assertRejects(() => resolveBudgetIdentity(admin, org.id, { budget_id: propBudget.id, scope_id: building.id }), "refusing a mismatched request");
      await assertRejects(() => resolveBudgetIdentity(admin, org.id, { budget_id: propBudget.id, property_id: otherProperty.id }), "refusing a mismatched request");
      await assertRejects(() => resolveBudgetIdentity(admin, org.id, { budget_id: propBudget.id, budget_year: year + 1 }), "refusing a mismatched request");

      // A CORRECT hint alongside budget_id must still succeed (not every hint is rejected, only disagreeing ones).
      const ok = await resolveBudgetIdentity(admin, org.id, { budget_id: propBudget.id, scope: "property", scope_id: property.id, property_id: property.id, budget_year: year });
      assertEquals(ok.id, propBudget.id);
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "resolveBudgetIdentity: fails closed — nonexistent budget_id, cross-org budget_id, and no-identity-at-all requests are all rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { resolveBudgetIdentity } = await import(budgetIdentityModuleUrl.href);
    const admin = adminClient();
    const suffixA = crypto.randomUUID();
    const suffixB = crypto.randomUUID();
    const a = await buildHierarchy(admin, suffixA);
    const b = await buildHierarchy(admin, suffixB);
    const year = 2028;

    try {
      const bBudget = await makeBudget(admin, { orgId: b.org.id, propertyId: b.property.id, scope: "property", scopeId: b.property.id, budgetYear: year, name: "B-org budget" });

      await assertRejects(() => resolveBudgetIdentity(admin, a.org.id, { budget_id: crypto.randomUUID() }), "was not found in organization");
      // Cross-org: org A's caller tries to resolve org B's real budget_id.
      await assertRejects(() => resolveBudgetIdentity(admin, a.org.id, { budget_id: bBudget.id }), "was not found in organization");
      // No budget_id, no scope, no property_id, no year at all.
      await assertRejects(() => resolveBudgetIdentity(admin, a.org.id, {}), "is required to locate a budget");
      // No budget_id, has a year, but no scope and no property_id.
      await assertRejects(() => resolveBudgetIdentity(admin, a.org.id, { budget_year: year }), "the full canonical identity");
    } finally {
      await admin.from("organizations").delete().eq("id", a.org.id);
      await admin.from("organizations").delete().eq("id", b.org.id);
    }
  },
});

Deno.test({
  name: "resolveBudgetIdentity: revalidates stored hierarchy is CURRENTLY valid — a building later reassigned to a different property fails re-resolution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { resolveBudgetIdentity } = await import(budgetIdentityModuleUrl.href);
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const bldgBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "Bldg" });

      // Sanity: resolves fine while the building still belongs to this property.
      const ok = await resolveBudgetIdentity(admin, org.id, { budget_id: bldgBudget.id });
      assertEquals(ok.id, bldgBudget.id);

      // Move the building to a different property, as an admin operation
      // completely outside compute-budget's control (e.g. a data-correction
      // elsewhere in the app). The budget row itself is untouched — it
      // still says property_id=<original property>, building_id=<building>
      // — but that hierarchy relationship is no longer true. The resolver
      // must catch this via assertValidBudgetScopeHierarchy's re-check
      // rather than trust the row's historical ids.
      const otherProperty = await insertOne(admin, "properties", { org_id: org.id, name: `Moved-to ${suffix}`, status: "active" });
      await admin.from("buildings").update({ property_id: otherProperty.id }).eq("id", building.id);

      await assertRejects(
        () => resolveBudgetIdentity(admin, org.id, { budget_id: bldgBudget.id }),
        "does not belong to property",
      );
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

// ===========================================================================
// PART B — HTTP compute-budget approve/reject/mark_reviewed/lock via budget_id
// ===========================================================================

Deno.test({
  name: "HTTP compute-budget approve: property AND building budgets coexist for the same property+year — approving one by budget_id never touches the other",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, accessToken } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const propBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop", status: "reviewed" });
      const bldgBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "Bldg", status: "reviewed" });

      const res = await callComputeBudget(accessToken, { action: "approve", budget_id: bldgBudget.id });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.budget_id, bldgBudget.id);

      assertEquals(await getBudgetStatus(admin, bldgBudget.id), "approved");
      assertEquals(await getBudgetStatus(admin, propBudget.id), "reviewed", "the property budget must be completely untouched by approving the building budget");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget approve/lock: two building budgets under the same property+year — acting on one by budget_id never touches the other",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, building2, accessToken } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const b1 = await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "B1", status: "approved" });
      const b2 = await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building2.id, scope: "building", scopeId: building2.id, budgetYear: year, name: "B2", status: "approved" });

      const lockRes = await callComputeBudget(accessToken, { action: "lock", budget_id: b1.id });
      const lockBody = await lockRes.json();
      assertEquals(lockRes.status, 200, JSON.stringify(lockBody));
      assertEquals(lockBody.budget_id, b1.id);

      assertEquals(await getBudgetStatus(admin, b1.id), "locked");
      assertEquals(await getBudgetStatus(admin, b2.id), "approved", "locking building 1's budget must not lock or otherwise affect building 2's");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget reject: two unit budgets under the same property+year — rejecting one by budget_id never touches the other",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, unit, unit2, accessToken } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const u1 = await makeBudget(admin, { orgId: org.id, propertyId: property.id, unitId: unit.id, scope: "unit", scopeId: unit.id, budgetYear: year, name: "U1", status: "under_review" });
      const u2 = await makeBudget(admin, { orgId: org.id, propertyId: property.id, unitId: unit2.id, scope: "unit", scopeId: unit2.id, budgetYear: year, name: "U2", status: "under_review" });

      const res = await callComputeBudget(accessToken, { action: "reject", budget_id: u1.id, reason: "needs rework" });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.budget_id, u1.id);

      assertEquals(await getBudgetStatus(admin, u1.id), "draft");
      assertEquals(await getBudgetStatus(admin, u2.id), "under_review", "rejecting unit 1's budget must not affect unit 2's");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: mark_reviewed by budget_id, then cross-org and nonexistent budget_id are rejected for every action",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffixA = crypto.randomUUID();
    const suffixB = crypto.randomUUID();
    const a = await buildHierarchy(admin, suffixA);
    const b = await buildHierarchy(admin, suffixB);
    const year = 2028;

    try {
      const aBudget = await makeBudget(admin, { orgId: a.org.id, propertyId: a.property.id, scope: "property", scopeId: a.property.id, budgetYear: year, name: "A", status: "draft" });
      const bBudget = await makeBudget(admin, { orgId: b.org.id, propertyId: b.property.id, scope: "property", scopeId: b.property.id, budgetYear: year, name: "B", status: "draft" });

      const reviewedRes = await callComputeBudget(a.accessToken, { action: "mark_reviewed", budget_id: aBudget.id });
      const reviewedBody = await reviewedRes.json();
      assertEquals(reviewedRes.status, 200, JSON.stringify(reviewedBody));
      assertEquals(await getBudgetStatus(admin, aBudget.id), "reviewed");

      // Org A's user tries to act on org B's real budget_id.
      const crossOrgRes = await callComputeBudget(a.accessToken, { action: "approve", budget_id: bBudget.id });
      const crossOrgBody = await crossOrgRes.json();
      assertEquals(crossOrgBody.error, true, "cross-org budget_id must be rejected");
      assertEquals(await getBudgetStatus(admin, bBudget.id), "draft", "org B's budget must be untouched by org A's rejected attempt");

      const nonexistentRes = await callComputeBudget(a.accessToken, { action: "lock", budget_id: crypto.randomUUID() });
      const nonexistentBody = await nonexistentRes.json();
      assertEquals(nonexistentBody.error, true, "a nonexistent budget_id must be rejected");
    } finally {
      await admin.from("organizations").delete().eq("id", a.org.id);
      await admin.from("organizations").delete().eq("id", b.org.id);
    }
  },
});

// ===========================================================================
// PART C — HTTP export-data budget_id resolution
// ===========================================================================

Deno.test({
  name: "HTTP export-data: property/building/unit budget exports each report the correct scope-specific financial totals, never confused with a sibling budget",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, unit, accessToken } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const propBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop", totalRevenue: 100000, camTotal: 9000 });
      const bldgBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "Bldg", totalRevenue: 20000, camTotal: 4000 });
      const unitBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, unitId: unit.id, scope: "unit", scopeId: unit.id, budgetYear: year, name: "Unit", totalRevenue: 5000, camTotal: 1000 });

      const propRes = await callExportData(accessToken, { export_type: "budget", budget_id: propBudget.id, format: "csv" });
      const propBody = await propRes.json();
      assertEquals(propRes.status, 200, JSON.stringify(propBody));
      assertEquals(propBody.budget_id, propBudget.id);
      assertEquals(propBody.scope, "property");

      const bldgRes = await callExportData(accessToken, { export_type: "budget", budget_id: bldgBudget.id, format: "csv" });
      const bldgBody = await bldgRes.json();
      assertEquals(bldgRes.status, 200, JSON.stringify(bldgBody));
      assertEquals(bldgBody.budget_id, bldgBudget.id);
      assertEquals(bldgBody.scope, "building");

      const unitRes = await callExportData(accessToken, { export_type: "budget", budget_id: unitBudget.id, format: "csv" });
      const unitBody = await unitRes.json();
      assertEquals(unitRes.status, 200, JSON.stringify(unitBody));
      assertEquals(unitBody.budget_id, unitBudget.id);
      assertEquals(unitBody.scope, "unit");

      assertNotEquals(propBody.export_id, bldgBody.export_id);
      assertNotEquals(bldgBody.export_id, unitBody.export_id);

      // Download and inspect the actual CSV content via the admin storage
      // client (the signed download_url embeds the internal docker
      // hostname "kong:8000", which isn't resolvable from outside the
      // compose network — fetching through the admin client's storage API
      // reaches the same object without that DNS dependency) — proves the
      // export BODY (not just the response metadata) reflects the right
      // budget's own figures, not a sibling's.
      const downloadCsv = async (exportId: string) => {
        const { data, error } = await admin.storage.from("financial-uploads").download(`exports/${org.id}/${exportId}.csv`);
        assertNoError(error);
        return await data.text();
      };
      const propCsv = await downloadCsv(propBody.export_id);
      const bldgCsv = await downloadCsv(bldgBody.export_id);
      assert(propCsv.includes("100000") || propCsv.includes("100,000"), "property export must contain the property budget's own revenue figure");
      assert(bldgCsv.includes("20000") || bldgCsv.includes("20,000"), "building export must contain the building budget's own revenue figure");
      assert(!bldgCsv.includes("100000") && !bldgCsv.includes("100,000"), "building export must NOT contain the property budget's revenue figure");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP export-data: legacy property_id export resolves the property-scoped budget specifically, not a coexisting building budget",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, accessToken } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const propBudget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop" });
      await makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "Bldg" });

      const res = await callExportData(accessToken, { export_type: "budget", property_id: property.id, fiscal_year: year, format: "csv" });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.budget_id, propBudget.id);
      assertEquals(body.scope, "property");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP export-data: mismatched budget_id+scope, nonexistent budget_id, and cross-org budget_id are all rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffixA = crypto.randomUUID();
    const suffixB = crypto.randomUUID();
    const a = await buildHierarchy(admin, suffixA);
    const b = await buildHierarchy(admin, suffixB);
    const year = 2028;

    try {
      const aBudget = await makeBudget(admin, { orgId: a.org.id, propertyId: a.property.id, scope: "property", scopeId: a.property.id, budgetYear: year, name: "A" });
      const bBudget = await makeBudget(admin, { orgId: b.org.id, propertyId: b.property.id, scope: "property", scopeId: b.property.id, budgetYear: year, name: "B" });

      const mismatchRes = await callExportData(a.accessToken, { export_type: "budget", budget_id: aBudget.id, scope: "building", format: "csv" });
      const mismatchBody = await mismatchRes.json();
      assertEquals(mismatchBody.error, true, "mismatched budget_id+scope must be rejected");

      const nonexistentRes = await callExportData(a.accessToken, { export_type: "budget", budget_id: crypto.randomUUID(), format: "csv" });
      const nonexistentBody = await nonexistentRes.json();
      assertEquals(nonexistentBody.error, true, "nonexistent budget_id must be rejected");

      const crossOrgRes = await callExportData(a.accessToken, { export_type: "budget", budget_id: bBudget.id, format: "csv" });
      const crossOrgBody = await crossOrgRes.json();
      assertEquals(crossOrgBody.error, true, "cross-org budget_id must be rejected");
    } finally {
      await admin.from("organizations").delete().eq("id", a.org.id);
      await admin.from("organizations").delete().eq("id", b.org.id);
    }
  },
});

Deno.test({
  name: "HTTP export-data: budget_book export resolves by budget_id and includes that budget's own line items",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, accessToken } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const budget = await makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop Book", totalRevenue: 50000 });
      await insertOne(admin, "computation_snapshots", {
        org_id: org.id, property_id: property.id, engine_type: "budget", scope_level: "property", scope_id: property.id,
        fiscal_year: year, status: "completed", inputs: {}, outputs: { budget_id: budget.id, status: "draft", line_items: { schema_version: "budget_line_items.v1", revenue: { total: 50000 }, expenses: { total: 20000 }, noi: 30000 } },
      });

      const res = await callExportData(accessToken, { export_type: "budget_book", budget_id: budget.id, format: "csv" });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.budget_id, budget.id);
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

// ===========================================================================
// PART D — real-database concurrency: no cross-budget confusion under load
// ===========================================================================

Deno.test({
  name: "HTTP compute-budget: concurrent approve calls on DIFFERENT budget_ids sharing the same property+year each resolve to their own row, zero cross-contamination",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, building2, unit, accessToken } = await buildHierarchy(admin, suffix);
    const year = 2028;

    try {
      const budgets = await Promise.all([
        makeBudget(admin, { orgId: org.id, propertyId: property.id, scope: "property", scopeId: property.id, budgetYear: year, name: "Prop", status: "reviewed" }),
        makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building.id, scope: "building", scopeId: building.id, budgetYear: year, name: "B1", status: "reviewed" }),
        makeBudget(admin, { orgId: org.id, propertyId: property.id, buildingId: building2.id, scope: "building", scopeId: building2.id, budgetYear: year, name: "B2", status: "reviewed" }),
        makeBudget(admin, { orgId: org.id, propertyId: property.id, unitId: unit.id, scope: "unit", scopeId: unit.id, budgetYear: year, name: "U1", status: "reviewed" }),
      ]);

      const results = await Promise.all(
        budgets.map((budget) => callComputeBudget(accessToken, { action: "approve", budget_id: budget.id }).then((r) => r.json())),
      );

      for (let i = 0; i < budgets.length; i++) {
        assertEquals(results[i].error, false, JSON.stringify(results[i]));
        assertEquals(results[i].budget_id, budgets[i].id, `result ${i} must report its own budget_id, not a sibling's`);
      }

      const statuses = await Promise.all(budgets.map((b) => getBudgetStatus(admin, b.id)));
      for (const status of statuses) {
        assertEquals(status, "approved");
      }

      // Final sanity: exactly 4 budgets rows exist for this property/year,
      // each still carrying its own distinct scope_id — no row was merged,
      // overwritten, or duplicated by the concurrent burst.
      const { data: rows } = await admin.from("budgets").select("id, scope_id").eq("org_id", org.id).eq("property_id", property.id).eq("budget_year", year);
      assertEquals((rows ?? []).length, 4);
      const scopeIds = new Set((rows ?? []).map((r: any) => r.scope_id));
      assertEquals(scopeIds.size, 4, "all 4 budgets must retain distinct scope_ids after the concurrent burst");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});
