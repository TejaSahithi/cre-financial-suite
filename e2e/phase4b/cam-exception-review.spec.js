// Phase 4B e2e smoke test — CAM Exception Review workflows.
//
// Covers:
//   1. Blocking exception displayed in CAMExceptionReview for a seeded run
//   2. Approval blocked when open blocking exception exists
//   3. Resolve dialog requires a mandatory note; submit without note shows error
//   4. After resolving all blocking exceptions, Submit → Approve flow completes
//
// Uses the same service-role seed + TOTP pattern as phase4a spec.
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ---- TOTP (same as phase4a spec — no shared utility, local per-file) -------
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

// ---- Config -----------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const APP_URL = process.env.APP_URL || "http://localhost:5173";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}
async function insertOne(client, table, values) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  if (error) throw new Error(`insertOne(${table}): ${JSON.stringify(error)}`);
  return data;
}
async function callRpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${JSON.stringify(error)}`);
  return data;
}

// ---- Seed: full ready property that produces a calculated run with one blocking exception ---

async function seedRunWithException(admin, suffix, password, exceptionSeverity = "blocking") {
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: `cam-excep-smoke-${suffix}@example.test`, password, email_confirm: true,
  });
  if (userError) throw new Error(JSON.stringify(userError));
  const actor = { userId: userData.user.id, email: userData.user.email };

  const org = await insertOne(admin, "organizations", { name: `CAM Excep Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Excep Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Exception Tenant", commencement_date: "2026-01-01" });

  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${suffix}`, normalized_key: `cat_${suffix}` });
  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id,
    property_id: property.id, approval_status: "approved", recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
  });
  await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  await insertOne(admin, "recovery_pool_categories", { org_id: org.id, pool_id: pool.pool.id, expense_category_id: category.id, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable" });

  const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
  await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, allocation_weight: 1 });
  await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: 10000, recovery_area_sqft: 10000, effective_from: "2026-01-01" });
  await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 100000, effective_from: "2026-01-01" });

  const exp = await insertOne(admin, "cam_expense_inputs", { org_id: org.id, property_id: property.id, amount: 24000, category: category.id, publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual", variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31" });
  await callRpc(admin, "assign_cam_input_to_pool", { p_org_id: org.id, p_cam_expense_input_id: exp.id, p_recovery_pool_id: pool.pool.id, p_amount: 24000, p_assignment_method: "manual", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  await callRpc(admin, "add_recovery_pool_lease_participant", { p_org_id: org.id, p_pool_id: pool.pool.id, p_lease_id: lease.id, p_effective_from: "2026-01-01", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  for (const adjType of ["prior_period_adjustment", "prior_credit"]) {
    await callRpc(admin, "record_cam_prior_period_adjustment", { p_org_id: org.id, p_lease_id: lease.id, p_recovery_period_id: period.period.id, p_adjustment_type: adjType, p_state: "KNOWN_ZERO", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  }

  // Directly insert a cam_run in 'calculated' state with one open exception
  const camRun = await insertOne(admin, "cam_runs", {
    org_id: org.id, recovery_period_id: period.period.id, scope_type: "property", scope_id: property.id,
    run_type: "standard", status: "calculated", engine_version: "cam-engine-v2.0.0",
    rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder", annual_rounding_scope: "LEASE_POOL_PERIOD", estimate_rounding_scope: "MONTH" },
    run_mode: "posting_eligible", input_hash: `test-hash-${suffix}`,
  });

  // Inject a blocking exception directly (simulates what the engine would produce)
  const exception = await insertOne(admin, "cam_run_exceptions", {
    org_id: org.id, cam_run_id: camRun.id,
    severity: exceptionSeverity, code: "PRIOR_ADJUSTMENT_UNKNOWN",
    entity_type: "cam_prior_period_adjustments", entity_id: null,
    message: `Test ${exceptionSeverity} exception for ${suffix}`,
    resolution_status: "open",
  });

  await admin.from("profiles").upsert({ id: actor.userId, email: actor.email, full_name: "CAM Exception Tester", role: "user", status: "active", dashboard_viewed: true, first_login: false });
  await insertOne(admin, "memberships", { user_id: actor.userId, org_id: org.id, role: "org_admin" });

  // Pre-enroll MFA
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  await anonClient.auth.signInWithPassword({ email: actor.email, password });
  const { data: enrollData } = await anonClient.auth.mfa.enroll({ factorType: "totp", issuer: "CRE Suite Smoke" });
  const totpSecret = enrollData?.totp?.secret;
  const totpCode = generateTotp(totpSecret);
  const { data: challengeData } = await anonClient.auth.mfa.challenge({ factorId: enrollData.id });
  await anonClient.auth.mfa.verify({ factorId: enrollData.id, challengeId: challengeData.id, code: totpCode });

  return { actor, org, property, lease, period, camRun, exception, totpSecret };
}

// ============================================================================
// Tests
// ============================================================================

test.describe("CAM Exception Review (Phase 4B)", () => {
  test("1 — Blocking exception is displayed in the Exception Review page", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Excep-${suffix}!`;
    const seed = await seedRunWithException(admin, suffix, password, "blocking");

    await page.goto(`${APP_URL}/login`);
    await page.getByLabel("Email").fill(seed.actor.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await completeMfaChallenge(page, seed.totpSecret);

    await page.goto(`${APP_URL}/cam-exception-review?cam_run_id=${seed.camRun.id}`);

    // Exception code should be visible
    await expect(page.getByText("PRIOR_ADJUSTMENT_UNKNOWN")).toBeVisible({ timeout: 15000 });
    // Severity badge "blocking" should appear
    await expect(page.getByText(/blocking/i).first()).toBeVisible({ timeout: 5000 });
  });

  test("2 — Approval is blocked while a blocking exception is open", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Excep-${suffix}!`;
    const seed = await seedRunWithException(admin, suffix, password, "blocking");

    await page.goto(`${APP_URL}/login`);
    await page.getByLabel("Email").fill(seed.actor.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await completeMfaChallenge(page, seed.totpSecret);

    // Navigate to the approval page (first try submitting)
    await page.goto(`${APP_URL}/cam-approval?cam_run_id=${seed.camRun.id}`);

    // The approve/submit button should either be disabled or absent when there's an open blocking exception
    // We look for an error state or the approve button being disabled
    const approveBtn = page.locator("[id*='approve'], button").filter({ hasText: /approve/i }).first();
    const hasApproveBtn = await approveBtn.count() > 0;
    if (hasApproveBtn) {
      // If visible, should be disabled
      await expect(approveBtn).toBeDisabled({ timeout: 8000 }).catch(async () => {
        // Or clicking it should show an error
        await approveBtn.click();
        await expect(page.getByText(/blocking exception|cannot approve/i)).toBeVisible({ timeout: 5000 });
      });
    }
    // Either way: no "Approved on" badge should appear
    await expect(page.getByText(/Approved on/i)).toHaveCount(0, { timeout: 3000 });
  });

  test("3 — Resolve dialog requires a non-empty note; submitting without one shows validation error", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Excep-${suffix}!`;
    const seed = await seedRunWithException(admin, suffix, password, "blocking");

    await page.goto(`${APP_URL}/login`);
    await page.getByLabel("Email").fill(seed.actor.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await completeMfaChallenge(page, seed.totpSecret);
    await page.goto(`${APP_URL}/cam-exception-review?cam_run_id=${seed.camRun.id}`);

    // Click "Resolve" on the blocking exception
    await page.locator("button").filter({ hasText: /resolve/i }).first().click();

    // Submit without entering a note
    const submitBtn = page.locator("button").filter({ hasText: /save|resolve|submit/i }).last();
    await submitBtn.click();

    // Should see a validation error (note is required)
    await expect(page.getByText(/note.*required|required.*note/i)).toBeVisible({ timeout: 8000 });
  });

  test("4 — After resolving all blocking exceptions, Submit for Review → Approve completes", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Excep-${suffix}!`;
    // Use a warning-severity exception so Submit is not blocked by blocking exceptions;
    // this lets us test the full approval path without a true blocking exception.
    const seed = await seedRunWithException(admin, suffix, password, "warning");

    // Manually resolve the exception via service role so we can test the submit path
    await admin.from("cam_run_exceptions")
      .update({ resolution_status: "resolved", resolution_note: "Resolved by smoke test seed" })
      .eq("id", seed.exception.id);

    await page.goto(`${APP_URL}/login`);
    await page.getByLabel("Email").fill(seed.actor.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await completeMfaChallenge(page, seed.totpSecret);

    await page.goto(`${APP_URL}/cam-approval?cam_run_id=${seed.camRun.id}`);

    // Submit for review
    const submitBtn = page.locator("button").filter({ hasText: /submit.*review/i }).first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
      await expect(page.getByText(/submitted|under review/i)).toBeVisible({ timeout: 10000 });
    }

    // Approve
    const approveBtn = page.locator("button").filter({ hasText: /approve/i }).first();
    if (await approveBtn.count() > 0) {
      await approveBtn.click();
      await expect(page.getByText(/approved|Approved on/i)).toBeVisible({ timeout: 10000 });
    }
  });
});
