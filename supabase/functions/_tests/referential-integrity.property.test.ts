// @ts-nocheck
/**
 * Property-Based Test: Referential Integrity Validation
 * Feature: backend-driven-pipeline, Task 5.9
 *
 * **Validates: Requirements 3.8**
 *
 * Property 11: Referential Integrity Validation
 * For any row with a property_id that doesn't exist in the properties table,
 * validate-data must return a referential integrity error.
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

/** Generate a UUID that definitely doesn't exist in the DB */
const nonExistentUuidArb = fc.uuid();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 11: Referential Integrity - non-existent property_id produces referential error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        nonExistentUuidArb,
        async (fakePropertyId) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            // Lease row with a property_id that doesn't exist
            const row = {
              tenant_name: "Tenant A",
              start_date: "2024-01-01",
              end_date: "2025-12-31",
              monthly_rent: 1500,
              property_id: fakePropertyId,
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
              .select("validation_errors, valid_data")
              .eq("id", fileRecord.id)
              .single();

            const errors: any[] = updatedRecord?.validation_errors ?? result.validation_errors ?? [];

            // Property: must have a referential error for property_id
            const refError = errors.find(
              (e: any) => e.field === "property_id" && e.type === "referential",
            );
            assertExists(
              refError,
              `Must have a 'referential' error for non-existent property_id '${fakePropertyId}'. Errors: ${JSON.stringify(errors)}`,
            );

            // Property: the row with invalid property_id must NOT appear in valid_data
            const validData: any[] = updatedRecord?.valid_data ?? [];
            const rowInValid = validData.find((r: any) => r.property_id === fakePropertyId);
            assertEquals(
              rowInValid,
              undefined,
              `Row with non-existent property_id should not be in valid_data`,
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
  name: "Property 11: Referential Integrity - existing property_id passes validation",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        fc.constant(true),
        async () => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            // Create a real property in the same org
            const { data: property, error: propError } = await adminClient
              .from("properties")
              .insert({ org_id: org.id, name: "Test Property", status: "active" })
              .select()
              .single();
            if (propError) throw new Error(`Failed to create property: ${propError.message}`);

            const row = {
              tenant_name: "Tenant A",
              start_date: "2024-01-01",
              end_date: "2025-12-31",
              monthly_rent: 1500,
              property_id: property.id,
            };

            const fileRecord = await createParsedFile(adminClient, org.id, "leases", [row]);
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
              .select("validation_errors, valid_data, status")
              .eq("id", fileRecord.id)
              .single();

            const errors: any[] = updatedRecord?.validation_errors ?? [];
            const refErrors = errors.filter((e: any) => e.type === "referential");

            assertEquals(
              refErrors.length,
              0,
              `Existing property_id should not produce referential errors. Got: ${JSON.stringify(refErrors)}`,
            );

            const validData: any[] = updatedRecord?.valid_data ?? [];
            assertEquals(
              validData.length,
              1,
              `Row with valid property_id should appear in valid_data`,
            );

            // Cleanup property
            await adminClient.from("properties").delete().eq("id", property.id);
            await cleanup(adminClient, org.id, user.userId, fileIds);
          } catch (err) {
            await cleanup(adminClient, org.id, "", fileIds);
            throw err;
          }
        },
      ),
      { numRuns: 20 },
    );
  },
});
