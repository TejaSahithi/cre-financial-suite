// @ts-nocheck
/**
 * Property-Based Test: Validation Completeness
 * Feature: backend-driven-pipeline, Task 5.10
 *
 * **Validates: Requirements 15.2**
 *
 * Property 12: Validation Completeness
 * For any row with multiple validation errors, validate-data must return ALL errors
 * (not just the first one).
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VALIDATE_DATA_URL = `${SUPABASE_URL}/functions/v1/validate-data`;

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

async function createParsedFile(
  adminClient: any,
  orgId: string,
  moduleType: string,
  parsedData: Record<string, unknown>[],
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
      status: "parsed",
      parsed_data: parsedData,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create file record: ${error.message}`);
  return data;
}

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

/**
 * Generate a lease row with N missing required fields (2-4 fields missing).
 * Returns the row and the list of fields that are missing.
 */
const multiErrorLeaseRowArb = fc
  .integer({ min: 2, max: 4 })
  .chain((numMissing) => {
    const allRequired = ["tenant_name", "start_date", "end_date", "monthly_rent"];
    return fc
      .shuffledSubarray(allRequired, { minLength: numMissing, maxLength: numMissing })
      .map((fieldsToOmit) => {
        const row: Record<string, unknown> = {
          tenant_name: "Tenant A",
          start_date: "2024-01-01",
          end_date: "2025-12-31",
          monthly_rent: 1500,
        };
        for (const f of fieldsToOmit) {
          delete row[f];
        }
        return { row, missingFields: fieldsToOmit };
      });
  });

/**
 * Generate an expense row with both missing required field and invalid type.
 */
const multiErrorExpenseRowArb = fc.constant({
  row: { category: null, amount: "not-a-number", date: null },
  missingFields: ["category", "date"],
  typeErrorFields: ["amount"],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 12: Validation Completeness - all errors returned for multi-error lease row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        multiErrorLeaseRowArb,
        async ({ row, missingFields }) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const fileRecord = await createParsedFile(adminClient, org.id, "leases", [row]);
            fileIds.push(fileRecord.id);

            const response = await fetch(VALIDATE_DATA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${user.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ file_id: fileRecord.id }),
            });

            const result = await response.json();

            const { data: updatedRecord } = await adminClient
              .from("uploaded_files")
              .select("validation_errors")
              .eq("id", fileRecord.id)
              .single();

            const errors: any[] = updatedRecord?.validation_errors ?? result.validation_errors ?? [];

            // Property: every missing field must have its own error entry
            for (const field of missingFields) {
              const fieldError = errors.find((e: any) => e.field === field);
              assertExists(
                fieldError,
                `Must have an error for missing field '${field}'. Missing fields: ${JSON.stringify(missingFields)}. Errors: ${JSON.stringify(errors)}`,
              );
            }

            // Property: total error count must be >= number of missing fields
            assertEquals(
              errors.length >= missingFields.length,
              true,
              `Error count (${errors.length}) must be >= missing field count (${missingFields.length})`,
            );

            await cleanup(adminClient, org.id, user.userId, fileIds);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds);
            throw err;
          }
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 12: Validation Completeness - multiple rows each get their own errors",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        async (numRows) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            // Each row is missing all required fields
            const rows = Array.from({ length: numRows }, () => ({}));

            const fileRecord = await createParsedFile(adminClient, org.id, "leases", rows);
            fileIds.push(fileRecord.id);

            await fetch(VALIDATE_DATA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${user.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ file_id: fileRecord.id }),
            });

            const { data: updatedRecord } = await adminClient
              .from("uploaded_files")
              .select("validation_errors")
              .eq("id", fileRecord.id)
              .single();

            const errors: any[] = updatedRecord?.validation_errors ?? [];

            // 4 required fields per row × numRows rows = at least 4*numRows errors
            const expectedMinErrors = 4 * numRows;
            assertEquals(
              errors.length >= expectedMinErrors,
              true,
              `Expected at least ${expectedMinErrors} errors for ${numRows} empty rows, got ${errors.length}`,
            );

            // Verify errors span multiple row numbers
            const rowNumbers = new Set(errors.map((e: any) => e.row));
            assertEquals(
              rowNumbers.size,
              numRows,
              `Errors must reference all ${numRows} rows, got rows: ${JSON.stringify([...rowNumbers])}`,
            );

            await cleanup(adminClient, org.id, user.userId, fileIds);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds);
            throw err;
          }
        },
      ),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 12: Validation Completeness - mixed required and type errors all returned",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        multiErrorExpenseRowArb,
        async ({ row, missingFields, typeErrorFields }) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const fileRecord = await createParsedFile(adminClient, org.id, "expenses", [row]);
            fileIds.push(fileRecord.id);

            await fetch(VALIDATE_DATA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${user.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ file_id: fileRecord.id }),
            });

            const { data: updatedRecord } = await adminClient
              .from("uploaded_files")
              .select("validation_errors")
              .eq("id", fileRecord.id)
              .single();

            const errors: any[] = updatedRecord?.validation_errors ?? [];

            // All missing fields must have errors
            for (const field of missingFields) {
              const fieldError = errors.find((e: any) => e.field === field);
              assertExists(fieldError, `Must have error for missing field '${field}'`);
            }

            // Type error fields must also have errors
            for (const field of typeErrorFields) {
              const fieldError = errors.find((e: any) => e.field === field);
              assertExists(fieldError, `Must have error for type-invalid field '${field}'`);
            }

            await cleanup(adminClient, org.id, user.userId, fileIds);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds);
            throw err;
          }
        },
      ),
      { numRuns: 100 },
    );
  },
});
