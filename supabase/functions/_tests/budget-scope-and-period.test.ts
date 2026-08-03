// @ts-nocheck
// Real-database tests for the budget hierarchy scope + period PR:
//   - _shared/budget-scope.ts (assertValidBudgetScopeHierarchy, assertSupportedBudgetPeriod)
//   - compute-budget/index.ts (scope-aware generate/approve/mark_reviewed/reject/lock)
//   - 20260903000000_budget_scope_columns.sql (scope_id column, CHECK constraints,
//     the (org_id, scope, scope_id, budget_year) unique key, RLS fix)
//
// Requires a live Supabase/Postgres instance (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY) — same requirement as this
// suite's other real-database tests. Skipped with a clear message if those
// aren't set.
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function skipIfNoLiveDb(): boolean {
  if (!SERVICE_ROLE_KEY || !ANON_KEY) {
    console.warn("[budget-scope-and-period] SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY not set — skipping live-DB tests.");
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

const budgetScopeModuleUrl = new URL("../_shared/budget-scope.ts", import.meta.url);

// ===========================================================================
// Shared fixture builder: org + user + portfolio + property + building + unit
// ===========================================================================
async function buildHierarchy(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actorEmail = `budget-scope-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: actorEmail,
    password,
    email_confirm: true,
  });
  assertNoError(userError);
  const actorUserId = userData.user?.id;
  assertExists(actorUserId);

  const org = await insertOne(admin, "organizations", {
    name: `Budget Scope Org ${suffix}`,
    status: "active",
    primary_contact_email: actorEmail,
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Budget Scope Tester",
    role: "org_admin",
    status: "active",
  });

  await insertOne(admin, "memberships", { user_id: actorUserId, org_id: org.id, role: "org_admin" });

  const portfolio = await insertOne(admin, "portfolios", { org_id: org.id, name: `Portfolio ${suffix}` });
  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    portfolio_id: portfolio.id,
    name: `Property ${suffix}`,
    status: "active",
  });
  const building = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: `Building ${suffix}` });
  const unit = await insertOne(admin, "units", { org_id: org.id, property_id: property.id, building_id: building.id, unit_number: `U-${suffix}` });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email: actorEmail, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { org, portfolio, property, building, unit, actorUserId, accessToken };
}

async function seedRevenueExpenseSnapshots(admin: ReturnType<typeof adminClient>, orgId: string, propertyId: string, fiscalYear: number, baseRent = 100000, totalExpenses = 40000) {
  await insertOne(admin, "computation_snapshots", {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "revenue",
    fiscal_year: fiscalYear,
    inputs: {},
    outputs: { summary: { revenue_by_type: { base_rent: baseRent, other_income: 0 } } },
  });
  await insertOne(admin, "computation_snapshots", {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "expense",
    fiscal_year: fiscalYear,
    inputs: {},
    outputs: { total_expenses: totalExpenses },
  });
}

async function seedCamSnapshot(admin: ReturnType<typeof adminClient>, orgId: string, propertyId: string, scopeLevel: string, scopeId: string, fiscalYear: number, totalCam: number) {
  return insertOne(admin, "computation_snapshots", {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "cam",
    scope_level: scopeLevel,
    scope_id: scopeId,
    fiscal_year: fiscalYear,
    status: "completed",
    inputs: { scope_level: scopeLevel, scope_id: scopeId },
    outputs: { total_cam: totalCam },
  });
}

function callComputeBudget(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}`, "apikey": ANON_KEY },
    body: JSON.stringify(body),
  });
}

// ===========================================================================
// PART A — assertValidBudgetScopeHierarchy (direct import, real DB lookups)
// ===========================================================================

