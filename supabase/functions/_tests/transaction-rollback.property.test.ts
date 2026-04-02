// @ts-nocheck
/**
 * Property-Based Test: Transaction Rollback on Error
 * Feature: backend-driven-pipeline, Task 6.6
 *
 * **Validates: Requirements 4.5, 15.3**
 *
 * Property 15: Transaction Rollback on Error
 * If store-data fails (e.g., file not in 'validated' status), no records should
 * be inserted.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STORE_DATA_URL = `${SUPABASE_URL}/functions/v1/store-data`;

function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
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

async function createFileWithStatus(
  adminClient: any,
  orgId: string,
  moduleType: string,
  status: string,
  validData?: Record<string, unknown>[],
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
      status,
      valid_data: validData ?? null,
      valid_count: validData?.length ?? 0,
      error_count: 0,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create file: ${error.message}`);
  return data;
}

const TABLE_MAP: Record<string, string> = {
  leases: "leases",
  expenses: "expenses",
  properties: "properties",
  revenue: "revenues",
};

async function cleanup(adminClient: any, orgId: string, userId: string, fileIds: string[]) {
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

/** Statuses that are NOT 'validated' — store-data should reject these */
const invalidStatusArb = fc.constantFrom(
  "uploaded",
  "parsing",
  "parsed",
  "validating",
  "storing",
  "stored",
  "failed",
);

const moduleTypeArb = fc.constantFrom("leases", "expenses", "properties", "revenue");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 15: Transaction Rollback - non-validated status causes rejection with no inserts",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        invalidStatusArb,
        moduleTypeArb,
        async (badStatus, moduleType) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];
          const tableName = TABLE_MAP[moduleType];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            // Count rows before the call
            const { count: beforeCount } = await adminClient
              .from(tableName)
              .select("id", { count: "exact", head: true })
              .eq("org_id", org.id);

            const validData = [{ tenant_name: "Tenant A", start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1500 }];
            const fileRecord = await createFileWithStatus(adminClient, org.id, moduleType, badStatus, validData);
            fileIds.push(fileRecord.id);

            const response = await fetch(STORE_DATA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${user.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ file_id: fileRecord.id }),
            });

            const result = await response.json();

            // Property: store-data must return an error for non-validated status
            assertEquals(
              result.error,
              true,
              `store-data must fail for status '${badStatus}'. Got: ${JSON.stringify(result)}`,
            );
            assertExists(result.message, "Error response must include a message");

            // Property: no rows should have been inserted
            const { count: afterCount } = await adminClient
              .from(tableName)
              .select("id", { count: "exact", head: true })
              .eq("org_id", org.id);

            assertEquals(
              afterCount,
              beforeCount,
              `No rows should be inserted when status is '${badStatus}'. Before: ${beforeCount}, After: ${afterCount}`,
            );

            await cleanup(adminClient, org.id, user.userId, fileIds);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds);
            throw err;
          }
        },
      ),
      { numRuns: 50 },
    );
  },
});

Deno.test({
  name: "Property 15: Transaction Rollback - non-existent file_id returns error with no inserts",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        moduleTypeArb,
        async (fakeFileId, moduleType) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const tableName = TABLE_MAP[moduleType];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const { count: beforeCount } = await adminClient
              .from(tableName)
              .select("id", { count: "exact", head: true })
              .eq("org_id", org.id);

            const response = await fetch(STORE_DATA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${user.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ file_id: fakeFileId }),
            });

            const result = await response.json();

            assertEquals(result.error, true, "Non-existent file_id must return error");

            const { count: afterCount } = await adminClient
              .from(tableName)
              .select("id", { count: "exact", head: true })
              .eq("org_id", org.id);

            assertEquals(
              afterCount,
              beforeCount,
              "No rows should be inserted for non-existent file",
            );

            await cleanup(adminClient, org.id, user.userId, []);
          } catch (err) {
            await cleanup(adminClient, org.id, "", []);
            throw err;
          }
        },
      ),
      { numRuns: 50 },
    );
  },
});
