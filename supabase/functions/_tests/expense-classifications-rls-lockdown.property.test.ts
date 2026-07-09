// Feature: enterprise-readiness-hardening Phase 6X-11 (expense_classifications
// RLS lockdown). Property: expense_classifications_insert/_update/_delete now
// reject direct authenticated writes (WITH CHECK (false) / USING (false)),
// while SELECT remains open to authorized org members, and every
// expense_classifications RPC (which always writes via the service-role
// client, and service_role has rolbypassrls = true) continues to work
// end-to-end unaffected. RPC-level regression for persist_expense_classification,
// review_expense_classification, manual_override_expense_classification,
// save_lease_rule_amount_cam_input, and delete_expenses_workflow's cascade is
// covered by their own existing dedicated test files -- re-run alongside this
// one as the proof that this migration doesn't break any of them.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

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
  const actorEmail = `expense-classifications-rls-${suffix}@example.test`;
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
    name: `Expense Classifications RLS Org ${suffix}`,
    status: "active",
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Expense Classifications RLS Tester",
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

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${signInData.session?.access_token}` } },
  });

  return { org, actorUserId, asUser };
}

Deno.test({
  name: "expense_classifications RLS lockdown: direct authenticated INSERT/UPDATE/DELETE rejected, SELECT still works",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, asUser } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Expense Classifications RLS Property ${suffix}`,
      status: "active",
    });
    const expense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      category: "CAM",
      amount: 500,
      date: "2026-01-01",
    });

    // --- Direct authenticated INSERT is rejected ---
    const { data: insertData, error: insertError } = await asUser
      .from("expense_classifications")
      .insert({
        org_id: org.id,
        expense_id: expense.id,
        property_id: property.id,
      })
      .select("*");
    assertExists(insertError, "direct authenticated INSERT must be rejected by RLS");
    assertEquals(insertData, null);

    const { data: classificationsAfterInsertAttempt } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("org_id", org.id)
      .eq("expense_id", expense.id);
    assertEquals(classificationsAfterInsertAttempt?.length ?? 0, 0, "no row should have been created by the rejected direct INSERT");

    // Seed a row via service_role (bypasses RLS) to test UPDATE/DELETE/SELECT against.
    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      expense_id: expense.id,
      property_id: property.id,
      recovery_status: "needs_review",
    });

    // --- Authorized SELECT still works ---
    const { data: selectRow, error: selectError } = await asUser
      .from("expense_classifications")
      .select("id, recovery_status")
      .eq("id", classification.id)
      .single();
    assertNoError(selectError);
    assertExists(selectRow);
    assertEquals(selectRow.recovery_status, "needs_review");

    // --- Direct authenticated UPDATE is rejected ---
    const { data: updateData, error: updateError } = await asUser
      .from("expense_classifications")
      .update({ recovery_status: "recoverable" })
      .eq("id", classification.id)
      .select("*");
    if (!updateError) {
      assertEquals(updateData?.length ?? 0, 0, "direct UPDATE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterUpdateAttempt } = await admin
      .from("expense_classifications")
      .select("recovery_status")
      .eq("id", classification.id)
      .single();
    assertEquals(rowAfterUpdateAttempt?.recovery_status, "needs_review", "recovery_status must be unchanged after the rejected direct UPDATE attempt");

    // --- Direct authenticated DELETE is rejected ---
    const { data: deleteData, error: deleteError } = await asUser
      .from("expense_classifications")
      .delete()
      .eq("id", classification.id)
      .select("*");
    if (!deleteError) {
      assertEquals(deleteData?.length ?? 0, 0, "direct DELETE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterDeleteAttempt } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("id", classification.id)
      .maybeSingle();
    assertExists(rowAfterDeleteAttempt, "expense_classifications row must still exist after the rejected direct DELETE attempt");
  },
});

Deno.test({
  name: "expense_classifications RLS lockdown: expenses lockdown from Phase 6X-9 remains unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, asUser } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Expenses Reciprocal Check Property ${suffix}`,
      status: "active",
    });

    const { data: insertData, error: insertError } = await asUser
      .from("expenses")
      .insert({
        org_id: org.id,
        property_id: property.id,
        category: "CAM",
        amount: 250,
        date: "2026-01-01",
      })
      .select("*");
    assertExists(insertError, "expenses direct INSERT must still be rejected (Phase 6X-9 lockdown unaffected)");
    assertEquals(insertData, null);
  },
});