Deno.test({
  name: "assertValidBudgetScopeHierarchy: valid portfolio/property/building/unit scopes all resolve correctly",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { assertValidBudgetScopeHierarchy } = await import(budgetScopeModuleUrl.href);
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, portfolio, property, building, unit } = await buildHierarchy(admin, suffix);

    try {
      const portfolioScope = await assertValidBudgetScopeHierarchy(admin, org.id, { scope: "portfolio", portfolio_id: portfolio.id });
      assertEquals(portfolioScope, { scope: "portfolio", scope_id: portfolio.id, portfolio_id: portfolio.id, property_id: null, building_id: null, unit_id: null });

      const propertyScope = await assertValidBudgetScopeHierarchy(admin, org.id, { scope: "property", property_id: property.id });
      assertEquals(propertyScope, { scope: "property", scope_id: property.id, portfolio_id: portfolio.id, property_id: property.id, building_id: null, unit_id: null });

      const buildingScope = await assertValidBudgetScopeHierarchy(admin, org.id, { scope: "building", property_id: property.id, building_id: building.id });
      assertEquals(buildingScope, { scope: "building", scope_id: building.id, portfolio_id: portfolio.id, property_id: property.id, building_id: building.id, unit_id: null });

      const unitScope = await assertValidBudgetScopeHierarchy(admin, org.id, { scope: "unit", property_id: property.id, unit_id: unit.id });
      assertEquals(unitScope, { scope: "unit", scope_id: unit.id, portfolio_id: portfolio.id, property_id: property.id, building_id: building.id, unit_id: unit.id });
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "assertValidBudgetScopeHierarchy: missing required id per level fails closed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { assertValidBudgetScopeHierarchy } = await import(budgetScopeModuleUrl.href);
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building } = await buildHierarchy(admin, suffix);

    try {
      await assertRejects(() => assertValidBudgetScopeHierarchy(admin, org.id, { scope: "portfolio" }), "portfolio_id is required");
      await assertRejects(() => assertValidBudgetScopeHierarchy(admin, org.id, { scope: "property" }), "property_id is required");
      await assertRejects(() => assertValidBudgetScopeHierarchy(admin, org.id, { scope: "building", property_id: property.id }), "building_id is required");
      await assertRejects(() => assertValidBudgetScopeHierarchy(admin, org.id, { scope: "unit", property_id: property.id }), "unit_id is required");
      // Unrecognized scope value must never silently default to "property".
      await assertRejects(() => assertValidBudgetScopeHierarchy(admin, org.id, { scope: "county", property_id: property.id }), "Invalid budget scope");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "assertValidBudgetScopeHierarchy: invalid hierarchy relationships and cross-org references fail closed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const { assertValidBudgetScopeHierarchy } = await import(budgetScopeModuleUrl.href);
    const admin = adminClient();
    const suffixA = crypto.randomUUID();
    const suffixB = crypto.randomUUID();
    const a = await buildHierarchy(admin, suffixA);
    const b = await buildHierarchy(admin, suffixB);

    try {
      // Building belongs to a DIFFERENT property in the SAME org.
      const otherProperty = await insertOne(admin, "properties", { org_id: a.org.id, name: `Other Property ${suffixA}`, status: "active" });
      await assertRejects(
        () => assertValidBudgetScopeHierarchy(admin, a.org.id, { scope: "building", property_id: otherProperty.id, building_id: a.building.id }),
        "does not belong to property",
      );

      // Unit belongs to a different property.
      await assertRejects(
        () => assertValidBudgetScopeHierarchy(admin, a.org.id, { scope: "unit", property_id: otherProperty.id, unit_id: a.unit.id }),
        "does not belong to property",
      );

      // Cross-org: org A's caller tries to validate org B's property/building/unit/portfolio.
      await assertRejects(
        () => assertValidBudgetScopeHierarchy(admin, a.org.id, { scope: "property", property_id: b.property.id }),
        "was not found in organization",
      );
      await assertRejects(
        () => assertValidBudgetScopeHierarchy(admin, a.org.id, { scope: "building", property_id: b.property.id, building_id: b.building.id }),
        "was not found in organization",
      );
      await assertRejects(
        () => assertValidBudgetScopeHierarchy(admin, a.org.id, { scope: "portfolio", portfolio_id: b.portfolio.id }),
        "was not found in organization",
      );

      // Mismatched portfolio_id hint (property really belongs to a.portfolio, not b.portfolio).
      await assertRejects(
        () => assertValidBudgetScopeHierarchy(admin, a.org.id, { scope: "property", property_id: a.property.id, portfolio_id: b.portfolio.id }),
        "belongs to portfolio",
      );

      // Forbidden extra ids for a level (building_id set when scope="property").
      await assertRejects(
        () => assertValidBudgetScopeHierarchy(admin, a.org.id, { scope: "property", property_id: a.property.id, building_id: a.building.id }),
        "must not be set",
      );
    } finally {
      await admin.from("organizations").delete().eq("id", a.org.id);
      await admin.from("organizations").delete().eq("id", b.org.id);
    }
  },
});

