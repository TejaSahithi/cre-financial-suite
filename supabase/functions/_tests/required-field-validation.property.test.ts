// @ts-nocheck
/**
 * Property-Based Test: Required Field Validation
 * Feature: backend-driven-pipeline, Task 5.5
 *
 * **Validates: Requirements 3.1, 3.4**
 *
 * Property 7: Required Field Validation
 * For any row missing a required field (tenant_name, start_date, end_date, monthly_rent
 * for leases; category, amount, date for expenses; name for properties; revenue_type,
 * amount for revenue), the validate-data function must return a validation error for
 * that field.
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
// Required fields per module type
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: Record<string, string[]> = {
  leases: ["tenant_name", "start_date", "end_date", "monthly_rent"],
  expenses: ["category", "amount", "date"],
  properties: ["name"],
  revenue: ["revenue_type", "amount"],
};

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

/** Create an uploaded_files record with parsed_data already set (bypasses parse step) */
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

const moduleTypeArb = fc.constantFrom("leases", "expenses", "properties", "revenue");

/** A complete valid row for each module type */
function validRowFor(moduleType: string): Record<string, unknown> {
  switch (moduleType) {
    case "leases":
      return { tenant_name: "Tenant A", start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1500 };
    case "expenses":
      return { category: "Maintenance", amount: 500, date: "2024-03-15" };
    case "properties":
      return { name: "Main Street Office" };
    case "revenue":
      return { revenue_type: "base_rent", amount: 2000 };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 7: Required Field Validation - missing required field produces error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        moduleTypeArb,
        async (moduleType) => {
          const requiredFields = REQUIRED_FIELDS[moduleType];
          // Pick one required field to omit
          const fieldToOmit = requiredFields[Math.floor(Math.random() * requiredFields.length)];

          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            // Build a row missing the chosen required field
            const row = { ...validRowFor(moduleType) };
            delete row[fieldToOmit];

            const fileRecord = await createParsedFile(adminClient, org.id, moduleType, [row]);
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

            // Check DB record for validation_errors
            const { data: updatedRecord } = await adminClient
              .from("uploaded_files")
              .select("validation_errors, status")
              .eq("id", fileRecord.id)
              .single();

            assertExists(updatedRecord, "DB record must exist after validation");

            const errors: any[] = updatedRecord.validation_errors ?? result.validation_errors ?? [];

            // Property: at least one error must reference the missing field
            const fieldError = errors.find(
              (e: any) => e.field === fieldToOmit && e.type === "required",
            );
            assertExists(
              fieldError,
              `Must have a 'required' error for missing field '${fieldToOmit}' in module '${moduleType}'. Errors: ${JSON.stringify(errors)}`,
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
  name: "Property 7: Required Field Validation - all required fields missing produces errors for each",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        moduleTypeArb,
        async (moduleType) => {
          const requiredFields = REQUIRED_FIELDS[moduleType];
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            // Empty row — all required fields missing
            const row: Record<string, unknown> = {};

            const fileRecord = await createParsedFile(adminClient, org.id, moduleType, [row]);
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
              .select("validation_errors, status")
              .eq("id", fileRecord.id)
              .single();

            assertExists(updatedRecord, "DB record must exist");

            const errors: any[] = updatedRecord.validation_errors ?? result.validation_errors ?? [];

            // Property: every required field must have an error
            for (const field of requiredFields) {
              const fieldError = errors.find(
                (e: any) => e.field === field && e.type === "required",
              );
              assertExists(
                fieldError,
                `Must have a 'required' error for field '${field}' in module '${moduleType}'`,
              );
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
