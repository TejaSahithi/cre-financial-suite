// @ts-nocheck
/**
 * Property-Based Test: Automatic Timestamp Population
 * Feature: backend-driven-pipeline, Task 6.7
 *
 * **Validates: Requirements 4.6**
 *
 * Property 16: Automatic Timestamp Population
 * For any stored record, created_at and updated_at must be set to a valid ISO timestamp.
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

function validRowsFor(moduleType: string, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => {
    switch (moduleType) {
      case "leases":
        return { tenant_name: `Tenant ${i + 1}`, start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1200 };
      case "expenses":
        return { category: "Insurance", amount: 800, date: "2024-07-01" };
      case "properties":
        return { name: `Office Park ${i + 1}` };
      case "revenue":
        return { revenue_type: "percentage_rent", amount: 1500 };
      default:
        return {};
    }
  });
}

const rowCountArb = fc.integer({ min: 1, max: 3 });

// ISO 8601 timestamp pattern
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 16: Automatic Timestamp Population - created_at and updated_at are valid ISO timestamps",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        moduleTypeArb,
        rowCountArb,
        async (moduleType, rowCount) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];
          const tableName = TABLE_MAP[moduleType];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const validData = validRowsFor(moduleType, rowCount);
            const fileRecord = await createValidatedFile(adminClient, org.id, moduleType, validData);
            fileIds.push(fileRecord.id);

            const beforeStore = new Date();

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

            const afterStore = new Date();

            // Fetch inserted rows
            const { data: dbRows } = await adminClient
              .from(tableName)
              .select("id, created_at, updated_at")
              .eq("org_id", org.id)
              .order("created_at", { ascending: false })
              .limit(rowCount);

            assertExists(dbRows, "Must find inserted rows");
            assertEquals(
              (dbRows ?? []).length,
              rowCount,
              `Must find ${rowCount} rows`,
            );

            for (const row of dbRows ?? []) {
              // Property: created_at must be a valid ISO timestamp
              assertExists(row.created_at, `Row ${row.id} must have created_at`);
              assertEquals(
                ISO_TIMESTAMP_RE.test(row.created_at),
                true,
                `created_at '${row.created_at}' must be a valid ISO timestamp`,
              );

              // Property: updated_at must be a valid ISO timestamp
              assertExists(row.updated_at, `Row ${row.id} must have updated_at`);
              assertEquals(
                ISO_TIMESTAMP_RE.test(row.updated_at),
                true,
                `updated_at '${row.updated_at}' must be a valid ISO timestamp`,
              );

              // Property: timestamps must be within the test window
              const createdAt = new Date(row.created_at);
              assertEquals(
                createdAt >= beforeStore && createdAt <= afterStore,
                true,
                `created_at must be within test window. Got: ${row.created_at}`,
              );
            }

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