async function assertRejects(fn: () => Promise<unknown>, messageIncludes: string) {
  try {
    await fn();
  } catch (err) {
    assert(String(err.message).includes(messageIncludes), `expected error to include "${messageIncludes}", got "${err.message}"`);
    return;
  }
  throw new Error(`expected function to throw (message including "${messageIncludes}"), but it did not`);
}

// ===========================================================================
// PART B — assertSupportedBudgetPeriod
// ===========================================================================

Deno.test("assertSupportedBudgetPeriod: annual accepted, omitted defaults to annual, quarterly/monthly/garbage rejected clearly", async () => {
  const { assertSupportedBudgetPeriod } = await import(budgetScopeModuleUrl.href);
  assertEquals(assertSupportedBudgetPeriod("annual"), "annual");
  assertEquals(assertSupportedBudgetPeriod(undefined), "annual");
  assertEquals(assertSupportedBudgetPeriod(null), "annual");
  assertEquals(assertSupportedBudgetPeriod(""), "annual");
  await assertRejects(async () => assertSupportedBudgetPeriod("quarterly"), "Unsupported budget period");
  await assertRejects(async () => assertSupportedBudgetPeriod("monthly"), "Unsupported budget period");
  await assertRejects(async () => assertSupportedBudgetPeriod("decade"), "Unsupported budget period");
});

// ===========================================================================
// PART C — HTTP compute-budget generate: full scope-aware workflow
// ===========================================================================

