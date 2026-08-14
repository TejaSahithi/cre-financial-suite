// Integration coverage for the building-scope fix in CAMSetup.jsx: every
// read query on that page (published expenses, policies, pools, estimates,
// readiness, and the calculation run it triggers) must include property-wide
// records plus only the selected building's own records -- never every
// building's data undifferentiated (the bug fixed this session), and never
// an exact-match filter that wrongly hides property-wide records while a
// building is selected. Real browser, real login+MFA, real local Supabase --
// same pattern as cam-setup-wizard.spec.js, not a mock.
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function base32Decode(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function generateTotp(secretBase32, timeStepSeconds = 30, digits = 6) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / timeStepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}
async function completeMfaChallenge(page, totpSecret) {
  const heading = page.getByRole("heading", { name: "Enter Verification Code" });
  await expect(heading).toBeVisible({ timeout: 15000 });
  const codeInput = page.getByPlaceholder("000000");
  for (let attempt = 0; attempt < 3; attempt++) {
    await codeInput.fill(generateTotp(totpSecret));
    await page.getByRole("button", { name: "Verify & Sign In" }).click();
    const left = await expect(heading).toBeHidden({ timeout: 12000 }).then(() => true).catch(() => false);
    if (left) return;
  }
  throw new Error("MFA challenge did not complete after 3 attempts");
}

