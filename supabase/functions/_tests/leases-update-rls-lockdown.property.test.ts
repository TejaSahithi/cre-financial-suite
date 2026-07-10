// Feature: enterprise-readiness-hardening Phase HARD-3B3B (leases UPDATE
// RLS lockdown). Property: leases_update now rejects direct authenticated
// UPDATE (USING(false)/WITH CHECK(false)) for both an org admin who
// previously passed the write-page check and a non-writer, while
// SELECT/INSERT/DELETE remain exactly as before (unchanged policies), and
// every lease-mutating RPC (which always writes via the service-role
// client, and service_role has rolbypassrls = true) continues to work
// end-to-end unaffected. RPC-level regression for update_lease_extraction_field,
// save_lease_review_draft, reject_lease_abstract,
// send_lease_back_for_reextraction, update_lease_field_and_columns,
// backfill_lease_evidence, persist_lease_extraction_merge,
// link_lease_space_assignment, and approve_lease_workflow is covered by
// their own existing dedicated test files -- re-run alongside this one as
// the proof this migration doesn't break any of them.
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

async function createOrgUser(admin: ReturnType<typeof adminClient>, suffix: string, orgId: string, role: string) {
  const email = `leases-update-rls-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assertNoError(userError);
  const userId = userData.user?.id;
  assertExists(userId);

  await admin.from("profiles").upsert({
    id: userId,
    email,
    full_name: "Leases Update RLS Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  return { userId, email, asUser };
}

Deno.test({
  name: "leases RLS lockdown: direct authenticated UPDATE is rejected for an org admin who previously had write access; SELECT/INSERT/DELETE unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Leases Update RLS Org ${suffix}`,
      status: "active",
    });
    const { asUser } = await createOrgUser(admin, suffix, org.id, "org_admin");
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Leases Update RLS Property ${suffix}`,
      status: "active",
    });

    // Seed a lease via service_role (bypasses RLS) to test UPDATE/SELECT
    // against.
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Tenant ${suffix}`,
      status: "active",
      monthly_rent: 1000,
    });

    // --- Authorized SELECT still works ---
    const { data: selectRow, error: selectError } = await asUser
      .from("leases")
      .select("id, monthly_rent")
      .eq("id", lease.id)
      .single();
    assertNoError(selectError);
    assertExists(selectRow);
    assertEquals(Number(selectRow.monthly_rent), 1000);

    // --- Direct authenticated UPDATE is rejected (org admin, previously had write access) ---
    const { data: updateData, error: updateError } = await asUser
      .from("leases")
      .update({ monthly_rent: 9999 })
      .eq("id", lease.id)
      .select("*");
    // RLS on UPDATE filters rows via USING(false) rather than throwing --
    // either an explicit error or zero affected rows is an acceptable
    // rejection signal; what matters is the row must not change.
    if (!updateError) {
      assertEquals(updateData?.length ?? 0, 0, "direct UPDATE must affect zero rows if it doesn't error");
    }
    const { data: rowAfterUpdateAttempt } = await admin
      .from("leases")
      .select("monthly_rent")
      .eq("id", lease.id)
      .single();
    assertEquals(Number(rowAfterUpdateAttempt?.monthly_rent), 1000, "monthly_rent must be unchanged after the rejected direct UPDATE attempt");

    // --- INSERT policy unchanged: an org admin can still directly INSERT a lease ---
    const { data: insertedLease, error: insertError } = await asUser
      .from("leases")
      .insert({
        org_id: org.id,
        property_id: property.id,
        tenant_name: `Direct Insert Tenant ${suffix}`,
        status: "active",
      })
      .select("*")
      .single();
    assertNoError(insertError);
    assertExists(insertedLease, "leases_insert policy must remain unchanged (still permits a direct INSERT)");

    // --- DELETE policy unchanged: an org admin can still directly DELETE a lease ---
    const { error: deleteError } = await asUser
      .from("leases")
      .delete()
      .eq("id", insertedLease.id);
    assertNoError(deleteError);
    const { data: rowAfterDelete } = await admin
      .from("leases")
      .select("id")
      .eq("id", insertedLease.id)
      .maybeSingle();
    assertEquals(rowAfterDelete, null, "leases_delete policy must remain unchanged (still permits a direct DELETE)");
  },
});

Deno.test({
  name: "leases RLS lockdown: direct authenticated UPDATE is rejected for a non-writer (viewer) too",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", {
      name: `Leases Update RLS Non-Writer Org ${suffix}`,
      status: "active",
    });
    const { asUser } = await createOrgUser(admin, suffix, org.id, "viewer");
    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Leases Update RLS Non-Writer Property ${suffix}`,
      status: "active",
    });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Tenant ${suffix}`,
      status: "active",
      monthly_rent: 2000,
    });

    const { data: updateData, error: updateError } = await asUser
      .from("leases")
      .update({ monthly_rent: 8888 })
      .eq("id", lease.id)
      .select("*");
    if (!updateError) {
      assertEquals(updateData?.length ?? 0, 0, "direct UPDATE must affect zero rows if it doesn't error");
    }
    const { data: rowAfter } = await admin.from("leases").select("monthly_rent").eq("id", lease.id).single();
    assertEquals(Number(rowAfter?.monthly_rent), 2000, "the lease must survive the rejected direct UPDATE attempt");
  },
});

Deno.test({
  name: "leases RLS lockdown: cross-org SELECT remains blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const ownerOrg = await insertOne(admin, "organizations", {
      name: `Leases Update RLS Owner Org ${suffix}`,
      status: "active",
    });
    const outsiderOrg = await insertOne(admin, "organizations", {
      name: `Leases Update RLS Outsider Org ${suffix}`,
      status: "active",
    });
    const { asUser: outsiderClient } = await createOrgUser(admin, `${suffix}-outsider`, outsiderOrg.id, "org_admin");
    const ownerProperty = await insertOne(admin, "properties", {
      org_id: ownerOrg.id,
      name: `Owner Property ${suffix}`,
      status: "active",
    });
    const lease = await insertOne(admin, "leases", {
      org_id: ownerOrg.id,
      property_id: ownerProperty.id,
      tenant_name: `Owner Tenant ${suffix}`,
      status: "active",
    });

    const { data: outsiderRows, error: outsiderError } = await outsiderClient
      .from("leases")
      .select("id")
      .eq("id", lease.id);
    assertNoError(outsiderError);
    assertEquals(outsiderRows?.length ?? 0, 0, "a user outside the org must see zero rows");
  },
});
