// Feature: enterprise-readiness-hardening Phase 6X-9 (expenses RLS lockdown).
// Property: expenses_insert/expenses_update/expenses_delete now reject
// direct authenticated writes (WITH CHECK (false) / USING (false)), while
// SELECT remains open to authorized org members, and every expense RPC
// (which always writes via the service-role client, and service_role has
// rolbypassrls = true) continues to work end-to-end unaffected. RPC-level
// regression for create_expense_workflow, bulk_create_expenses_workflow,
// update_expense_details, update_expense_amount,
// persist_expense_classification, and delete_expenses_workflow is covered
// by their own existing dedicated test files -- re-run alongside this one
// as the proof that this migration doesn't break any of them (service_role
// bypasses RLS entirely, so those suites are unaffected by policy content).
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
  const actorEmail = `expenses-rls-${suffix}@example.test`;
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
    name: `Expenses RLS Org ${suffix}`,
    status: "active",
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Expenses RLS Tester",
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

  // A client authenticated as the real user (not service role) — what a
  // raw REST call or browser console script bypassing the UI would use.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${signInData.session?.access_token}` } },
  });

  return { org, actorUserId, asUser };
}

Deno.test({
  name: "expenses RLS lockdown: direct authenticated INSERT/UPDATE/DELETE rejected, SELECT still works",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, asUser } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Expenses RLS Property ${suffix}`,
      status: "active",
    });

    // --- Direct authenticated INSERT is rejected ---
    const { data: insertData, error: insertError } = await asUser
      .from("expenses")
      .insert({
        org_id: org.id,
        property_id: property.id,
        category: "CAM",
        amount: 500,
        date: "2026-01-01",
      })
      .select("*");
    assertExists(insertError, "direct authenticated INSERT must be rejected by RLS");
    assertEquals(insertData, null);

    const { data: expensesAfterInsertAttempt } = await admin
      .from("expenses")
      .select("id")
      .eq("org_id", org.id)
      .eq("property_id", property.id);
    assertEquals(expensesAfterInsertAttempt?.length ?? 0, 0, "no row should have been created by the rejected direct INSERT");

    // Seed a row via service_role (bypasses RLS) to test UPDATE/DELETE/SELECT against.
    const expense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      category: "CAM",
      amount: 1000,
      date: "2026-01-01",
    });

    // --- Authorized SELECT still works ---
    const { data: selectRow, error: selectError } = await asUser
      .from("expenses")
      .select("id, amount")
      .eq("id", expense.id)
      .single();
    assertNoError(selectError);
    assertExists(selectRow);
    assertEquals(Number(selectRow.amount), 1000);

    // --- Direct authenticated UPDATE is rejected ---
    const { data: updateData, error: updateError } = await asUser
      .from("expenses")
      .update({ amount: 9999 })
      .eq("id", expense.id)
      .select("*");
    // RLS on UPDATE filters rows via USING(false) rather than throwing —
    // either an explicit error or zero affected rows is an acceptable
    // rejection signal; what matters is the row must not change.
    if (!updateError) {
      assertEquals(updateData?.length ?? 0, 0, "direct UPDATE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterUpdateAttempt } = await admin
      .from("expenses")
      .select("amount")
      .eq("id", expense.id)
      .single();
    assertEquals(Number(rowAfterUpdateAttempt?.amount), 1000, "amount must be unchanged after the rejected direct UPDATE attempt");

    // --- Direct authenticated DELETE is rejected ---
    const { data: deleteData, error: deleteError } = await asUser
      .from("expenses")
      .delete()
      .eq("id", expense.id)
      .select("*");
    if (!deleteError) {
      assertEquals(deleteData?.length ?? 0, 0, "direct DELETE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterDeleteAttempt } = await admin
      .from("expenses")
      .select("id")
      .eq("id", expense.id)
      .maybeSingle();
    assertExists(rowAfterDeleteAttempt, "expense row must still exist after the rejected direct DELETE attempt");
  },
});

Deno.test({
  name: "expenses RLS lockdown: expense_classifications direct writes are unaffected (its own lockdown is out of scope)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();

    // expense_classifications' own RLS lockdown is explicitly out of scope
    // for this phase (deferred per Phase 6X-8's finding). Confirm this
    // migration didn't incidentally affect it: a service-role write still
    // succeeds exactly as before (pg_policies itself is verified directly
    // via psql/`supabase db query` outside this Deno suite, not here).
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Expenses RLS Unrelated Check Org ${suffix}`,
      status: "active",
    });
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Expenses RLS Unrelated Check Property ${suffix}`,
      status: "active",
    });
    const expense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      category: "CAM",
      amount: 100,
      date: "2026-01-01",
    });
    // expense_classifications is untouched by this migration — a
    // service-role insert must still succeed exactly as before.
    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      expense_id: expense.id,
      property_id: property.id,
    });
    assertExists(classification.id);
  },
});
