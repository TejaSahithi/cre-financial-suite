// Regression coverage for two Budget V1 UAT fixes to compute-revenue:
//   1. The fresh (non-reused) computation response must return snapshot_id,
//      not only the reused-snapshot branch -- BudgetPlanningPanel.jsx reads
//      result.snapshot_id unconditionally, so its absence on a property's
//      first-ever revenue computation silently broke the whole Phase 3A/3B
//      planning-mode assembly (isPlanningMode would see undefined and fall
//      through to the legacy generate path).
//   2. Base rent must be sourced from approved rent_schedules when present
//      (day-weighted per month, no re-application of escalation_rate on
//      top -- each row's monthly_amount already is that phase's contracted
//      rent), falling back to leases.monthly_rent only when no approved
//      schedule row covers a given month for a given lease.
import { assertEquals, assertExists, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
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

async function setUpOrgPropertyLeaseAndToken(suffix: string, monthlyRentFallback: number) {
  const admin = adminClient();
  const org = await insertOne(admin, "organizations", { name: `Revenue Rent Source Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Revenue Rent Source Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", {
    org_id: org.id, property_id: property.id, tenant_name: `Tenant ${suffix}`, status: "approved",
    start_date: "2024-01-01", end_date: "2030-12-31", monthly_rent: monthlyRentFallback, square_footage: 1000,
  });

  const email = `revenue-rent-source-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assertNoError(userError);
  await admin.from("profiles").upsert({ id: userData.user!.id, email, full_name: "Revenue Rent Source Tester", role: "user", status: "active" });
  await insertOne(admin, "memberships", { user_id: userData.user!.id, org_id: org.id, role: "org_admin" });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { admin, org, property, lease, accessToken };
}

async function callComputeRevenue(accessToken: string, propertyId: string, fiscalYear: number) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/compute-revenue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
    body: JSON.stringify({ property_id: propertyId, fiscal_year: fiscalYear }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

Deno.test({
  name: "compute-revenue: first-ever (fresh, non-reused) computation returns a persisted snapshot_id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, property, accessToken } = await setUpOrgPropertyLeaseAndToken(suffix, 1000);

    const { status, json } = await callComputeRevenue(accessToken, property.id, 2028);
    assertEquals(status, 200, JSON.stringify(json));
    assertEquals(json.reused_snapshot, false, "a brand-new org/property/fiscal_year combination cannot have a prior snapshot to reuse");
    assertExists(json.snapshot_id, "fresh computation response must include snapshot_id (this used to be silently missing)");
    assertMatch(json.snapshot_id, UUID_RE);

    const { data: snap, error } = await admin
      .from("computation_snapshots")
      .select("id, engine_type, fiscal_year, property_id, status")
      .eq("id", json.snapshot_id)
      .maybeSingle();
    assertNoError(error);
    assertExists(snap, "the returned snapshot_id must correspond to a real persisted row");
    assertEquals(snap.engine_type, "revenue");
    assertEquals(snap.fiscal_year, 2028);
    assertEquals(snap.property_id, property.id);
    assertEquals(snap.status, "completed");

    // Calling again must now take the reused branch and return the SAME id.
    const second = await callComputeRevenue(accessToken, property.id, 2028);
    assertEquals(second.json.reused_snapshot, true);
    assertEquals(second.json.snapshot_id, json.snapshot_id);
  },
});

Deno.test({
  name: "compute-revenue: approved rent_schedules with a mid-year escalation is authoritative over leases.monthly_rent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    // Fallback monthly_rent is deliberately a DIFFERENT, lower amount than
    // the schedule, so a passing test proves the schedule actually drove
    // the result rather than coincidentally matching the fallback.
    const FALLBACK_MONTHLY_RENT = 1000;
    const { admin, org, property, lease, accessToken } = await setUpOrgPropertyLeaseAndToken(suffix, FALLBACK_MONTHLY_RENT);

    const FISCAL_YEAR = 2028;
    const PRE_ESCALATION_RENT = 2000; // Jan-Jun
    const POST_ESCALATION_RENT = 2500; // Jul-Dec (mid-year step-up)

    for (const [start, end, amount] of [
      [`${FISCAL_YEAR}-01-01`, `${FISCAL_YEAR}-06-30`, PRE_ESCALATION_RENT],
      [`${FISCAL_YEAR}-07-01`, `${FISCAL_YEAR}-12-31`, POST_ESCALATION_RENT],
    ] as const) {
      await insertOne(admin, "rent_schedules", {
        org_id: org.id, lease_id: lease.id, property_id: property.id, row_type: "base_rent",
        status: "approved", period_start: start, period_end: end, monthly_amount: amount,
        annual_amount: amount * (start.endsWith("01-01") ? 6 : 6), charge_frequency: "monthly",
      });
    }

    const { status, json } = await callComputeRevenue(accessToken, property.id, FISCAL_YEAR);
    assertEquals(status, 200, JSON.stringify(json));

    const monthly = json.monthly_projections as Array<{ month: number; base_rent: number; base_rent_from_schedule: number; base_rent_from_fallback: number }>;
    for (const p of monthly) {
      const expected = p.month <= 6 ? PRE_ESCALATION_RENT : POST_ESCALATION_RENT;
      assertEquals(p.base_rent, expected, `month ${p.month}: expected schedule-sourced $${expected}, got $${p.base_rent}`);
      assertEquals(p.base_rent_from_schedule, expected, `month ${p.month} must be entirely schedule-sourced`);
      assertEquals(p.base_rent_from_fallback, 0, `month ${p.month} must not fall back to monthly_rent when a schedule row covers it`);
    }

    const expectedAnnual = PRE_ESCALATION_RENT * 6 + POST_ESCALATION_RENT * 6;
    assertEquals(json.summary.revenue_by_type.base_rent, expectedAnnual, "annual base rent must equal the rent schedule's own total, not leases.monthly_rent x 12");
    assertEquals(json.summary.base_rent_source.from_rent_schedule, expectedAnnual);
    assertEquals(json.summary.base_rent_source.from_monthly_rent_fallback, 0);

    // Sanity: prove this is NOT just coincidentally equal to the fallback path.
    const fallbackWouldHaveGiven = FALLBACK_MONTHLY_RENT * 12;
    if (expectedAnnual === fallbackWouldHaveGiven) {
      throw new Error("test fixture is degenerate: schedule total accidentally equals fallback total, rerun with distinct amounts");
    }
  },
});

Deno.test({
  name: "compute-revenue: a lease with NO approved rent_schedules still falls back to leases.monthly_rent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { property, accessToken } = await setUpOrgPropertyLeaseAndToken(suffix, 1750);
    const { status, json } = await callComputeRevenue(accessToken, property.id, 2028);
    assertEquals(status, 200, JSON.stringify(json));
    for (const p of json.monthly_projections) {
      assertEquals(p.base_rent, 1750);
      assertEquals(p.base_rent_from_fallback, 1750);
      assertEquals(p.base_rent_from_schedule, 0);
    }
    assertEquals(json.summary.base_rent_source.from_monthly_rent_fallback, 1750 * 12);
  },
});
