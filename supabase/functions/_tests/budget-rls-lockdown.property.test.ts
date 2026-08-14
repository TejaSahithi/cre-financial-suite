// Feature: enterprise-readiness-hardening Phase 6 (budget-only RLS lockdown)
// Property: budgets_insert/budgets_update/budgets_delete now reject direct
// authenticated writes (WITH CHECK (false) / USING (false)), while SELECT
// remains open to authorized org members and compute-budget (which always
// writes via the service-role client, and service_role has
// rolbypassrls = true) continues to work end-to-end unaffected.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

async function setUpOrgAndUser(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actorEmail = `budget-rls-${suffix}@example.test`;
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
    name: `Budget RLS Org ${suffix}`,
    status: "active",
    primary_contact_email: actorEmail,
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Budget RLS Tester",
    role: "org_admin",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: actorUserId,
    org_id: org.id,
    role: "org_admin",
  });

  const anonForSignIn = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anonForSignIn.auth.signInWithPassword({
    email: actorEmail,
    password,
  });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  // A client authenticated as the real user (not service role) — this is
  // what a raw REST call or browser console script bypassing the UI would
  // use. subject-under-test for the direct-write rejection assertions.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  return { org, actorUserId, accessToken, asUser };
}

function callComputeBudget(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name: "Budget RLS lockdown: direct authenticated INSERT/UPDATE/DELETE rejected, SELECT still works, compute-budget unaffected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, asUser } = await setUpOrgAndUser(admin, suffix);
    const fiscalYear = 2026;

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Budget RLS Property ${suffix}`,
      status: "active",
    });

    // --- 1. Direct authenticated INSERT into budgets is rejected ---
    const { data: insertData, error: insertError } = await asUser
      .from("budgets")
      .insert({
        org_id: org.id,
        property_id: property.id,
        name: "Direct bypass attempt",
        budget_year: fiscalYear,
        status: "draft",
      })
      .select("*");
    assertExists(insertError, "direct authenticated INSERT must be rejected by RLS");
    assertEquals(insertData, null);

    const { data: budgetsAfterInsertAttempt } = await admin
      .from("budgets")
      .select("id")
      .eq("org_id", org.id)
      .eq("property_id", property.id)
      .eq("budget_year", fiscalYear);
    assertEquals(budgetsAfterInsertAttempt?.length ?? 0, 0, "no row should have been created by the rejected direct INSERT");

    // --- 4. compute-budget generate still succeeds (service-role path) ---
    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "revenue",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { summary: { revenue_by_type: { base_rent: 6000, other_income: 0 } } },
    });
    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "expense",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { total_expenses: 2500 },
    });

    const generateRes = await callComputeBudget(accessToken, {
      action: "generate",
      property_id: property.id,
      fiscal_year: fiscalYear,
      allow_generate_without_cam: true,
    });
    const generateBody = await generateRes.json();
    assertEquals(generateRes.status, 200, `compute-budget generate must still succeed: ${JSON.stringify(generateBody)}`);
    const budgetId = generateBody.budget_id;
    assertExists(budgetId);

    // --- 3. Authorized SELECT still works ---
    const { data: selectRow, error: selectError } = await asUser
      .from("budgets")
      .select("id, status")
      .eq("id", budgetId)
      .single();
    assertNoError(selectError);
    assertExists(selectRow);
    assertEquals(selectRow.status, "draft");

    // --- 2. Direct authenticated UPDATE of budget status is rejected ---
    const { data: updateData, error: updateError } = await asUser
      .from("budgets")
      .update({ status: "approved" })
      .eq("id", budgetId)
      .select("*");
    // RLS on UPDATE filters rows via USING(false) rather than throwing —
    // either an explicit error or zero affected rows is an acceptable
    // rejection signal; what matters is the row must not change.
    if (!updateError) {
      assertEquals(updateData?.length ?? 0, 0, "direct UPDATE must affect zero rows if it doesn't error");
    }

    const { data: rowAfterUpdateAttempt } = await admin
      .from("budgets")
      .select("status")
      .eq("id", budgetId)
      .single();
    assertEquals(rowAfterUpdateAttempt?.status, "draft", "status must be unchanged after the rejected direct UPDATE attempt");

    // --- Direct authenticated DELETE is rejected (budgets_delete USING (false)) ---
    const { data: deleteData, error: deleteError } = await asUser
      .from("budgets")
      .delete()
      .eq("id", budgetId)
      .select("*");
    if (!deleteError) {
      assertEquals(deleteData?.length ?? 0, 0, "direct DELETE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterDeleteAttempt } = await admin
      .from("budgets")
      .select("id")
      .eq("id", budgetId)
      .maybeSingle();
    assertExists(rowAfterDeleteAttempt, "budget row must still exist after the rejected direct DELETE attempt");

    // --- 5. compute-budget mark_reviewed/approve-and-lock still succeed ---
    const reviewRes = await callComputeBudget(accessToken, { action: "mark_reviewed", property_id: property.id, fiscal_year: fiscalYear });
    const reviewBody = await reviewRes.json();
    assertEquals(reviewRes.status, 200, `mark_reviewed must still succeed: ${JSON.stringify(reviewBody)}`);
    assertEquals(reviewBody.status, "reviewed");

    const approveRes = await callComputeBudget(accessToken, { action: "approve", property_id: property.id, fiscal_year: fiscalYear });
    const approveBody = await approveRes.json();
    assertEquals(approveRes.status, 200, `approve must still succeed: ${JSON.stringify(approveBody)}`);
    assertEquals(approveBody.status, "locked");

    // --- 6. Locked/approved regeneration is still blocked ---
    const regenerateRes = await callComputeBudget(accessToken, {
      action: "generate",
      property_id: property.id,
      fiscal_year: fiscalYear,
      allow_generate_without_cam: true,
    });
    const regenerateBody = await regenerateRes.json();
    assertEquals(regenerateBody.error, true, "must not be able to regenerate a locked budget");
  },
});
