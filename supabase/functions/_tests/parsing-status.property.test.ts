// @ts-nocheck
/**
 * Property-Based Test: Parsing Status Transitions
 * Feature: backend-driven-pipeline, Task 3.7
 *
 * **Validates: Requirements 2.1, 2.3, 2.4**
 *
 * Property 5: Parsing Status Transitions
 * After calling parse-file, status must transition from 'uploaded' → 'parsing' → 'parsed' (or 'failed').
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PARSE_FILE_URL = `${SUPABASE_URL}/functions/v1/parse-file`;

function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Test helpers
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

async function uploadTestFile(
  adminClient: any,
  orgId: string,
  csvContent: string,
  moduleType: string = "leases",
  fileName: string = "test.csv"
) {
  const fileId = crypto.randomUUID();
  const storagePath = `${orgId}/${fileId}`;

  const { error: uploadError } = await adminClient.storage
    .from("financial-uploads")
    .upload(storagePath, new Blob([csvContent], { type: "text/csv" }), {
      contentType: "text/csv",
      upsert: false,
    });
  if (uploadError) throw new Error(`Failed to upload file: ${uploadError.message}`);

  const { data: fileRecord, error: insertError } = await adminClient
    .from("uploaded_files")
    .insert({
      id: fileId,
      org_id: orgId,
      module_type: moduleType,
      file_name: fileName,
      file_url: `${SUPABASE_URL}/storage/v1/object/public/financial-uploads/${storagePath}`,
      file_size: new Blob([csvContent]).size,
      mime_type: "text/csv",
      status: "uploaded",
    })
    .select()
    .single();
  if (insertError) throw new Error(`Failed to create file record: ${insertError.message}`);

  return fileRecord;
}

async function cleanup(adminClient: any, orgId: string, userId: string, fileIds: string[]) {
  for (const fileId of fileIds) {
    await adminClient.from("uploaded_files").delete().eq("id", fileId);
    await adminClient.storage.from("financial-uploads").remove([`${orgId}/${fileId}`]);
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

/** Valid module types */
const moduleTypeArb = fc.constantFrom("leases", "expenses", "properties", "revenue");

/** Simple safe header name */
const safeHeaderArb = fc
  .array(
    fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"),
    { minLength: 3, maxLength: 8 }
  )
  .map((chars) => chars.join(""));

/** Non-empty cell value without commas */
const safeCellArb = fc.oneof(
  fc.integer({ min: 1, max: 9999 }).map(String),
  fc
    .array(fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h"), { minLength: 2, maxLength: 10 })
    .map((c) => c.join(""))
);

/** A valid CSV string with at least 1 header and 1 data row */
const validCsvArb = fc
  .array(safeHeaderArb, { minLength: 2, maxLength: 5 })
  .chain((headers) => {
    const uniqueHeaders = [...new Set(headers)];
    return fc
      .array(
        fc.array(safeCellArb, { minLength: uniqueHeaders.length, maxLength: uniqueHeaders.length }),
        { minLength: 1, maxLength: 5 }
      )
      .map((rows) => {
        const lines = [uniqueHeaders.join(","), ...rows.map((r) => r.join(","))];
        return lines.join("\n") + "\n";
      });
  });

/** An invalid / malformed CSV (empty content) to trigger parse failure */
const invalidCsvArb = fc.constant("");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 5: Parsing Status Transitions - valid CSV transitions to 'parsed'",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(validCsvArb, moduleTypeArb, async (csvContent, moduleType) => {
        const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
        const fileIds: string[] = [];

        try {
          const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

          // Pre-condition: file starts with status 'uploaded'
          const fileRecord = await uploadTestFile(adminClient, org.id, csvContent, moduleType);
          fileIds.push(fileRecord.id);

          assertEquals(fileRecord.status, "uploaded", "Initial status must be 'uploaded'");

          // Invoke parse-file
          const response = await fetch(PARSE_FILE_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${user.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ file_id: fileRecord.id }),
          });

          const result = await response.json();

          // The response may include processing_status directly (success) or
          // we fall back to checking the DB record (error path returns 400)
          const responseStatus = result.processing_status ?? result.status;

          // Verify the DB record was updated (source of truth)
          const { data: updatedRecord } = await adminClient
            .from("uploaded_files")
            .select("status, parsed_data")
            .eq("id", fileRecord.id)
            .single();

          assertExists(updatedRecord, "DB record must exist after parsing");

          const finalStatus = updatedRecord.status;

          // Post-condition: status must be 'parsed' or 'failed' — never 'uploaded'
          const validTerminalStatuses = ["parsed", "failed"];
          assertEquals(
            validTerminalStatuses.includes(finalStatus),
            true,
            `Status must be 'parsed' or 'failed' after parse-file, got: ${finalStatus}`
          );

          // For a valid CSV, we expect 'parsed'
          assertEquals(
            finalStatus,
            "parsed",
            `Valid CSV should result in 'parsed' status, got: ${finalStatus}`
          );

          assertExists(updatedRecord.parsed_data, "parsed_data must be stored in DB");

          await cleanup(adminClient, org.id, user.userId, fileIds);
        } catch (err) {
          await cleanup(adminClient, org.id, "", fileIds);
          throw err;
        }
      }),
      { numRuns: 20 }
    );
  },
});

