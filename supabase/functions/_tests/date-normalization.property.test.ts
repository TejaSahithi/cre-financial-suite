// @ts-nocheck
/**
 * Property-Based Test: Date Normalization
 * Feature: backend-driven-pipeline, Task 5.7
 *
 * **Validates: Requirements 3.5**
 *
 * Property 9: Date Normalization
 * For any valid date in MM/DD/YYYY or M/D/YYYY format, validate-data must normalize
 * it to YYYY-MM-DD in valid_data.
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

/** ISO 8601 date pattern: YYYY-MM-DD */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Generate a valid calendar date as { year, month, day } */
const validDatePartsArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2030 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }), // Use 1-28 to avoid month-end edge cases
  });

/** Format as MM/DD/YYYY (zero-padded) */
const usDatePaddedArb = validDatePartsArb.map(({ year, month, day }) => {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    input: `${mm}/${dd}/${year}`,
    expected: `${year}-${mm}-${dd}`,
  };
});

/** Format as M/D/YYYY (no padding) */
const usDateUnpaddedArb = validDatePartsArb.map(({ year, month, day }) => {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    input: `${month}/${day}/${year}`,
    expected: `${year}-${mm}-${dd}`,
  };
});

/** Already ISO format — should pass through unchanged */
const isoDateArb = validDatePartsArb.map(({ year, month, day }) => {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const iso = `${year}-${mm}-${dd}`;
  return { input: iso, expected: iso };
});

const anyValidDateArb = fc.oneof(usDatePaddedArb, usDateUnpaddedArb, isoDateArb);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 9: Date Normalization - US date MM/DD/YYYY normalized to YYYY-MM-DD",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        usDatePaddedArb,
        async ({ input, expected }) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              tenant_name: "Tenant A",
              start_date: input,
              end_date: "2025-12-31",
              monthly_rent: 1500,
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
              .select("valid_data, validation_errors, status")
              .eq("id", fileRecord.id)
              .single();

            assertExists(updatedRecord, "DB record must exist");

            const validData: any[] = updatedRecord.valid_data ?? [];
            assertEquals(
              validData.length > 0,
              true,
              `Row with date '${input}' should be valid. Errors: ${JSON.stringify(updatedRecord.validation_errors)}`,
            );

            const normalizedDate = validData[0]?.start_date;
            assertEquals(
              normalizedDate,
              expected,
              `Date '${input}' should normalize to '${expected}', got '${normalizedDate}'`,
            );

            // Verify it matches ISO pattern
            assertEquals(
              ISO_DATE_RE.test(normalizedDate),
              true,
              `Normalized date '${normalizedDate}' must match YYYY-MM-DD pattern`,
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
  name: "Property 9: Date Normalization - US date M/D/YYYY (no padding) normalized to YYYY-MM-DD",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        usDateUnpaddedArb,
        async ({ input, expected }) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              tenant_name: "Tenant B",
              start_date: input,
              end_date: "2025-12-31",
              monthly_rent: 2000,
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
              .select("valid_data, validation_errors")
              .eq("id", fileRecord.id)
              .single();

            const validData: any[] = updatedRecord?.valid_data ?? [];
            assertEquals(
              validData.length > 0,
              true,
              `Row with date '${input}' should be valid. Errors: ${JSON.stringify(updatedRecord?.validation_errors)}`,
            );

            const normalizedDate = validData[0]?.start_date;
            assertEquals(
              normalizedDate,
              expected,
              `Date '${input}' should normalize to '${expected}', got '${normalizedDate}'`,
            );

            assertEquals(
              ISO_DATE_RE.test(normalizedDate),
              true,
              `Normalized date must match YYYY-MM-DD pattern`,
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
  name: "Property 9: Date Normalization - ISO date passes through unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        isoDateArb,
        async ({ input, expected }) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              tenant_name: "Tenant C",
              start_date: input,
              end_date: "2030-12-31",
              monthly_rent: 3000,
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
              .select("valid_data, validation_errors")
              .eq("id", fileRecord.id)
              .single();

            const validData: any[] = updatedRecord?.valid_data ?? [];
            assertEquals(
              validData.length > 0,
              true,
              `ISO date '${input}' should be valid. Errors: ${JSON.stringify(updatedRecord?.validation_errors)}`,
            );

            const normalizedDate = validData[0]?.start_date;
            assertEquals(
              normalizedDate,
              expected,
              `ISO date '${input}' should remain '${expected}', got '${normalizedDate}'`,
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
