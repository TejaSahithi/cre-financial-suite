// @ts-nocheck
/**
 * Property-Based Test: Valid Data Storage
 * Feature: backend-driven-pipeline, Task 6.4
 *
 * **Validates: Requirements 4.1, 4.4**
 *
 * Property 13: Valid Data Storage
 * For any validated file, store-data must insert all valid rows into the correct
 * table with correct org_id.
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

/** Create a file record already in 'validated' status with valid_data */
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
  insertedIds: { table: string; ids: string[] }[],
) {
  for (const { table, ids } of insertedIds) {
    for (const id of ids) {
      await adminClient.from(table).delete().eq("id", id);
    }
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
        return { tenant_name: `Tenant ${i + 1}`, start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1000 + i * 100 };
      case "expenses":
        return { category: "Maintenance", amount: 500 + i * 50, date: "2024-03-15" };
      case "properties":
        return { name: `Property ${i + 1}` };
      case "revenue":
        return { revenue_type: "base_rent", amount: 2000 + i * 200 };
      default:
        return {};
    }
  });
}

const rowCountArb = fc.integer({ min: 1, max: 5 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 13: Valid Data Storage - all valid rows inserted into correct table",
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
          const insertedIds: { table: string; ids: string[] }[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const validData = validRowsFor(moduleType, rowCount);
            const fileRecord = await createValidatedFile(adminClient, org.id, moduleType, validData);
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

            // Property: store-data must succeed
            assertEquals(
              result.error,
              false,
              `store-data must succeed for ${moduleType}. Error: ${result.message}`,
            );
            assertEquals(result.processing_status, "stored", "Status must be 'stored'");

            // Property: inserted_count must match rowCount
            assertEquals(
              result.inserted_count,
              rowCount,
              `inserted_count must equal ${rowCount}, got ${result.inserted_count}`,
            );

            // Property: correct table name returned
            assertEquals(
              result.table,
              TABLE_MAP[moduleType],
              `Table must be '${TABLE_MAP[moduleType]}' for module '${moduleType}'`,
            );

            // Property: verify rows exist in DB with correct org_id
            const { data: dbRows } = await adminClient
              .from(TABLE_MAP[moduleType])
              .select("id, org_id")
              .eq("org_id", org.id)
              .order("created_at", { ascending: false })
              .limit(rowCount);

            assertEquals(
              (dbRows ?? []).length,
              rowCount,
              `Must find ${rowCount} rows in ${TABLE_MAP[moduleType]} for org`,
            );

            for (const dbRow of dbRows ?? []) {
              assertEquals(dbRow.org_id, org.id, "Every inserted row must have correct org_id");
            }

            insertedIds.push({
              table: TABLE_MAP[moduleType],
              ids: (dbRows ?? []).map((r: any) => r.id),
            });

            await cleanup(adminClient, org.id, user.userId, fileIds, insertedIds);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds, insertedIds);
            throw err;
          }
        },
      ),
      { numRuns: 50 },
    );
  },
});
