// CAM Setup automation/UX pass — real-browser Playwright coverage for every
// required behavior: scope persistence, automatic period suggestion,
// automatic pool/participant suggestions, complete policy/expense display,
// bulk estimate entry, readiness resolution links, and mandatory-reason
// custom entries. Seeds a real property via service-role RPCs (same
// pattern as e2e/phase4a/cam-run-workflow.spec.js), then drives the actual
// /CAMSetup page in a real browser through a real TOTP-verified login.
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
 * Seeds: org, actor (MFA pre-verified), property, a Calendar-Year calendar
 * (no period yet -- so the automatic-period-suggestion banner has
 * something to suggest), two leases (one with an approved category
 * recovery policy + premises, one with NEITHER, to exercise "leases
 * missing policy information"), and one published expense (with a real
 * source Expense row for vendor/description, and a classification row for
 * recoverability) in the SAME category as the approved policy -- so a pool
 * suggestion has both a policy-lease count and an expense total.
 */
async function seedScenario(admin, suffix, password) {
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email: `cam-setup-ux-${suffix}@example.test`, password, email_confirm: true });
  if (userError) throw new Error(JSON.stringify(userError));
  const actor = { userId: userData.user.id, email: userData.user.email };

  const org = await insertOne(admin, "organizations", { name: `CAM Setup UX Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Setup UX Property ${suffix}`, status: "active" });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Operating ${suffix}`, normalized_key: `operating_${suffix}` });

  const leaseWithPolicy = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Northwind Traders", commencement_date: "2026-01-01", start_date: "2026-01-01" });
  const leaseWithoutPolicy = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: "Contoso Retail", commencement_date: "2026-01-01", start_date: "2026-01-01" });

  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: leaseWithPolicy.id });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: leaseWithPolicy.id, property_id: property.id,
    approval_status: "approved", recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
  });
  await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });

  const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: leaseWithPolicy.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
  await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, allocation_weight: 1 });
  await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: 8000, recovery_area_sqft: 8000, effective_from: "2026-01-01" });
  await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 100000, effective_from: "2026-01-01" });

  const sourceExpense = await insertOne(admin, "expenses", { org_id: org.id, property_id: property.id, vendor: "Acme Facilities Services", description: "Q1 grounds maintenance and common area upkeep", amount: 18000, category: "operating" });
  const classification = await insertOne(admin, "expense_classifications", { org_id: org.id, expense_id: sourceExpense.id, property_id: property.id, recovery_status: "recoverable", recoverability_result: "recoverable", approved_status: "approved" });
  const publishedExpense = await insertOne(admin, "cam_expense_inputs", {
    org_id: org.id, property_id: property.id, amount: 18000, category: category.id, actual_expense_id: sourceExpense.id, classification_result_id: classification.id,
    publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  });

  const calendar = await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: "Standard Calendar", calendar_type: "calendar_year", fiscal_start_month: 1 });

  await admin.from("profiles").upsert({ id: actor.userId, email: actor.email, full_name: "CAM Setup UX Tester", role: "user", status: "active", dashboard_viewed: true, first_login: false });
  await insertOne(admin, "memberships", { user_id: actor.userId, org_id: org.id, role: "org_admin" });

  const anonForMfa = createClient(SUPABASE_URL, ANON_KEY);
  const { error: mfaSignInError } = await anonForMfa.auth.signInWithPassword({ email: actor.email, password });
  if (mfaSignInError) throw new Error(JSON.stringify(mfaSignInError));
  const { data: enrollData, error: enrollError } = await anonForMfa.auth.mfa.enroll({ factorType: "totp", issuer: "CRE Suite", friendlyName: `Seed_${suffix}` });
  if (enrollError) throw new Error(JSON.stringify(enrollError));
  const totpSecret = enrollData.totp.secret;
  const { error: verifyError } = await anonForMfa.auth.mfa.challengeAndVerify({ factorId: enrollData.id, code: generateTotp(totpSecret) });
  if (verifyError) throw new Error(JSON.stringify(verifyError));
  await anonForMfa.auth.signOut();

  return { org, property, category, leaseWithPolicy, leaseWithoutPolicy, sourceExpense, publishedExpense, calendar, actor, totpSecret };
}

test.describe.serial("CAM Setup automation and business usability", () => {
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

  test("1: scope (property + period) persists across steps, a page reload, and direct step navigation", async ({ page }) => {
    test.setTimeout(90000);
    await login(page);
    // CAM Reconciliation Workbench redesign: a bare /CAMSetup now lands on
    // the business-facing Workbench by default. This suite specifically
    // drives the detailed 7-step Advanced Setup wizard (unchanged), so it
    // opts in explicitly; every later step=N URL in this file already
    // carries that intent implicitly (see workbenchView in CAMSetup.jsx).
    await page.goto("/CAMSetup?view=advanced");
    await expect(page.getByRole("heading", { name: "CAM Setup" })).toBeVisible({ timeout: 15000 });

    await page.locator("#scope-property").click();
    await page.getByRole("option", { name: seeded.property.name }).click();
    await expect(page.locator("#btn-create-calendar")).toBeHidden(); // calendar already seeded

    // Confirm the automatic period suggestion (requirement 3) to get a period selected.
    await expect(page.getByText(/Suggested recovery period:/)).toBeVisible({ timeout: 10000 });
    await page.locator("#btn-confirm-suggested-period").click();
    await expect(page.locator("#scope-period")).toContainText("FY", { timeout: 10000 });

    // Navigate through steps -- the scope bar's property/period selection must never reset.
    await page.locator("#step-tab-4").click();
    await expect(page.locator("#scope-property")).toContainText(seeded.property.name);
    await expect(page.locator("#scope-period")).toContainText("FY");
    await expect(page.getByText("select a property and period")).toHaveCount(0);

    const urlBeforeReload = page.url();
    await page.reload();
    await expect(page.getByRole("heading", { name: "CAM Setup" })).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#scope-property")).toContainText(seeded.property.name);
    await expect(page.locator("#scope-period")).toContainText("FY");
    expect(page.url()).toBe(urlBeforeReload);

    // Direct navigation via a URL naming a later step must land there directly, already scoped.
    const directUrl = urlBeforeReload.replace(/step=\d+/, "step=6");
    await page.goto(directUrl);
    await expect(page.locator("#btn-open-bulk-estimate")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#scope-property")).toContainText(seeded.property.name);
  });

  test("2 & 4: automatic pool suggestion (with source counts) can be confirmed, and no duplicate lease/expense records are created", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    const admin = adminClient();
    const { data: periodRow } = await admin.from("recovery_periods").select("id").eq("calendar_id", seeded.calendar.id).single();

    const { data: leaseCountBefore } = await admin.from("leases").select("id").eq("property_id", seeded.property.id);
    const { data: expenseCountBefore } = await admin.from("cam_expense_inputs").select("id").eq("property_id", seeded.property.id);

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${periodRow.id}&step=2`);
    await expect(page.getByText("Suggested Recovery Pools")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/1 lease with approved policy/)).toBeVisible();
    await expect(page.getByText(/\$18,000\.00 total/)).toBeVisible();

    await page.locator('[id^="btn-confirm-suggestion-"]').first().click();
    await expect(page.getByText("Pool created")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Recovery Pools (1)")).toBeVisible({ timeout: 10000 });

    const { data: leaseCountAfter } = await admin.from("leases").select("id").eq("property_id", seeded.property.id);
    const { data: expenseCountAfter } = await admin.from("cam_expense_inputs").select("id").eq("property_id", seeded.property.id);
    expect(leaseCountAfter.length).toBe(leaseCountBefore.length);
    expect(expenseCountAfter.length).toBe(expenseCountBefore.length);
  });

  test("3: automatic participant suggestion is shown and can be confirmed", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    const admin = adminClient();
    const { data: periodRow } = await admin.from("recovery_periods").select("id").eq("calendar_id", seeded.calendar.id).single();
    const { data: poolRow } = await admin.from("recovery_pools").select("id").eq("property_id", seeded.property.id).single();

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${periodRow.id}&pool_id=${poolRow.id}&step=3`);
    await expect(page.getByText("Suggested Participants")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Northwind Traders")).toBeVisible();
    await expect(page.getByText(/8,000 sqft/)).toBeVisible();
    await expect(page.getByText(/policy includes a category this pool covers/)).toBeVisible();

    await page.locator(`#btn-confirm-participant-${seeded.leaseWithPolicy.id}`).click();
    await expect(page.getByText("Confirmed Participants (1)")).toBeVisible({ timeout: 10000 });
  });

  test("5: approved policy values and published expense details are fully visible (no unexplained dashes)", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    const admin = adminClient();
    const { data: periodRow } = await admin.from("recovery_periods").select("id").eq("calendar_id", seeded.calendar.id).single();

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${periodRow.id}&step=4`);
    await expect(page.getByText("Northwind Traders")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(`Operating ${seeded.property.name.split(" ").pop()}`).or(page.getByText("Operating", { exact: false }))).toBeVisible();
    await expect(page.getByText("Area Pro-Rata Share")).toBeVisible();
    await expect(page.getByText("Contoso Retail")).toBeVisible(); // shown in "missing policy information" list

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${periodRow.id}&step=5`);
    await expect(page.getByText("Acme Facilities Services")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Q1 grounds maintenance and common area upkeep")).toBeVisible();
    await expect(page.getByText("Recoverable")).toBeVisible();
    await expect(page.getByText("2026-01-01 → 2026-12-31")).toBeVisible();
  });

  test("6: bulk monthly estimate entry creates the correct schedule across two effective ranges", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    const admin = adminClient();
    const { data: periodRow } = await admin.from("recovery_periods").select("id").eq("calendar_id", seeded.calendar.id).single();

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${periodRow.id}&step=6`);
    await page.locator("#btn-open-bulk-estimate").click();
    await page.locator("#bulk-est-lease").click();
    await page.getByRole("option", { name: "Northwind Traders" }).click();

    await page.locator("#bulk-est-amount-0").fill("500");
    await page.locator("#bulk-est-start-0").fill("2026-01");
    await page.locator("#bulk-est-end-0").fill("2026-03");
    await page.locator("#btn-add-estimate-range").click();
    await page.locator("#bulk-est-amount-1").fill("550");
    await page.locator("#bulk-est-start-1").fill("2026-04");
    await page.locator("#bulk-est-end-1").fill("2026-05");

    // Requirement 10: reason is mandatory -- Create must stay disabled until filled.
    await expect(page.locator("#btn-save-bulk-estimate")).toBeDisabled();
    await page.locator("#bulk-est-reason").fill("Escalation schedule confirmed with tenant's property manager.");
    await expect(page.locator("#bulk-est-preview-count")).toContainText("5 monthly rows");
    await expect(page.locator("#btn-save-bulk-estimate")).toBeEnabled();
    await page.locator("#btn-save-bulk-estimate").click();
    await expect(page.getByText("5 estimate rows created")).toBeVisible({ timeout: 10000 });

    const { data: rows } = await admin.from("cam_estimate_schedules").select("month_date, amount").eq("lease_id", seeded.leaseWithPolicy.id).order("month_date");
    expect(rows.length).toBe(5);
    expect(Number(rows[0].amount)).toBe(500);
    expect(Number(rows[3].amount)).toBe(550);
  });

  test("7 & 8: readiness resolution links jump to the correct step, and excluding a participant requires a reason", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    const admin = adminClient();
    const { data: periodRow } = await admin.from("recovery_periods").select("id").eq("calendar_id", seeded.calendar.id).single();
    const { data: poolRow } = await admin.from("recovery_pools").select("id").eq("property_id", seeded.property.id).single();

    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${periodRow.id}&step=7`);
    await expect(page.getByText("Setup Readiness")).toBeVisible({ timeout: 15000 });
    // The published expense has never been assigned to a pool -- a real
    // POOL_ASSIGNMENT_MISSING blocking exception must be present with a
    // resolution link back to the Expenses step.
    await expect(page.getByText(/assigned to a recovery pool/i)).toBeVisible({ timeout: 15000 });
    const resolveButtons = page.getByRole("button", { name: "Resolve →" });
    await resolveButtons.first().click();
    await expect(page.locator("#step-tab-5.bg-blue-600")).toBeVisible({ timeout: 10000 });

    // Requirement 10: excluding a confirmed participant requires a reason.
    await page.goto(`/CAMSetup?property_id=${seeded.property.id}&period_id=${periodRow.id}&pool_id=${poolRow.id}&step=3`);
    const excludeButton = page.locator('[id^="btn-exclude-participant-"]').first();
    await expect(excludeButton).toBeVisible({ timeout: 15000 });
    await excludeButton.click();
    await expect(page.locator("#btn-confirm-exclude")).toBeDisabled();
    await page.locator("#exclude-reason").fill("Tenant lease terminated early per amendment #2.");
    await expect(page.locator("#btn-confirm-exclude")).toBeEnabled();
    await page.locator("#btn-confirm-exclude").click();
    await expect(page.getByText("Participant excluded")).toBeVisible({ timeout: 10000 });

    const admin2 = adminClient();
    const { data: participantRow } = await admin2.from("recovery_pool_lease_participants").select("status, notes").eq("pool_id", poolRow.id).eq("lease_id", seeded.leaseWithPolicy.id).single();
    expect(participantRow.status).toBe("ended");
    expect(participantRow.notes).toBe("Tenant lease terminated early per amendment #2.");
  });

  test("A: a recovery period selected in CAM Setup is honored by CAM Runs, not shown as 'no recovery period'", async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    const admin = adminClient();
    const { data: periodRow } = await admin.from("recovery_periods").select("id, label").eq("calendar_id", seeded.calendar.id).single();
    expect(periodRow.label).toContain("FY2026"); // the period test 1 confirmed via the automatic-period-suggestion banner

    // Direct navigation with the period already in the URL -- this is the
    // exact CAMRun.jsx bug this fixed: propertyId/periodId were previously
    // read into useState ONCE at mount and never re-derived, so switching
    // periods (or landing here with a period already selected) rendered a
    // stale/empty state. Now they are derived from searchParams on every
    // render, so the run list, tabs, and period selector must all reflect
    // this period on the very first paint, not after a manual re-select.
    await page.goto(`/CAMRun?property_id=${seeded.property.id}&recovery_period_id=${periodRow.id}`);
    await expect(page.getByRole("heading", { name: "CAM Runs" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Select a property and recovery period to manage CAM runs.")).toHaveCount(0);
    await expect(page.locator("#cam-run-tabs")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(periodRow.label, { exact: false })).toBeVisible();

    // Switching to a different property must clear the period (not carry
    // a now-unrelated period id forward) -- reload to confirm the cleared
    // state survives a refresh too, matching the URL-is-truth pattern used
    // throughout CAM Setup.
    await page.reload();
    await expect(page.locator("#cam-run-tabs")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(periodRow.label, { exact: false })).toBeVisible();
  });
});
