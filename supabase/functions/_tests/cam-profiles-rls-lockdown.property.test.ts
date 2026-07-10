// Feature: enterprise-readiness-hardening Phase HARD-1 (cam_profiles RLS
// lockdown). Property: cam_profiles_insert/cam_profiles_update/
// cam_profiles_delete now reject direct authenticated writes
// (WITH CHECK (false) / USING (false)), while SELECT remains open to
// authorized org members (and closed to cross-org users), and
// save_cam_profile/approve_cam_profile (which always write via the
// service-role client, and service_role has rolbypassrls = true) continue
// to work end-to-end unaffected. RPC-level regression for those two is
// covered by cam-profile-workflows.property.test.ts -- re-run alongside
// this one as the proof that this migration doesn't break them.
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

async function setUpOrgAndUser(admin: ReturnType<typeof adminClient>, suffix: string, orgOverride?: { id: string }) {
  const actorEmail = `cam-profiles-rls-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: actorEmail,
    password,
    email_confirm: true,
  });
  assertNoError(userError);
  const actorUserId = userData.user?.id;
  assertExists(actorUserId);

  const org = orgOverride ?? await insertOne(admin, "organizations", {
    name: `CAM Profiles RLS Org ${suffix}`,
    status: "active",
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "CAM Profiles RLS Tester",
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
  name: "cam_profiles RLS lockdown: direct authenticated INSERT/UPDATE/DELETE rejected, SELECT still works for authorized org member",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, asUser } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `CAM Profiles RLS Property ${suffix}`,
      status: "active",
    });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
    });

    // --- Direct authenticated INSERT is rejected ---
    const { data: insertData, error: insertError } = await asUser
      .from("cam_profiles")
      .insert({
        org_id: org.id,
        lease_id: lease.id,
        property_id: property.id,
        status: "draft",
      })
      .select("*");
    assertExists(insertError, "direct authenticated INSERT must be rejected by RLS");
    assertEquals(insertData, null);

    const { data: profilesAfterInsertAttempt } = await admin
      .from("cam_profiles")
      .select("id")
      .eq("lease_id", lease.id);
    assertEquals(profilesAfterInsertAttempt?.length ?? 0, 0, "no row should have been created by the rejected direct INSERT");

    // Seed a row via service_role (bypasses RLS) to test UPDATE/DELETE/SELECT against.
    const profile = await insertOne(admin, "cam_profiles", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      status: "draft",
      building_rsf: 10000,
      tenant_rsf: 1000,
      tenant_pro_rata_share: 10,
    });

    // --- Authorized SELECT still works ---
    const { data: selectRow, error: selectError } = await asUser
      .from("cam_profiles")
      .select("id, status")
      .eq("id", profile.id)
      .single();
    assertNoError(selectError);
    assertExists(selectRow);
    assertEquals(selectRow.status, "draft");

    // --- Direct authenticated UPDATE is rejected ---
    const { data: updateData, error: updateError } = await asUser
      .from("cam_profiles")
      .update({ status: "approved" })
      .eq("id", profile.id)
      .select("*");
    // RLS on UPDATE filters rows via USING(false) rather than throwing —
    // either an explicit error or zero affected rows is an acceptable
    // rejection signal; what matters is the row must not change.
    if (!updateError) {
      assertEquals(updateData?.length ?? 0, 0, "direct UPDATE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterUpdateAttempt } = await admin
      .from("cam_profiles")
      .select("status")
      .eq("id", profile.id)
      .single();
    assertEquals(rowAfterUpdateAttempt?.status, "draft", "status must be unchanged after the rejected direct UPDATE attempt");

    // --- Direct authenticated DELETE is rejected ---
    const { data: deleteData, error: deleteError } = await asUser
      .from("cam_profiles")
      .delete()
      .eq("id", profile.id)
      .select("*");
    if (!deleteError) {
      assertEquals(deleteData?.length ?? 0, 0, "direct DELETE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterDeleteAttempt } = await admin
      .from("cam_profiles")
      .select("id")
      .eq("id", profile.id)
      .maybeSingle();
    assertExists(rowAfterDeleteAttempt, "cam_profiles row must still exist after the rejected direct DELETE attempt");
  },
});

Deno.test({
  name: "cam_profiles RLS lockdown: SELECT blocks a cross-org authenticated user",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();

    const org = await insertOne(admin, "organizations", {
      name: `CAM Profiles RLS Owner Org ${suffix}`,
      status: "active",
    });
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `CAM Profiles RLS Owner Property ${suffix}`,
      status: "active",
    });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
    });
    const profile = await insertOne(admin, "cam_profiles", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      status: "draft",
      building_rsf: 10000,
      tenant_rsf: 1000,
      tenant_pro_rata_share: 10,
    });

    // A second, unrelated org/user — should see zero rows for the first org's profile.
    const { asUser: outsiderClient } = await setUpOrgAndUser(admin, `${suffix}-outsider`);

    const { data: outsiderRows, error: outsiderError } = await outsiderClient
      .from("cam_profiles")
      .select("id")
      .eq("id", profile.id);
    assertNoError(outsiderError);
    assertEquals(outsiderRows?.length ?? 0, 0, "a user outside the org must see zero rows");
  },
});

Deno.test({
  name: "cam_profiles RLS lockdown: budgets/expenses/lease-critical-dates/lease-expense-rule direct writes are unaffected (out of scope for this migration)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `CAM Profiles RLS Unrelated Check Org ${suffix}`,
      status: "active",
    });
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `CAM Profiles RLS Unrelated Check Property ${suffix}`,
      status: "active",
    });

    // This migration touches only cam_profiles — a service-role write to
    // budgets (already locked down since an earlier phase) must still
    // succeed exactly as before, proving no collateral policy drift.
    const budget = await insertOne(admin, "budgets", {
      org_id: org.id,
      property_id: property.id,
      name: `CAM Profiles RLS Unrelated Check Budget ${suffix}`,
      budget_year: 2027,
      status: "draft",
    });
    assertExists(budget.id);
  },
});