Deno.test({
  name: "Property 5: Parsing Status Transitions - empty/invalid CSV transitions to 'failed'",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    await fc.assert(
      fc.asyncProperty(invalidCsvArb, moduleTypeArb, async (csvContent, moduleType) => {
        const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
        const fileIds: string[] = [];

        try {
          const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

          const fileRecord = await uploadTestFile(adminClient, org.id, csvContent, moduleType);
          fileIds.push(fileRecord.id);

          assertEquals(fileRecord.status, "uploaded", "Initial status must be 'uploaded'");

          const response = await fetch(PARSE_FILE_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${user.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ file_id: fileRecord.id }),
          });

          // Check DB record (source of truth — error path returns 400 without processing_status)
          const { data: updatedRecord } = await adminClient
            .from("uploaded_files")
            .select("status, error_message")
            .eq("id", fileRecord.id)
            .single();

          assertExists(updatedRecord, "DB record must exist after failed parse");

          // Empty CSV must result in 'failed'
          assertEquals(
            updatedRecord.status,
            "failed",
            `Empty CSV should result in 'failed' DB status, got: ${updatedRecord.status}`
          );
          assertExists(updatedRecord.error_message, "error_message must be stored on failure");

          await cleanup(adminClient, org.id, user.userId, fileIds);
        } catch (err) {
          await cleanup(adminClient, org.id, "", fileIds);
          throw err;
        }
      }),
      { numRuns: 5 }
    );
  },
});

Deno.test({
  name: "Property 5: Parsing Status Transitions - status never stays 'uploaded' after parse-file",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();

    // Mix of valid and invalid CSVs
    const mixedCsvArb = fc.oneof(validCsvArb, invalidCsvArb);

    await fc.assert(
      fc.asyncProperty(mixedCsvArb, moduleTypeArb, async (csvContent, moduleType) => {
        const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
        const fileIds: string[] = [];

        try {
          const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

          const fileRecord = await uploadTestFile(adminClient, org.id, csvContent, moduleType);
          fileIds.push(fileRecord.id);

          await fetch(PARSE_FILE_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${user.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ file_id: fileRecord.id }),
          });

          // After parse-file completes, status must NOT be 'uploaded'
          const { data: updatedRecord } = await adminClient
            .from("uploaded_files")
            .select("status")
            .eq("id", fileRecord.id)
            .single();

          assertExists(updatedRecord, "DB record must exist");
          assertEquals(
            updatedRecord.status !== "uploaded",
            true,
            `Status must not remain 'uploaded' after parse-file, got: ${updatedRecord.status}`
          );

          await cleanup(adminClient, org.id, user.userId, fileIds);
        } catch (err) {
          await cleanup(adminClient, org.id, "", fileIds);
          throw err;
        }
      }),
      { numRuns: 15 }
    );
  },
});
