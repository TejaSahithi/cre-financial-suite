// @ts-nocheck
/**
 * Property-Based Test: Audit Log Immutability
 * Feature: backend-driven-pipeline, Task 6.10
 *
 * **Validates: Requirements 12.4**
 *
 * Property 40: Audit Log Immutability
 * Audit log entries must not be modifiable after creation (RLS policy test).
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STORE_DATA_URL = `${SUPABASE_URL}/functions/v1/store-data`;

function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function createUserClient(accessToken: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestOrg(adminClient: any, orgName: string) {
  const { data, error } = await adminClient
    .from("organizations")
    .insert({ name: orgName, status: "active" })
    .select()
    .single();
  if (error) throw new Error(`Failed to create org: ${error.message}`);
  return data;
}

async function createTestUser(adminClient: any, email: string, orgId: string) {
  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (authError) throw new Error(`Failed to create user: ${authError.message}`);

  const { error: membershipError } = await adminClient.from("memberships").insert({
    user_id: authData.user.id,
    org_id: orgId,
    role: "member",
    status: "active",
  });
  if (membershipError) throw new Error(`Failed to create membership: ${membershipError.message}`);

  const { data: sessionData, error: sessionError } = await adminClient.auth.signInWithPassword({
    email,
    password: "test-password-123",
  });
  if (sessionError) throw new Error(`Failed to sign in: ${sessionError.message}`);

  return { userId: authData.user.id, accessToken: sessionData.session.access_token };
}

async function createValidatedFile(
  adminClient: any,
  orgId: string,
  moduleType: string,
  validData: Record<string, unknown>[],
) {
  const fileId = crypto.randomUUID();
  const { data, error } = await adminClient
    .from("uploaded_files")
    .insert({
      id: fileId,
      org_id: orgId,
      module_type: moduleType,
      file_name: `test-${moduleType}.csv`,
      file_url: `test/${fileId}`,
      file_size: 100,
      mime_type: "text/csv",
      status: "validated",
      valid_data: validData,
      valid_count: validData.length,
      error_count: 0,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create validated file: ${error.message}`);
  return data;
}

const TABLE_MAP: Record<string, string> = {
  leases: "leases",
  expenses: "expenses",
  properties: "properties",
  revenue: "revenues",
};

async function cleanup(
  adminClient: any,
  orgId: string,
  userId: string,
  fileIds: string[],
  tableName?: string,
) {
  await adminClient.from("audit_logs").delete().eq("org_id", orgId);
  if (tableName) {
    await adminClient.from(tableName).delete().eq("org_id", orgId);
  }
  for (const fileId of fileIds) {
    await adminClient.from("uploaded_files").delete().eq("id", fileId);
  }
  if (userId) {
    await adminClient.from("memberships").delete().eq("user_id", userId);
    await adminClient.auth.admin.deleteUser(userId);
  }
  await adminClient.from("organizations").delete().eq("id", orgId);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const moduleTypeArb = fc.constantFrom("leases", "expenses", "properties", "revenue");

function validRowsFor(moduleType: string): Record<string, unknown>[] {
  switch (moduleType) {
    case "leases":
      return [{ tenant_name: "Tenant A", start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1000 }];
    case "expenses":
      return [{ category: "Maintenance", amount: 500, date: "2024-03-15" }];
    case "properties":
      return [{ name: "Main Office" }];
    case "revenue":
      return [{ revenue_type: "base_rent", amount: 2000 }];
    default:
      return [];
  }
}

/** Arbitrary tampered new_value strings */
const tamperedValueArb = fc.oneof(
  fc.constant("tampered"),
  fc.constant("{}"),
  fc.constant(null),
  fc.string({ minLength: 1, maxLength: 20 }),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 40: Audit Log Immutability - user cannot UPDATE audit_log entries",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        moduleTypeArb,
        tamperedValueArb,
        async (moduleType, tamperedValue) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];
          const tableName = TABLE_MAP[moduleType];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const validData = validRowsFor(moduleType);
            const fileRecord = await createValidatedFile(adminClient, org.id, moduleType, validData);
            fileIds.push(fileRecord.id);

            // Trigger store-data to create an audit log
            const response = await fetch(STORE_DATA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${user.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ file_id: fileRecord.id }),
            });

            const result = await response.json();
            assertEquals(result.error, false, `store-data must succeed. Error: ${result.message}`);

            // Fetch the audit log entry
            const { data: auditLogs } = await adminClient
              .from("audit_logs")
              .select("id, new_value")
              .eq("entity_id", fileRecord.id)
              .eq("action", "create");

            assertExists(auditLogs, "Must find audit log entries");
            assertEquals((auditLogs ?? []).length > 0, true, "Must have at least one audit log");

            const auditLogId = auditLogs![0].id;
            const originalValue = auditLogs![0].new_value;

            // Attempt to UPDATE the audit log using the user's client (RLS should block this)
            const userClient = createUserClient(user.accessToken);
            const { error: updateError } = await userClient
              .from("audit_logs")
              .update({ new_value: tamperedValue })
              .eq("id", auditLogId);

            // Property: update must be blocked by RLS
            assertExists(
              updateError,
              `User must not be able to update audit_log entry. Update should have been blocked.`,
            );

            // Property: verify the value was NOT changed
            const { data: afterUpdate } = await adminClient
              .from("audit_logs")
              .select("new_value")
              .eq("id", auditLogId)
              .single();

            assertEquals(
              afterUpdate?.new_value,
              originalValue,
              `audit_log new_value must not change after blocked update attempt`,
            );

            await cleanup(adminClient, org.id, user.userId, fileIds, tableName);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds, tableName);
            throw err;
          }
        },
      ),
      { numRuns: 50 },
    );
  },
});

Deno.test({
  name: "Property 40: Audit Log Immutability - user cannot DELETE audit_log entries",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        moduleTypeArb,
        async (moduleType) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];
          const tableName = TABLE_MAP[moduleType];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const validData = validRowsFor(moduleType);
            const fileRecord = await createValidatedFile(adminClient, org.id, moduleType, validData);
            fileIds.push(fileRecord.id);

            await fetch(STORE_DATA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${user.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ file_id: fileRecord.id }),
            });

            // Fetch audit log
            const { data: auditLogs } = await adminClient
              .from("audit_logs")
              .select("id")
              .eq("entity_id", fileRecord.id)
              .eq("action", "create");

            assertExists(auditLogs, "Must find audit log entries");
            assertEquals((auditLogs ?? []).length > 0, true, "Must have at least one audit log");

            const auditLogId = auditLogs![0].id;

            // Attempt to DELETE the audit log using the user's client
            const userClient = createUserClient(user.accessToken);
            const { error: deleteError } = await userClient
              .from("audit_logs")
              .delete()
              .eq("id", auditLogId);

            // Property: delete must be blocked by RLS
            assertExists(
              deleteError,
              "User must not be able to delete audit_log entries",
            );

            // Property: verify the entry still exists
            const { data: stillExists } = await adminClient
              .from("audit_logs")
              .select("id")
              .eq("id", auditLogId)
              .single();

            assertExists(stillExists, "audit_log entry must still exist after blocked delete");

            await cleanup(adminClient, org.id, user.userId, fileIds, tableName);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds, tableName);
            throw err;
          }
        },
      ),
      { numRuns: 50 },
    );
  },
});
