// @ts-nocheck
/**
 * Property-Based Test: Currency Normalization
 * Feature: backend-driven-pipeline, Task 5.8
 *
 * **Validates: Requirements 3.6**
 *
 * Property 10: Currency Normalization
 * For any currency string with $, €, £ symbols and commas, validate-data must
 * normalize it to a plain number in valid_data.
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

const currencySymbolArb = fc.constantFrom("$", "€", "£");

/** Generate a positive numeric value with up to 2 decimal places */
const numericValueArb = fc.float({ min: 1, max: 999999, noNaN: true, noDefaultInfinity: true })
  .map((n) => Math.round(n * 100) / 100);

/** Format a number with commas for thousands */
function formatWithCommas(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Currency string with symbol prefix */
const currencyStringArb = fc.tuple(currencySymbolArb, numericValueArb).map(([symbol, value]) => ({
  input: `${symbol}${formatWithCommas(value)}`,
  expected: value,
}));

/** Currency string with commas but no symbol */
const commaNumberArb = numericValueArb.map((value) => ({
  input: formatWithCommas(value),
  expected: value,
}));

/** Plain numeric string (no symbol, no commas) */
const plainNumberArb = numericValueArb.map((value) => ({
  input: String(value),
  expected: value,
}));

const anyCurrencyArb = fc.oneof(currencyStringArb, commaNumberArb, plainNumberArb);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 10: Currency Normalization - currency symbols stripped and value preserved",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        currencyStringArb,
        async ({ input, expected }) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              tenant_name: "Tenant A",
              start_date: "2024-01-01",
              end_date: "2025-12-31",
              monthly_rent: input,
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
              `Currency string '${input}' should be valid. Errors: ${JSON.stringify(updatedRecord?.validation_errors)}`,
            );

            const normalizedRent = validData[0]?.monthly_rent;

            // Property: result must be a number
            assertEquals(
              typeof normalizedRent,
              "number",
              `monthly_rent must be a number after normalization, got ${typeof normalizedRent}`,
            );

            // Property: value must match expected (within floating point tolerance)
            assertEquals(
              Math.abs(normalizedRent - expected) < 0.01,
              true,
              `Currency '${input}' should normalize to ~${expected}, got ${normalizedRent}`,
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
  name: "Property 10: Currency Normalization - comma-formatted numbers normalized to plain number",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(
        commaNumberArb,
        async ({ input, expected }) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];

          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

            const row = {
              category: "Maintenance",
              amount: input,
              date: "2024-03-15",
            };

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
              .select("valid_data, validation_errors")
              .eq("id", fileRecord.id)
              .single();

            const validData: any[] = updatedRecord?.valid_data ?? [];
            assertEquals(
              validData.length > 0,
              true,
              `Comma number '${input}' should be valid. Errors: ${JSON.stringify(updatedRecord?.validation_errors)}`,
            );

            const normalizedAmount = validData[0]?.amount;
            assertEquals(
              typeof normalizedAmount,
              "number",
              `amount must be a number after normalization`,
            );
            assertEquals(
              Math.abs(normalizedAmount - expected) < 0.01,
              true,
              `'${input}' should normalize to ~${expected}, got ${normalizedAmount}`,
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
