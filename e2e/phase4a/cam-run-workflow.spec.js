// Phase 4A UI smoke test — a real browser click-through of the
// Calculate -> Submit for Review -> Approve golden path, against the real
// local Supabase stack seeded via the service-role client (same pattern as
// the backend integration tests). This is a rendering/interaction smoke
// test, not a re-verification of engine correctness (274+ backend tests
// already cover that) — it exists to catch UI bugs the backend tests can't
// see: broken joins, "undefined" leaking into the DOM, buttons that don't
// actually fire, pages that crash on real data.
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// RFC 6238 TOTP, hand-rolled (no otpauth/speakeasy dependency in this repo)
// so the smoke test can complete the app's real, mandatory MFA enrollment
// step exactly the way a real user's authenticator app would, rather than
// trying to bypass it.
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
// The seed script pre-enrolls and pre-VERIFIES a TOTP factor outside the
// browser entirely (see seedReadyProperty), so MFAGuard should land on its
// CHALLENGE phase here ("Enter Verification Code" for an existing verified
// factor) rather than ENROLL -- CHALLENGE never calls
// cleanupUnverifiedFactors()/startEnrollment(), so it isn't subject to the
// React 18 StrictMode double-invoke race that makes completing ENROLL
// through the browser UI itself unreliable (a pre-existing MFAGuard/
// StrictMode interaction, unrelated to this feature).
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

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}
async function insertOne(client, table, values) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  if (error) throw new Error(JSON.stringify(error));
  return data;
}
async function callRpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${JSON.stringify(error)}`);
  return data;
}

async function seedReadyProperty(admin, suffix, password) {
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email: `cam-ui-smoke-${suffix}@example.test`, password, email_confirm: true });
  if (userError) throw new Error(JSON.stringify(userError));
  const actor = { userId: userData.user.id, email: userData.user.email };

  const org = await insertOne(admin, "organizations", { name: `CAM UI Smoke Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM UI Smoke Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Acme Retail Co.", commencement_date: "2026-01-01" });

  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Operating ${suffix}`, normalized_key: `operating_${suffix}` });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
    approval_status: "approved", recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
  });
  await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Property Operating Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  await insertOne(admin, "recovery_pool_categories", { org_id: org.id, pool_id: pool.pool.id, expense_category_id: category.id, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable" });

  const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
  await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, allocation_weight: 1 });
  await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: 10000, recovery_area_sqft: 10000, effective_from: "2026-01-01" });
  await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 100000, effective_from: "2026-01-01" });

  const expenseInput = await insertOne(admin, "cam_expense_inputs", {
    org_id: org.id, property_id: property.id, lease_id: lease.id, amount: 24000, category: category.id,
    publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  });
  await callRpc(admin, "assign_cam_input_to_pool", { p_org_id: org.id, p_cam_expense_input_id: expenseInput.id, p_recovery_pool_id: pool.pool.id, p_amount: 24000, p_assignment_method: "manual", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  await callRpc(admin, "add_recovery_pool_lease_participant", { p_org_id: org.id, p_pool_id: pool.pool.id, p_lease_id: lease.id, p_effective_from: "2026-01-01", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  for (const adjType of ["prior_period_adjustment", "prior_credit"]) {
    await callRpc(admin, "record_cam_prior_period_adjustment", { p_org_id: org.id, p_lease_id: lease.id, p_recovery_period_id: period.period.id, p_adjustment_type: adjType, p_state: "KNOWN_ZERO", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  }

  await admin.from("profiles").upsert({ id: actor.userId, email: actor.email, full_name: "CAM UI Smoke Tester", role: "user", status: "active", dashboard_viewed: true, first_login: false });
  await insertOne(admin, "memberships", { user_id: actor.userId, org_id: org.id, role: "org_admin" });

  // Pre-enroll and pre-VERIFY a TOTP factor here, outside the browser/React
  // entirely (a plain node supabase-js client, same pattern that reliably
  // works in isolation). MFAGuard's ENROLL path re-derives a brand new
  // secret via cleanupUnverifiedFactors()+startEnrollment() on every
  // React 18 StrictMode dev double-invoke of its own useEffect, which
  // races any attempt to complete enrollment through the browser UI
  // itself -- a pre-existing MFAGuard/StrictMode interaction bug, unrelated
  // to this feature. Pre-verifying here means the browser only has to pass
  // through MFAGuard's CHALLENGE path (enter the code for an
  // already-verified factor), which does none of that regeneration and is
  // not subject to the same race.
  const anonForMfa = createClient(SUPABASE_URL, ANON_KEY);
  const { error: mfaSignInError } = await anonForMfa.auth.signInWithPassword({ email: actor.email, password });
  if (mfaSignInError) throw new Error(JSON.stringify(mfaSignInError));
  const { data: enrollData, error: enrollError } = await anonForMfa.auth.mfa.enroll({ factorType: "totp", issuer: "ProForma OS", friendlyName: `Seed_${suffix}` });
  if (enrollError) throw new Error(JSON.stringify(enrollError));
  const totpSecret = enrollData.totp.secret;
  const { error: verifyError } = await anonForMfa.auth.mfa.challengeAndVerify({ factorId: enrollData.id, code: generateTotp(totpSecret) });
  if (verifyError) throw new Error(JSON.stringify(verifyError));
  await anonForMfa.auth.signOut();

  return { org, property, period: period.period, lease, actor, totpSecret };
}

test("Phase 4A CAM workflow renders and drives calculate -> submit -> approve end to end in a real browser", async ({ page }) => {
  test.setTimeout(90000);
  const admin = adminClient();
  const suffix = Date.now().toString(36);
  const password = `Pass-${suffix}!`;
  const seeded = await seedReadyProperty(admin, suffix, password);

  await page.addInitScript((orgId) => { window.localStorage.setItem("cre.acting_org_id", orgId); }, seeded.org.id);
  await page.goto("/Login");
  await page.getByPlaceholder("you@company.com").fill(seeded.actor.email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/Login"), { timeout: 20000 });
  await completeMfaChallenge(page, seeded.totpSecret);

  await page.goto(`/CAMRun?property_id=${seeded.property.id}&recovery_period_id=${seeded.period.id}`);
  await expect(page.getByRole("heading", { name: "CAM Run" })).toBeVisible({ timeout: 15000 });

  // No run exists yet -- Calculate creates the draft and computes it.
  await page.getByRole("button", { name: /^Calculate$/ }).click();
  await expect(page.getByText("calculated", { exact: true })).toBeVisible({ timeout: 20000 });

  // Real numbers must render -- 10,000/100,000 sqft = 10% of $24,000 = $2,400.
  await expect(page.getByText("$2,400.00").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("body")).not.toContainText("undefined");
  await expect(page.locator("body")).not.toContainText("NaN");

  await page.getByRole("button", { name: "Submit for Review" }).click();
  await expect(page.getByText("submitted", { exact: true })).toBeVisible({ timeout: 15000 });

  await page.getByRole("link", { name: /Go to Approval/i }).click();
  await expect(page.getByRole("heading", { name: "Approval" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("No unresolved blocking exceptions.")).toBeVisible();
  await expect(page.getByText("$2,400.00").first()).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Approved on/i)).toBeVisible({ timeout: 15000 });

  // Pool detail and lease detail drill-downs must also render real data, not crash.
  await page.goto(`/CAMRun?property_id=${seeded.property.id}&recovery_period_id=${seeded.period.id}`);
  await page.locator('a[href*="CAMPoolDetail"]', { hasText: "Detail" }).first().click();
  await expect(page.getByRole("heading", { name: "Pool Detail" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Acme Retail Co.").first()).toBeVisible();
  await expect(page.getByText("$24,000.00").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("undefined");

  await page.getByRole("link", { name: "Lease detail" }).click();
  await expect(page.getByRole("heading", { name: "Lease Detail (CAM Run)" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Acme Retail Co.").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("undefined");
});
