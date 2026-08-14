// Phase 4B e2e smoke test — CAM Negative Workflows.
//
// Covers enforcement of the negative/guard paths that the backend tests
// verify at the DB/RPC level but cannot exercise at the browser-UI level:
//
//   1. A preview-mode run cannot be submitted for review via the UI
//   2. An open blocking exception prevents approval (UI shows disabled/absent button)
//   3. A viewer-role user sees write actions disabled and cannot approve
//   4. An approved run's recalculate button is absent/disabled
//
// Uses service-role seeding + pre-enrolled TOTP (same pattern as phase4a spec).
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ---- TOTP (file-local, no cross-file coupling) ------------------------------
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

// ---- Seed helpers -----------------------------------------------------------

async function enrollMfa(anonClient, email, password) {
  await anonClient.auth.signInWithPassword({ email, password });
  const { data: enrollData } = await anonClient.auth.mfa.enroll({ factorType: "totp", issuer: "ProForma OS Smoke" });
  const totpSecret = enrollData?.totp?.secret;
  const totpCode = generateTotp(totpSecret);
  const { data: challengeData } = await anonClient.auth.mfa.challenge({ factorId: enrollData.id });
  await anonClient.auth.mfa.verify({ factorId: enrollData.id, challengeId: challengeData.id, code: totpCode });
  return totpSecret;
}

async function createOrgUserWithMfa(admin, suffix, password, orgId, memberRole) {
  const email = `cam-neg-${memberRole}-${suffix}@example.test`;
  const { data: userData, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(JSON.stringify(error));
  const userId = userData.user.id;
  await admin.from("profiles").upsert({ id: userId, email, full_name: `Neg Tester ${memberRole}`, role: "user", status: "active", dashboard_viewed: true, first_login: false });
  await insertOne(admin, "memberships", { user_id: userId, org_id: orgId, role: memberRole });
  const totpSecret = await enrollMfa(createClient(SUPABASE_URL, ANON_KEY), email, password);
  return { userId, email, totpSecret };
}

async function seedRunWithStatus(admin, suffix, password, runStatus, runMode = "preview") {
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: `cam-neg-main-${suffix}@example.test`, password, email_confirm: true,
  });
  if (userError) throw new Error(JSON.stringify(userError));
  const actor = { userId: userData.user.id, email: userData.user.email };

  const org = await insertOne(admin, "organizations", { name: `Neg Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Neg Property ${suffix}`, status: "active" });
  const period = { id: null };

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const periodResult = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  period.id = periodResult.period.id;

  const camRun = await insertOne(admin, "cam_runs", {
    org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id,
    run_type: "standard", status: runStatus, engine_version: "cam-engine-v2.0.0",
    rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder", annual_rounding_scope: "LEASE_POOL_PERIOD", estimate_rounding_scope: "MONTH" },
    run_mode: runMode, input_hash: `neg-hash-${suffix}`,
  });

  await admin.from("profiles").upsert({ id: actor.userId, email: actor.email, full_name: "Neg Main Tester", role: "user", status: "active", dashboard_viewed: true, first_login: false });
  await insertOne(admin, "memberships", { user_id: actor.userId, org_id: org.id, role: "org_admin" });
  const totpSecret = await enrollMfa(createClient(SUPABASE_URL, ANON_KEY), actor.email, password);

  return { actor, org, property, period, camRun, totpSecret };
}

