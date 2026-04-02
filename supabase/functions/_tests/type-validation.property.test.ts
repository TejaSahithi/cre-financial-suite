// @ts-nocheck
/**
 * Property-Based Test: Type Validation
 * Feature: backend-driven-pipeline, Task 5.6
 *
 * **Validates: Requirements 3.2, 3.4**
 *
 * Property 8: Type Validation
 * For any row with invalid data types (non-numeric monthly_rent, invalid date format),
 * validate-data must return type/format errors.
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

/** Non-numeric strings that cannot be parsed as a number */
const nonNumericArb = fc.oneof(
  fc.constantFrom("abc", "not-a-number", "N/A", "??", "one hundred", "--", ""),
  fc.string({ minLength: 2, maxLength: 10 }).filter((s) => isNaN(Number(s.replace(/[$€£,]/g, "")))),
);

/** Invalid date strings that don't match ISO or US formats */
const invalidDateArb = fc.oneof(
  fc.constantFrom("not-a-date", "32/01/2024", "2024-13-01", "hello", "99-99-9999", "2024/01/01"),
  fc.string({ minLength: 3, maxLength: 12 }).filter((s) => {
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    const usRe = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
    return !isoRe.test(s) && !usRe.test(s);
  }),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 8: Type Validation - non-numeric monthly_rent produces type error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        nonNumericArb,
        async (badRent) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              tenant_name: "Tenant A",
              start_date: "2024-01-01",
              end_date: "2025-12-31",
              monthly_rent: badRent,
            };

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

            // Property: must have a type error for monthly_rent
            const rentError = errors.find(
              (e: any) => e.field === "monthly_rent" && (e.type === "type" || e.type === "format"),
            );
            assertExists(
              rentError,
              `Must have a type/format error for non-numeric monthly_rent '${badRent}'. Errors: ${JSON.stringify(errors)}`,
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
  name: "Property 8: Type Validation - invalid date format produces format error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        invalidDateArb,
        async (badDate) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              tenant_name: "Tenant A",
              start_date: badDate,
              end_date: "2025-12-31",
              monthly_rent: 1500,
            };

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

            // Property: must have a format error for start_date
            const dateError = errors.find(
              (e: any) => e.field === "start_date" && (e.type === "format" || e.type === "type"),
            );
            assertExists(
              dateError,
              `Must have a format error for invalid date '${badDate}'. Errors: ${JSON.stringify(errors)}`,
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
  name: "Property 8: Type Validation - non-numeric expense amount produces type error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        nonNumericArb,
        async (badAmount) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              category: "Maintenance",
              amount: badAmount,
              date: "2024-03-15",
            };

            const fileRecord = await createParsedFile(adminClient, org.id, "expenses", [row]);
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

            const amountError = errors.find(
              (e: any) => e.field === "amount" && (e.type === "type" || e.type === "format"),
            );
            assertExists(
              amountError,
              `Must have a type error for non-numeric amount '${badAmount}'. Errors: ${JSON.stringify(errors)}`,
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