async function insertOne(client, table, values) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  if (error) throw new Error(`insert ${table}: ${JSON.stringify(error)}`);
  return data;
}
async function callRpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${JSON.stringify(error)}`);
  return data;
}

/**
 * Seeds one property with two buildings (A, B), one lease per building
 * (each with an approved+materialized recovery policy and premises), and:
 *   - a property-wide published expense ($10,000, building_id=null)
 *   - a Building A-only published expense ($4,000)
 *   - a Building B-only published expense ($6,000)
 *   - a property-wide recovery pool
 *   - a Building A-only recovery pool
 *   - a Building A-only estimate schedule row ($500)
 *   - a Building B-only estimate schedule row ($700)
 * Expected reconciliation when Building A is selected: expenses total
 * $10,000 + $4,000 = $14,000 (Building B's $6,000 excluded); pools show
 * both the property-wide and Building A pools (not Building B's, since none
 * exists for B in this scenario -- the property-wide one is the proof
 * point); estimates total $500 (Building B's $700 excluded).
 */
async function seedScenario(admin, suffix, password) {
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email: `cam-bscope-${suffix}@example.test`, password, email_confirm: true });
  if (userError) throw new Error(JSON.stringify(userError));
  const actor = { userId: userData.user.id, email: userData.user.email };

  const org = await insertOne(admin, "organizations", { name: `CAM Building Scope Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Building Scope Property ${suffix}`, status: "active" });
  const buildingA = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: `Building A ${suffix}` });
  const buildingB = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: `Building B ${suffix}` });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Operating ${suffix}`, normalized_key: `operating_${suffix}` });

  async function seedLeaseWithPolicy(building, tenantName, areaSqft) {
    const lease = await insertOne(admin, "leases", {
      org_id: org.id, property_id: property.id, building_id: building.id, tenant_name: tenantName,
      commencement_date: "2026-01-01", start_date: "2026-01-01",
    });
    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
    const rule = await insertOne(admin, "lease_expense_rules", {
      org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
      approval_status: "approved", recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
    });
    await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
    await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, building_id: building.id, allocation_weight: 1 });
    await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: areaSqft, recovery_area_sqft: areaSqft, effective_from: "2026-01-01" });
    return lease;
  }
  const leaseA = await seedLeaseWithPolicy(buildingA, "Building A Tenant", 5000);
  const leaseB = await seedLeaseWithPolicy(buildingB, "Building B Tenant", 5000);
  await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 100000, effective_from: "2026-01-01" });

  async function seedPublishedExpense(buildingId, amount, vendor) {
    const sourceExpense = await insertOne(admin, "expenses", { org_id: org.id, property_id: property.id, building_id: buildingId, vendor, description: "Recurring facility charge", amount, category: "operating" });
    const classification = await insertOne(admin, "expense_classifications", { org_id: org.id, expense_id: sourceExpense.id, property_id: property.id, building_id: buildingId, recovery_status: "recoverable", recoverability_result: "recoverable", approved_status: "approved" });
    return insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, building_id: buildingId, amount, category: category.category_name,
      actual_expense_id: sourceExpense.id, classification_result_id: classification.id,
      publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
      variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
    });
  }
  const propertyWideExpense = await seedPublishedExpense(null, 10000, "Property-Wide Vendor");
  const buildingAExpense = await seedPublishedExpense(buildingA.id, 4000, "Building A Vendor");
  const buildingBExpense = await seedPublishedExpense(buildingB.id, 6000, "Building B Vendor");

  const calendar = await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: "Standard Calendar", calendar_type: "calendar_year", fiscal_start_month: 1 });
  const period = await insertOne(admin, "recovery_periods", { org_id: org.id, calendar_id: calendar.id, start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026", status: "open" });

  const propertyWidePool = await insertOne(admin, "recovery_pools", { org_id: org.id, property_id: property.id, period_id: period.id, name: "Property-Wide Pool", pool_type: "property", scope_type: "property", scope_id: property.id });
  const buildingAPool = await insertOne(admin, "recovery_pools", { org_id: org.id, property_id: property.id, period_id: period.id, name: "Building A Only Pool", pool_type: "building", scope_type: "building", scope_id: buildingA.id });

  await insertOne(admin, "cam_estimate_schedules", { org_id: org.id, lease_id: leaseA.id, recovery_period_id: period.id, month_date: "2026-01-01", amount: 500, source: "manual", status: "scheduled" });
  await insertOne(admin, "cam_estimate_schedules", { org_id: org.id, lease_id: leaseB.id, recovery_period_id: period.id, month_date: "2026-01-01", amount: 700, source: "manual", status: "scheduled" });

  await admin.from("profiles").upsert({ id: actor.userId, email: actor.email, full_name: "CAM Building Scope Tester", role: "user", status: "active", dashboard_viewed: true, first_login: false });
  await insertOne(admin, "memberships", { user_id: actor.userId, org_id: org.id, role: "org_admin" });

  const anonForMfa = createClient(SUPABASE_URL, ANON_KEY);
  const { error: mfaSignInError } = await anonForMfa.auth.signInWithPassword({ email: actor.email, password });
  if (mfaSignInError) throw new Error(JSON.stringify(mfaSignInError));
  const { data: enrollData, error: enrollError } = await anonForMfa.auth.mfa.enroll({ factorType: "totp", issuer: "ProForma OS", friendlyName: `Seed_${suffix}` });
  if (enrollError) throw new Error(JSON.stringify(enrollError));
  const totpSecret = enrollData.totp.secret;
  const { error: verifyError } = await anonForMfa.auth.mfa.challengeAndVerify({ factorId: enrollData.id, code: generateTotp(totpSecret) });
  if (verifyError) throw new Error(JSON.stringify(verifyError));
  await anonForMfa.auth.signOut();

  return {
    org, property, buildingA, buildingB, category, leaseA, leaseB, calendar, period,
    propertyWideExpense, buildingAExpense, buildingBExpense, propertyWidePool, buildingAPool,
    actor, totpSecret,
  };
}

test.describe.serial("CAM Setup building-scope integration", () => {
  /** @type {any} */
  let seeded;
  let password;

  test.beforeAll(async () => {
    const admin = adminClient();
    const suffix = Date.now().toString(36);
    password = `Pass-${suffix}!`;
    seeded = await seedScenario(admin, suffix, password);
  });

  async function login(page) {
    await page.addInitScript((orgId) => { window.localStorage.setItem("cre.acting_org_id", orgId); }, seeded.org.id);
    await page.goto("/Login");
    await page.getByPlaceholder("you@company.com").fill(seeded.actor.email);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL((url) => !url.pathname.includes("/Login"), { timeout: 20000 });
    await completeMfaChallenge(page, seeded.totpSecret);
  }

  test("1: published expenses -- property-wide + selected-building included, other-building-only excluded, total reconciles exactly", async ({ page }) => {
    test.setTimeout(90000);
    await login(page);

    // "Total Published Expenses" is the StatCard whose sibling label paragraph
    // reads that exact text -- located via the label, not the dollar value
    // (which can coincidentally match another card, e.g. "Unassigned / Needs
    // Review" when nothing is yet pool-assigned, as in this scenario).
    const totalPublishedValue = () => page.locator("p", { hasText: "Total Published Expenses" }).locator("xpath=preceding-sibling::p[1]");

    // No building selected: all three expenses ($10,000 + $4,000 + $6,000 = $20,000) are in scope.
    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${seeded.period.id}`);
    await expect(page.getByText("Property-Wide Vendor", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Building A Vendor", { exact: true })).toBeVisible();
    await expect(page.getByText("Building B Vendor", { exact: true })).toBeVisible();
    await expect(totalPublishedValue()).toHaveText("$20,000.00");

    // Select Building A: property-wide ($10,000) + Building A ($4,000) = $14,000.
    // Building B's $6,000 must be excluded entirely -- this is the exact bug fixed this session.
    await page.locator("#scope-building").click();
    await page.getByRole("option", { name: new RegExp(seeded.buildingA.name) }).click();
    await expect(page.getByText("Property-Wide Vendor", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Building A Vendor", { exact: true })).toBeVisible();
    await expect(page.getByText("Building B Vendor", { exact: true })).toHaveCount(0);
    await expect(totalPublishedValue()).toHaveText("$14,000.00");

    // Select Building B: property-wide ($10,000) + Building B ($6,000) = $16,000.
    // Building A's $4,000 must be excluded.
    await page.locator("#scope-building").click();
    await page.getByRole("option", { name: new RegExp(seeded.buildingB.name) }).click();
    await expect(page.getByText("Property-Wide Vendor", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Building B Vendor", { exact: true })).toBeVisible();
    await expect(page.getByText("Building A Vendor", { exact: true })).toHaveCount(0);
    await expect(totalPublishedValue()).toHaveText("$16,000.00");
  });

  test("2: pools -- property-wide pool visible for both buildings, building-specific pool visible only for its own building", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${seeded.period.id}`);
    await page.getByRole("tab", { name: /Pool Calculation/ }).click();
    await page.locator("#scope-building").click();
    await page.getByRole("option", { name: new RegExp(seeded.buildingA.name) }).click();
    await expect(page.getByText("Property-Wide Pool")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Building A Only Pool")).toBeVisible();

    await page.locator("#scope-building").click();
    await page.getByRole("option", { name: new RegExp(seeded.buildingB.name) }).click();
    await expect(page.getByText("Property-Wide Pool")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Building A Only Pool")).toHaveCount(0);
  });

  test("3: lease recovery rules (policies) and estimates -- scoped to the selected building's own leases only, totals reconcile", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${seeded.period.id}`);
    await page.locator("#scope-building").click();
    await page.getByRole("option", { name: new RegExp(seeded.buildingA.name) }).click();

    await page.getByRole("tab", { name: /Lease Recovery Rules/ }).click();
    await expect(page.getByText("Building A Tenant").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Building B Tenant")).toHaveCount(0);

    await page.getByRole("tab", { name: /Monthly Estimates/ }).click();
    await expect(page.getByText("Building A Tenant").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Building B Tenant")).toHaveCount(0);
    await expect(page.getByText("$500.00").first()).toBeVisible();
  });

  test("4: readiness and Calculate CAM are scoped to the selected building, not the whole property", async ({ page }) => {
    test.setTimeout(90000);
    await login(page);
    const admin = adminClient();

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${seeded.period.id}`);
    await page.locator("#scope-building").click();
    await page.getByRole("option", { name: new RegExp(seeded.buildingA.name) }).click();
    await expect(page.locator("#scope-readiness-badge")).toBeVisible({ timeout: 15000 });

    await page.getByRole("tab", { name: /Calculate CAM/ }).click();
    await page.locator("#btn-calculate-cam-preview").click({ timeout: 10000 });
    await page.waitForTimeout(6000);

    const { data: runs } = await admin
      .from("cam_runs")
      .select("id, scope_type, scope_id, recovery_period_id")
      .eq("recovery_period_id", seeded.period.id)
      .order("created_at", { ascending: false })
      .limit(1);
    expect(runs?.[0]?.scope_id).toBe(seeded.buildingA.id);
    expect(runs?.[0]?.scope_type).toBe("building");
  });
});
