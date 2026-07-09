// Feature: enterprise-readiness-hardening Phase 2
// Property: approving a lease over HTTP (the real approve-lease-workflow
// edge function, not just the RPC) synchronously produces both an immutable
// lease_abstract_versions row and rent_schedules rows in the same
// request/response cycle, and re-invoking with the same idempotency key does
// not duplicate either.
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
  if (error) {
    throw new Error(JSON.stringify(error));
  }
}

async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}

Deno.test({
  name: "HTTP approve-lease-workflow: synchronous rent schedule + immutable version history, idempotent replay",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actorEmail = `rent-schedule-atomicity-${suffix}@example.test`;
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
      name: `Rent Schedule Atomicity Org ${suffix}`,
      status: "active",
      primary_contact_email: actorEmail,
    });

    await admin.from("profiles").upsert({
      id: actorUserId,
      email: actorEmail,
      full_name: "Rent Schedule Atomicity Tester",
      role: "user",
      status: "active",
    });

    await insertOne(admin, "memberships", {
      user_id: actorUserId,
      org_id: org.id,
      role: "org_admin",
    });

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Rent Schedule Atomicity Property ${suffix}`,
      status: "active",
    });

    const tenant = await insertOne(admin, "tenants", {
      org_id: org.id,
      name: `Tenant ${suffix}`,
      email: `tenant-${actorEmail}`,
      status: "active",
    });

    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      status: "pending",
      monthly_rent: 5000,
      square_footage: 1000,
      abstract_status: "draft",
      abstract_version: 0,
    });

    // Sign in as the real user so the request goes through the same
    // verifyUser/getUserOrgId/assertPageAccess path a browser client hits —
    // not the internal-service-key bypass.
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
      email: actorEmail,
      password,
    });
    assertNoError(signInError);
    const accessToken = signInData.session?.access_token;
    assertExists(accessToken);

    const idempotencyKey = `approve-${suffix}`;
    const approvalBody = {
      lease_id: lease.id,
      signed_by: "Rent Schedule Atomicity Tester",
      signed_at: "2026-01-01T12:00:00.000Z",
      approval_comments: "Atomicity test approval",
      approval_document_url: "https://example.test/approved-lease.pdf",
      field_reviews: {
        start_date: { status: "accepted", value: "2026-01-01" },
      },
      idempotency_key: idempotencyKey,
    };

    const callApprove = () =>
      fetch(`${SUPABASE_URL}/functions/v1/approve-lease-workflow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "apikey": ANON_KEY,
        },
        body: JSON.stringify(approvalBody),
      });

    const firstRes = await callApprove();
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, `first approval failed: ${JSON.stringify(firstBody)}`);
    assertEquals(firstBody.error, false);
    assertEquals(firstBody.already_approved, false);
    assertExists(firstBody.abstract_version_id, "response must include the new lease_abstract_versions row id");
    assertExists(firstBody.rent_schedule, "response must include rent_schedule status");
    assertEquals(firstBody.rent_schedule.status, "ok", `rent schedule generation failed: ${JSON.stringify(firstBody.rent_schedule)}`);

    const { data: versionRows, error: versionError } = await admin
      .from("lease_abstract_versions")
      .select("*")
      .eq("lease_id", lease.id);
    assertNoError(versionError);
    assertEquals(versionRows?.length, 1, "exactly one immutable version row after first approval");
    assertEquals(versionRows?.[0]?.version, 1);

    const { data: scheduleRows, error: scheduleError } = await admin
      .from("rent_schedules")
      .select("*")
      .eq("lease_id", lease.id)
      .eq("status", "approved");
    assertNoError(scheduleError);
    assertExists(scheduleRows);
    assertEquals((scheduleRows?.length ?? 0) > 0, true, "rent_schedules rows must exist after synchronous approval");

    // Idempotent replay: same idempotency key must not duplicate either table.
    const secondRes = await callApprove();
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, `retry failed: ${JSON.stringify(secondBody)}`);
    assertEquals(secondBody.abstract_version_id, firstBody.abstract_version_id);

    const { data: versionRowsAfterRetry, error: versionRetryError } = await admin
      .from("lease_abstract_versions")
      .select("*")
      .eq("lease_id", lease.id);
    assertNoError(versionRetryError);
    assertEquals(versionRowsAfterRetry?.length, 1, "retry must not duplicate the version-history row");

    const { data: scheduleRowsAfterRetry, error: scheduleRetryError } = await admin
      .from("rent_schedules")
      .select("*")
      .eq("lease_id", lease.id)
      .eq("status", "approved");
    assertNoError(scheduleRetryError);
    assertEquals(
      scheduleRowsAfterRetry?.length,
      scheduleRows?.length,
      "retry must not duplicate rent_schedules rows",
    );
  },
});
