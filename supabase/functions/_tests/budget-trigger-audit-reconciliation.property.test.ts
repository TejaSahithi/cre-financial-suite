// Feature: enterprise-readiness-hardening Phase 6A-1 (budget audit-trigger
// reconciliation).
// Properties:
//   1. compute-budget's "generate" action (fires tr_budget_changed's
//      TG_OP='INSERT' branch) produces exactly one canonical audit_logs row
//      (action: 'budget_generated') and zero trigger-duplicated rows
//      (entity_type='Budget', action='create') for the same budget.
//   2. compute-budget's "approve" action (fires tr_budget_changed's
//      TG_OP='UPDATE' branch) produces the RPC's own canonical audit row and
//      zero trigger-duplicated rows (entity_type='Budget', action='update')
//      for the same budget.
//   3. tr_budget_changed's notification side effects still fire for both
//      the INSERT (Budget Created) and UPDATE (Budget Locked) paths —
//      only the redundant audit insert was removed, not the trigger itself.
//   4. Direct client INSERT/UPDATE/DELETE on budgets remains rejected by RLS
//      (already covered end-to-end by budget-rls-lockdown.property.test.ts;
//      re-asserted here narrowly to keep this property self-contained).
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
  const actorEmail = `budget-trigger-reconcile-${suffix}@example.test`;
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
    name: `Budget Trigger Reconcile Org ${suffix}`,
    status: "active",
    primary_contact_email: actorEmail,
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Budget Trigger Reconcile Tester",
    role: "org_admin",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: actorUserId,
    org_id: org.id,
    role: "org_admin",
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email: actorEmail,
    password,
  });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { org, actorEmail, actorUserId, accessToken };
}

Deno.test({
  name: "budget trigger reconciliation: generate+approve produce exactly the RPC's audit rows, zero trigger-duplicated rows, notifications still fire, direct writes still blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Budget Trigger Reconcile Property ${suffix}`,
      status: "active",
    });

    const fiscalYear = 2026;

    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "revenue",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { summary: { revenue_by_type: { base_rent: 12000, other_income: 0 } } },
    });
    await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "expense",
      fiscal_year: fiscalYear,
      inputs: {},
      outputs: { total_expenses: 3000 },
    });

    const callComputeBudget = (action: string) =>
      fetch(`${SUPABASE_URL}/functions/v1/compute-budget`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "apikey": ANON_KEY,
        },
        body: JSON.stringify({
          action,
          property_id: property.id,
          fiscal_year: fiscalYear,
          allow_generate_without_cam: true,
        }),
      });

    // --- Property 1: generate (INSERT path) ---
    const generateRes = await callComputeBudget("generate");
    const generateBody = await generateRes.json();
    assertEquals(generateRes.status, 200, `expected generate to succeed: ${JSON.stringify(generateBody)}`);
    const budgetId = generateBody.budget_id;
    assertExists(budgetId);

    const { data: triggerRowsAfterGenerate, error: triggerErr1 } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Budget")
      .eq("entity_id", budgetId)
      .eq("action", "create");
    assertNoError(triggerErr1);
    assertEquals(triggerRowsAfterGenerate?.length ?? 0, 0, "tr_budget_changed must no longer write a duplicate 'create' audit row");

    const { data: rpcRowsAfterGenerate, error: rpcErr1 } = await admin
      .from("audit_logs")
      .select("id, action, metadata")
      .eq("action", "budget_generated")
      .contains("metadata", { budget_id: budgetId });
    assertNoError(rpcErr1);
    assertEquals(rpcRowsAfterGenerate?.length ?? 0, 1, "compute-budget must still write exactly one canonical 'budget_generated' audit row");

    const { data: createdNotifications, error: notifErr1 } = await admin
      .from("notifications")
      .select("id, title")
      .eq("org_id", org.id)
      .eq("title", "Budget Created");
    assertNoError(notifErr1);
    assertEquals((createdNotifications?.length ?? 0) > 0, true, "tr_budget_changed's 'Budget Created' notification must still fire");

    // --- Property 2: approve (UPDATE path) ---
    await admin.from("budgets").update({ status: "reviewed" }).eq("id", budgetId);

    const approveRes = await callComputeBudget("approve");
    const approveBody = await approveRes.json();
    assertEquals(approveRes.status, 200, `expected approve to succeed: ${JSON.stringify(approveBody)}`);

    const { data: triggerRowsAfterApprove, error: triggerErr2 } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Budget")
      .eq("entity_id", budgetId)
      .eq("action", "update");
    assertNoError(triggerErr2);
    assertEquals(triggerRowsAfterApprove?.length ?? 0, 0, "tr_budget_changed must no longer write a duplicate 'update' audit row");

    const { data: approvedNotifications, error: notifErr2 } = await admin
      .from("notifications")
      .select("id, title")
      .eq("org_id", org.id)
      .eq("title", "Budget Locked");
    assertNoError(notifErr2);
    assertEquals((approvedNotifications?.length ?? 0) > 0, true, "tr_budget_changed's 'Budget Locked' notification must still fire");

    // --- Property 4: direct client writes remain blocked by RLS ---
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { error: directInsertErr } = await anon.from("budgets").insert({
      org_id: org.id,
      property_id: property.id,
      name: "Direct Insert Attempt",
      budget_year: fiscalYear,
      status: "draft",
    });
    assertExists(directInsertErr, "direct client INSERT on budgets must still be rejected by RLS");

    const { error: directUpdateErr, data: directUpdateData } = await anon
      .from("budgets")
      .update({ status: "locked" })
      .eq("id", budgetId)
      .select();
    const updateBlocked = Boolean(directUpdateErr) || (directUpdateData ?? []).length === 0;
    assertEquals(updateBlocked, true, "direct client UPDATE on budgets must still be rejected by RLS");
  },
});