Deno.test({
  name: "HTTP compute-budget: property/building/unit budgets for the same property+year all coexist, each using its own CAM snapshot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, unit, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    try {
      await seedRevenueExpenseSnapshots(admin, org.id, property.id, fiscalYear);
      await seedCamSnapshot(admin, org.id, property.id, "property", property.id, fiscalYear, 9000);
      await seedCamSnapshot(admin, org.id, property.id, "building", building.id, fiscalYear, 4000);
      await seedCamSnapshot(admin, org.id, property.id, "unit", unit.id, fiscalYear, 1000);

      const propRes = await callComputeBudget(accessToken, { action: "generate", scope: "property", property_id: property.id, fiscal_year: fiscalYear });
      const propBody = await propRes.json();
      assertEquals(propRes.status, 200, JSON.stringify(propBody));
      assertEquals(propBody.line_items.revenue.cam_recovery, 9000);

      const bldgRes = await callComputeBudget(accessToken, { action: "generate", scope: "building", property_id: property.id, building_id: building.id, fiscal_year: fiscalYear });
      const bldgBody = await bldgRes.json();
      assertEquals(bldgRes.status, 200, JSON.stringify(bldgBody));
      assertEquals(bldgBody.line_items.revenue.cam_recovery, 4000);

      const unitRes = await callComputeBudget(accessToken, { action: "generate", scope: "unit", property_id: property.id, unit_id: unit.id, fiscal_year: fiscalYear });
      const unitBody = await unitRes.json();
      assertEquals(unitRes.status, 200, JSON.stringify(unitBody));
      assertEquals(unitBody.line_items.revenue.cam_recovery, 1000);

      // All three must coexist as distinct rows — none overwrote another.
      assertNotEquals(propBody.budget_id, bldgBody.budget_id);
      assertNotEquals(bldgBody.budget_id, unitBody.budget_id);
      assertNotEquals(propBody.budget_id, unitBody.budget_id);

      const { data: budgetRows } = await admin.from("budgets").select("id, scope, scope_id, cam_total").eq("org_id", org.id).eq("budget_year", fiscalYear);
      assertEquals((budgetRows ?? []).length, 3, "property, building, and unit budgets must all persist as separate rows");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: two buildings under the same property do not collide; two units do not collide",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, building, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    const building2 = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: `Building2 ${suffix}` });
    const unit2 = await insertOne(admin, "units", { org_id: org.id, property_id: property.id, building_id: building2.id, unit_number: `U2-${suffix}` });
    const unit3 = await insertOne(admin, "units", { org_id: org.id, property_id: property.id, building_id: building2.id, unit_number: `U3-${suffix}` });

    try {
      await seedRevenueExpenseSnapshots(admin, org.id, property.id, fiscalYear);
      await seedCamSnapshot(admin, org.id, property.id, "building", building.id, fiscalYear, 1000);
      await seedCamSnapshot(admin, org.id, property.id, "building", building2.id, fiscalYear, 2000);
      await seedCamSnapshot(admin, org.id, property.id, "unit", unit2.id, fiscalYear, 300);
      await seedCamSnapshot(admin, org.id, property.id, "unit", unit3.id, fiscalYear, 500);

      const b1 = await (await callComputeBudget(accessToken, { action: "generate", scope: "building", property_id: property.id, building_id: building.id, fiscal_year: fiscalYear })).json();
      const b2 = await (await callComputeBudget(accessToken, { action: "generate", scope: "building", property_id: property.id, building_id: building2.id, fiscal_year: fiscalYear })).json();
      assertNotEquals(b1.budget_id, b2.budget_id);
      assertEquals(b1.line_items.revenue.cam_recovery, 1000);
      assertEquals(b2.line_items.revenue.cam_recovery, 2000);

      const u2 = await (await callComputeBudget(accessToken, { action: "generate", scope: "unit", property_id: property.id, unit_id: unit2.id, fiscal_year: fiscalYear })).json();
      const u3 = await (await callComputeBudget(accessToken, { action: "generate", scope: "unit", property_id: property.id, unit_id: unit3.id, fiscal_year: fiscalYear })).json();
      assertNotEquals(u2.budget_id, u3.budget_id);
      assertEquals(u2.line_items.revenue.cam_recovery, 300);
      assertEquals(u3.line_items.revenue.cam_recovery, 500);
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: same-scope rerun with identical inputs is idempotent (reuses the snapshot, does not duplicate the budget row)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    try {
      await seedRevenueExpenseSnapshots(admin, org.id, property.id, fiscalYear);

      const first = await (await callComputeBudget(accessToken, { action: "generate", scope: "property", property_id: property.id, fiscal_year: fiscalYear, allow_generate_without_cam: true })).json();
      assertExists(first.budget_id);

      const second = await (await callComputeBudget(accessToken, { action: "generate", scope: "property", property_id: property.id, fiscal_year: fiscalYear, allow_generate_without_cam: true })).json();
      assertEquals(second.budget_id, first.budget_id, "identical rerun must resolve to the same budget row");
      assertEquals(second.reused_snapshot, true, "identical rerun must reuse the existing completed snapshot");

      const { data: budgetRows } = await admin.from("budgets").select("id").eq("org_id", org.id).eq("scope", "property").eq("scope_id", property.id).eq("budget_year", fiscalYear);
      assertEquals((budgetRows ?? []).length, 1, "rerun must not create a duplicate budget row");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: unsupported period (quarterly/monthly) fails clearly and persists nothing",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    try {
      await seedRevenueExpenseSnapshots(admin, org.id, property.id, fiscalYear);

      for (const period of ["quarterly", "monthly", "decade"]) {
        const res = await callComputeBudget(accessToken, { action: "generate", scope: "property", property_id: property.id, fiscal_year: fiscalYear, period, allow_generate_without_cam: true });
        const body = await res.json();
        assertEquals(body.error, true, `period="${period}" must be rejected`);
        assert(String(body.message).includes("Unsupported budget period"), body.message);
      }

      const { data: budgetRows } = await admin.from("budgets").select("id").eq("org_id", org.id).eq("property_id", property.id).eq("budget_year", fiscalYear);
      assertEquals((budgetRows ?? []).length, 0, "no budget row may be created for an unsupported period");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: cross-org building_id is rejected, not silently accepted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffixA = crypto.randomUUID();
    const suffixB = crypto.randomUUID();
    const a = await buildHierarchy(admin, suffixA);
    const b = await buildHierarchy(admin, suffixB);
    const fiscalYear = 2027;

    try {
      await seedRevenueExpenseSnapshots(admin, a.org.id, a.property.id, fiscalYear);

      // a's user tries to generate a building-scope budget using b's building id.
      const res = await callComputeBudget(a.accessToken, {
        action: "generate",
        scope: "building",
        property_id: a.property.id,
        building_id: b.building.id,
        fiscal_year: fiscalYear,
        allow_generate_without_cam: true,
      });
      const body = await res.json();
      assertEquals(body.error, true, "cross-org building_id must be rejected");

      const { data: budgetRows } = await admin.from("budgets").select("id").eq("org_id", a.org.id).eq("budget_year", fiscalYear);
      assertEquals((budgetRows ?? []).length, 0);
    } finally {
      await admin.from("organizations").delete().eq("id", a.org.id);
      await admin.from("organizations").delete().eq("id", b.org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: portfolio-scope generate fails closed with a clear, explicit 'not yet supported' error (no arbitrary child snapshot picked)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, portfolio, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    try {
      const res = await callComputeBudget(accessToken, { action: "generate", scope: "portfolio", portfolio_id: portfolio.id, fiscal_year: fiscalYear, allow_generate_without_cam: true });
      const body = await res.json();
      assertEquals(body.error, true);
      assert(String(body.message).includes("not yet supported"), body.message);

      const { data: budgetRows } = await admin.from("budgets").select("id").eq("org_id", org.id).eq("scope", "portfolio");
      assertEquals((budgetRows ?? []).length, 0);
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: legacy scope='property' rows (pre-migration shape) remain readable via the new (org, scope, scope_id, budget_year) key, and approve/lock still work on them",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    try {
      // Simulate a legacy pre-migration row: written the way every one of
      // the 202 real pre-existing rows in this database looked before this
      // PR — scope='property' (the column default), no scope_id explicitly
      // set by the caller (relies on the migration's backfill semantics —
      // here we set it directly to mirror the backfilled state, since this
      // test targets the *post-migration* schema, not the migration itself).
      const legacyBudget = await insertOne(admin, "budgets", {
        org_id: org.id,
        property_id: property.id,
        scope: "property",
        scope_id: property.id,
        name: `Legacy Budget ${suffix}`,
        budget_year: fiscalYear,
        total_revenue: 50000,
        total_expenses: 20000,
        noi: 30000,
        status: "reviewed",
      });

      const approveRes = await callComputeBudget(accessToken, { action: "approve", scope: "property", property_id: property.id, fiscal_year: fiscalYear });
      const approveBody = await approveRes.json();
      assertEquals(approveRes.status, 200, JSON.stringify(approveBody));
      assertEquals(approveBody.budget_id, legacyBudget.id, "the legacy row must be the one found and transitioned");
      assertEquals(approveBody.status, "approved");

      const lockRes = await callComputeBudget(accessToken, { action: "lock", scope: "property", property_id: property.id, fiscal_year: fiscalYear });
      const lockBody = await lockRes.json();
      assertEquals(lockRes.status, 200, JSON.stringify(lockBody));
      assertEquals(lockBody.status, "locked");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

Deno.test({
  name: "HTTP compute-budget: backward-compatible omitted-scope call (old frontend shape: property_id + fiscal_year only) still defaults to property scope",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    try {
      await seedRevenueExpenseSnapshots(admin, org.id, property.id, fiscalYear);

      const res = await callComputeBudget(accessToken, { action: "generate", property_id: property.id, fiscal_year: fiscalYear, allow_generate_without_cam: true });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.scope, "property");
      assertEquals(body.scope_id, property.id);

      const { data: row } = await admin.from("budgets").select("scope, scope_id, property_id").eq("id", body.budget_id).single();
      assertEquals(row.scope, "property");
      assertEquals(row.scope_id, property.id);
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});

// ===========================================================================
// PART D — concurrent publication via the transactional RPC, exercised
// through compute-budget's own scope-aware generate path
// ===========================================================================

Deno.test({
  name: "HTTP compute-budget: concurrent identical generate requests for the same scope collapse to exactly one budget row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, accessToken } = await buildHierarchy(admin, suffix);
    const fiscalYear = 2027;

    try {
      await seedRevenueExpenseSnapshots(admin, org.id, property.id, fiscalYear);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          callComputeBudget(accessToken, { action: "generate", scope: "property", property_id: property.id, fiscal_year: fiscalYear, allow_generate_without_cam: true }).then((r) => r.json()),
        ),
      );

      for (const body of results) {
        assertEquals(body.error, false, JSON.stringify(body));
        assertExists(body.budget_id);
      }
      const budgetIds = new Set(results.map((r) => r.budget_id));
      assertEquals(budgetIds.size, 1, "all concurrent identical requests must resolve to the same budget row");

      const { data: budgetRows } = await admin.from("budgets").select("id").eq("org_id", org.id).eq("scope", "property").eq("scope_id", property.id).eq("budget_year", fiscalYear);
      assertEquals((budgetRows ?? []).length, 1, "no duplicate budget rows from the concurrent burst");

      const { data: snapshotRows } = await admin.from("computation_snapshots").select("id").eq("org_id", org.id).eq("engine_type", "budget").eq("scope_level", "property").eq("scope_id", property.id).eq("fiscal_year", fiscalYear).eq("status", "completed");
      assertEquals((snapshotRows ?? []).length, 1, "exactly one completed budget snapshot must survive the concurrent burst");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});