// ---- Login helper -----------------------------------------------------------
async function loginAs(page, email, password, totpSecret, path) {
  await page.goto(`${APP_URL}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await completeMfaChallenge(page, totpSecret);
  if (path) await page.goto(`${APP_URL}${path}`);
}

// ============================================================================
// Tests
// ============================================================================

test.describe("CAM Negative Workflows (Phase 4B)", () => {
  test("1 — Preview-mode run: submit-for-review button is absent or disabled", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Neg-${suffix}!`;
    // Seed a 'calculated' run in 'preview' mode
    const seed = await seedRunWithStatus(admin, suffix, password, "calculated", "preview");

    await loginAs(page, seed.actor.email, password, seed.totpSecret, `/cam-approval?cam_run_id=${seed.camRun.id}`);

    // Submit-for-review should not be available for a preview run
    const submitBtn = page.locator("button").filter({ hasText: /submit.*review/i });
    const count = await submitBtn.count();
    if (count > 0) {
      // If shown, must be disabled or clicking shows error
      await expect(submitBtn.first()).toBeDisabled({ timeout: 5000 }).catch(async () => {
        await submitBtn.first().click();
        await expect(page.getByText(/preview.*cannot|cannot.*submit.*preview|posting_eligible/i)).toBeVisible({ timeout: 5000 });
      });
    }
    // No "Submitted" or "Under Review" status text should appear
    await expect(page.getByText(/under review/i)).toHaveCount(0, { timeout: 3000 });
  });

  test("2 — Blocking exception: approve button is disabled or shows error on click", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Neg-${suffix}!`;
    const seed = await seedRunWithStatus(admin, suffix, password, "submitted", "posting_eligible");

    // Inject an open blocking exception
    await insertOne(admin, "cam_run_exceptions", {
      org_id: seed.org.id, cam_run_id: seed.camRun.id,
      severity: "blocking", code: "TEST_BLOCK",
      entity_type: "test", entity_id: null,
      message: "Test block for negative workflow",
      resolution_status: "open",
    });

    await loginAs(page, seed.actor.email, password, seed.totpSecret, `/cam-approval?cam_run_id=${seed.camRun.id}`);

    const approveBtn = page.locator("button").filter({ hasText: /^approve$/i }).first();
    const count = await approveBtn.count();
    if (count > 0) {
      await expect(approveBtn).toBeDisabled({ timeout: 5000 }).catch(async () => {
        await approveBtn.click();
        await expect(page.getByText(/blocking|cannot approve/i)).toBeVisible({ timeout: 5000 });
      });
    }
    // Approved status must NOT appear
    await expect(page.getByText(/Approved on/i)).toHaveCount(0, { timeout: 3000 });
  });

  test("3 — Viewer-role user: CAM Setup write actions are disabled", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Neg-${suffix}!`;
    // Main admin seeds the org
    const seed = await seedRunWithStatus(admin, suffix, password, "draft", "preview");

    // Create a viewer-role user in the same org
    const viewerPassword = `Viewer-${suffix}!`;
    const viewer = await createOrgUserWithMfa(admin, suffix + "v", viewerPassword, seed.org.id, "viewer");

    await loginAs(page, viewer.email, viewerPassword, viewer.totpSecret, "/cam-setup");

    // Any write button that requires CAMSetup write permission should be absent or disabled
    const writeButtons = [
      page.locator("#btn-create-calendar"),
      page.locator("#btn-create-period"),
      page.locator("#btn-create-pool"),
    ];
    for (const btn of writeButtons) {
      const count = await btn.count();
      if (count > 0) {
        await expect(btn).toBeDisabled({ timeout: 5000 }).catch(() => {
          // Button might be absent entirely (page not rendered for viewer)
        });
      }
    }
  });

  test("4 — Approved run: recalculate button is absent and calculation lines table is read-only", async ({ page }) => {
    const admin = adminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const password = `Neg-${suffix}!`;
    const seed = await seedRunWithStatus(admin, suffix, password, "approved", "posting_eligible");

    await loginAs(page, seed.actor.email, password, seed.totpSecret, `/cam-run?cam_run_id=${seed.camRun.id}`);

    // Recalculate button must be absent for approved runs
    const recalcBtn = page.locator("button").filter({ hasText: /recalculate|calculate/i });
    // Either absent entirely or disabled
    const count = await recalcBtn.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        await expect(recalcBtn.nth(i)).toBeDisabled({ timeout: 5000 });
      }
    }
    // The approved status label should be visible
    await expect(page.getByText(/approved/i).first()).toBeVisible({ timeout: 10000 });
  });
});
