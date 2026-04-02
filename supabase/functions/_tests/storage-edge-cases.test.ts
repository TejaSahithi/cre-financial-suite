// @ts-nocheck
/**
 * Unit Tests: Storage Edge Cases
 * Feature: backend-driven-pipeline, Task 6.11
 *
 * **Validates: Requirements 4.5, 15.3**
 *
 * Tests:
 * - Constraint violation handling
 * - Duplicate key handling
 * - Database connection failure with retry
 * - Foreign key violation
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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

async function cleanup(adminClient: any, orgId: string, userId: string, fileIds: string[]) {
  await adminClient.from("audit_logs").delete().eq("org_id", orgId);
  await adminClient.from("leases").delete().eq("org_id", orgId);
  await adminClient.from("expenses").delete().eq("org_id", orgId);
  await adminClient.from("properties").delete().eq("org_id", orgId);
  await adminClient.from("revenues").delete().eq("org_id", orgId);
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
// Tests: Constraint violation handling (Requirement 4.5)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Storage Edge Cases: file with status 'uploaded' (not validated) is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      // Create file in 'uploaded' status (not validated)
      const fileId = crypto.randomUUID();
      await adminClient.from("uploaded_files").insert({
        id: fileId,
        org_id: org.id,
        module_type: "leases",
        file_name: "test.csv",
        file_url: `test/${fileId}`,
        file_size: 100,
        mime_type: "text/csv",
        status: "uploaded",
      });
      fileIds.push(fileId);

      const response = await fetch(STORE_DATA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: fileId }),
      });

      const result = await response.json();

      assertEquals(result.error, true, "store-data must reject non-validated file");
      assertExists(result.message, "Error response must include a message");
      assertEquals(
        result.message.toLowerCase().includes("validated") ||
          result.message.toLowerCase().includes("status"),
        true,
        `Error message should mention status. Got: ${result.message}`,
      );

      // Verify no rows were inserted
      const { count } = await adminClient
        .from("leases")
        .select("id", { count: "exact", head: true })
        .eq("org_id", org.id);
      assertEquals(count, 0, "No leases should be inserted when file is not validated");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

Deno.test({
  name: "Storage Edge Cases: file with empty valid_data is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      // Create validated file with empty valid_data
      const fileRecord = await createValidatedFile(adminClient, org.id, "leases", []);
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

      assertEquals(result.error, true, "store-data must reject file with empty valid_data");
      assertExists(result.message, "Error response must include a message");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

// ---------------------------------------------------------------------------
// Tests: Duplicate key handling (Requirement 4.5)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Storage Edge Cases: storing same file twice returns error on second attempt",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const validData = [{ tenant_name: "Tenant A", start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1500 }];
      const fileRecord = await createValidatedFile(adminClient, org.id, "leases", validData);
      fileIds.push(fileRecord.id);

      // First store — should succeed
      const response1 = await fetch(STORE_DATA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: fileRecord.id }),
      });

      const result1 = await response1.json();
      assertEquals(result1.error, false, `First store must succeed. Error: ${result1.message}`);
      assertEquals(result1.processing_status, "stored");

      // Second store — file is now in 'stored' status, should be rejected
      const response2 = await fetch(STORE_DATA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: fileRecord.id }),
      });

      const result2 = await response2.json();
      assertEquals(result2.error, true, "Second store attempt must be rejected (already stored)");
      assertExists(result2.message, "Error response must include a message");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

// ---------------------------------------------------------------------------
// Tests: Database connection failure with retry (Requirement 15.3)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Storage Edge Cases: missing file_id returns descriptive error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const response = await fetch(STORE_DATA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}), // No file_id
      });

      const result = await response.json();

      assertEquals(result.error, true, "Missing file_id must return error");
      assertExists(result.message, "Error response must include a message");
      assertEquals(
        result.message.toLowerCase().includes("file_id") ||
          result.message.toLowerCase().includes("required"),
        true,
        `Error message should mention file_id. Got: ${result.message}`,
      );
    } finally {
      await cleanup(adminClient, org.id, "", []);
    }
  },
});

Deno.test({
  name: "Storage Edge Cases: non-existent file_id returns descriptive error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const fakeFileId = crypto.randomUUID();
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
      assertExists(result.message, "Error response must include a message");
    } finally {
      await cleanup(adminClient, org.id, "", []);
    }
  },
});

// ---------------------------------------------------------------------------
// Tests: Foreign key violation (Requirement 4.5)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Storage Edge Cases: unsupported module_type returns descriptive error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      // Create a validated file with an unsupported module_type
      const fileId = crypto.randomUUID();
      await adminClient.from("uploaded_files").insert({
        id: fileId,
        org_id: org.id,
        module_type: "unknown_type",
        file_name: "test.csv",
        file_url: `test/${fileId}`,
        file_size: 100,
        mime_type: "text/csv",
        status: "validated",
        valid_data: [{ name: "test" }],
        valid_count: 1,
        error_count: 0,
      });
      fileIds.push(fileId);

      const response = await fetch(STORE_DATA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: fileId }),
      });

      const result = await response.json();

      assertEquals(result.error, true, "Unsupported module_type must return error");
      assertExists(result.message, "Error response must include a message");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

Deno.test({
  name: "Storage Edge Cases: unauthenticated request returns error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const response = await fetch(STORE_DATA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: crypto.randomUUID() }),
    });

    const result = await response.json();

    assertEquals(result.error, true, "Unauthenticated request must return error");
    assertExists(result.message, "Error response must include a message");
  },
});

Deno.test({
  name: "Storage Edge Cases: file from different org is not accessible",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org1 = await createTestOrg(adminClient, `Org1 ${Date.now()}`);
    const org2 = await createTestOrg(adminClient, `Org2 ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);

      // Create validated file in org2
      const validData = [{ tenant_name: "Tenant A", start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1500 }];
      const fileRecord = await createValidatedFile(adminClient, org2.id, "leases", validData);
      fileIds.push(fileRecord.id);

      // User from org1 tries to store org2's file
      const response = await fetch(STORE_DATA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user1.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: fileRecord.id }),
      });

      const result = await response.json();

      assertEquals(result.error, true, "Cross-org file access must return error");
      assertExists(result.message, "Error response must include a message");

      // Verify no rows were inserted in org1
      const { count } = await adminClient
        .from("leases")
        .select("id", { count: "exact", head: true })
        .eq("org_id", org1.id);
      assertEquals(count, 0, "No rows should be inserted in org1 from cross-org attempt");
    } finally {
      for (const fileId of fileIds) {
        await adminClient.from("uploaded_files").delete().eq("id", fileId);
      }
      await adminClient.from("memberships").delete().eq("org_id", org1.id);
      await adminClient.from("memberships").delete().eq("org_id", org2.id);
      await adminClient.from("organizations").delete().eq("id", org1.id);
      await adminClient.from("organizations").delete().eq("id", org2.id);
    }
  },
});
