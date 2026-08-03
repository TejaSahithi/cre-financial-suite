// @ts-nocheck
// Real-database security tests for public.publish_computation_snapshot()
// (20260902000000_snapshot_publish_rpc.sql).
//
// Requires a live Supabase/Postgres instance (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY) — same requirement as
// _tests/snapshot-publish-concurrency.test.ts. Skipped with a clear
// message if those aren't set.
//
// What this proves, concretely, not just by reading the GRANT statements:
//   1. An anonymous (unauthenticated) client cannot execute the RPC at all.
//   2. A real signed-in user's own session (the `authenticated` Postgres
//      role PostgREST maps JWTs to) cannot execute it either — even though
//      that user is a legitimate member of a real organization, and even
//      when asked to publish into THEIR OWN org_id. Browser clients, even
//      logged-in ones, are not a valid path to this function under any
//      circumstances; only service_role (used exclusively by Edge
//      Functions) is.
//   3. service_role CAN execute it (positive control — proves 1/2 fail for
//      the intended reason, "no grant", not because of some unrelated
//      client-construction problem).
import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function skipIfNoLiveDb(): boolean {
  if (!SERVICE_ROLE_KEY || !ANON_KEY) {
    console.warn("[snapshot-publish-security] SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY not set — skipping live-DB security tests.");
    return true;
  }
  return false;
}

function samplePublishArgs(overrides: Record<string, unknown> = {}) {
  return {
    p_org_id: crypto.randomUUID(),
    p_property_id: null,
    // "budget" (a documented legacy/annual-only engine, see
    // _shared/scope.ts's LEGACY_SCOPE_DEFAULT_ENGINES) rather than "cam" —
    // cam requires a non-null property_id/scope_level/scope_id per
    // computation_snapshots_cam_requires_scope_check
    // (20260901000000_cam_scope_columns.sql), which is irrelevant noise for
    // a test that's purely about the EXECUTE grant, not about scope rules.
    p_engine_type: "budget",
    p_scope_level: null,
    p_scope_id: null,
    p_fiscal_year: 2099,
    p_engine_version: "cam-v1.0",
    p_input_hash: "security-test-hash",
    p_inputs: { marker: "security-test" },
    p_outputs: { total_cam: 1 },
    p_computed_by: "security-test",
    ...overrides,
  };
}

Deno.test({
  name: "SECURITY: an anonymous (unauthenticated) client cannot execute publish_computation_snapshot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const anon = anonClient();
    const { data, error } = await anon.rpc("publish_computation_snapshot", samplePublishArgs());
    assertExists(error, "anon must be rejected — got data instead: " + JSON.stringify(data));
    // PostgREST surfaces a missing-privilege error (permission denied for
    // function, or "not found" for the RPC route when Postgres reports the
    // caller has no visibility into the function at all) — assert on the
    // absence of a successful result rather than a specific message string,
    // since PostgREST's exact wording is not a stable contract to pin a
    // test to.
    assertEquals(data, null);
  },
});

Deno.test({
  name: "SECURITY: a real signed-in user (authenticated role) cannot execute publish_computation_snapshot, even for their own organization",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const email = `snapshot-security-${suffix}@example.test`;
    const password = `Pass-${suffix}!`;

    const { data: userData, error: userErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assertExists(userData?.user?.id, `test user creation must succeed: ${userErr?.message}`);

    const { data: org, error: orgErr } = await admin.from("organizations").insert({
      name: `snapshot-security-org-${suffix}`, status: "active", primary_contact_email: email,
    }).select("id").single();
    assertExists(org?.id, `test org creation must succeed: ${orgErr?.message}`);

    await admin.from("profiles").upsert({ id: userData.user.id, email, full_name: "Snapshot Security Tester", role: "org_admin", status: "active" });
    await admin.from("memberships").insert({ user_id: userData.user.id, org_id: org.id, role: "org_admin" });

    try {
      const anon = anonClient();
      const { data: signInData, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
      assertExists(signInData?.session?.access_token, `sign-in must succeed: ${signInErr?.message}`);

      const asUser = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${signInData.session.access_token}` } },
      });

      // Ask it to publish into the user's OWN, real, legitimate org — the
      // most sympathetic possible case for "should this be allowed" — and
      // confirm it is still rejected. This is what actually proves the
      // security boundary is the GRANT, not merely that a bad org_id
      // happened to fail; a permissive RPC would succeed here.
      const { data, error } = await asUser.rpc("publish_computation_snapshot", samplePublishArgs({ p_org_id: org.id }));
      assertExists(error, "an authenticated user, even publishing into their own real org, must be rejected: " + JSON.stringify(data));
      assertEquals(data, null);

      // Confirm nothing was written despite the attempt.
      const { data: rows } = await admin.from("computation_snapshots").select("id").eq("org_id", org.id).eq("fiscal_year", 2099);
      assertEquals((rows ?? []).length, 0, "the rejected call must not have written anything");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
      await admin.auth.admin.deleteUser(userData.user.id);
    }
  },
});

Deno.test({
  name: "SECURITY (positive control): service_role CAN execute publish_computation_snapshot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (skipIfNoLiveDb()) return;
    const admin = adminClient();
    const { data: org } = await admin.from("organizations").insert({
      name: `snapshot-security-control-${crypto.randomUUID()}`, status: "active", primary_contact_email: `control-${crypto.randomUUID()}@example.test`,
    }).select("id").single();
    try {
      const { data, error } = await admin.rpc("publish_computation_snapshot", samplePublishArgs({ p_org_id: org.id }));
      assert(!error, `service_role must be allowed to execute this RPC: ${error?.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      assertExists(row?.id, "a real snapshot row must be returned for the allowed caller");
    } finally {
      await admin.from("organizations").delete().eq("id", org.id);
    }
  },
});
