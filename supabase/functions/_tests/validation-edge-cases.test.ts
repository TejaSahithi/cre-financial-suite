// @ts-nocheck
/**
 * Unit Tests: Validation Edge Cases
 * Feature: backend-driven-pipeline, Task 5.11
 *
 * **Validates: Requirements 3.1, 3.2, 3.7, 3.8**
 *
 * Tests:
 * - Empty required fields
 * - Wrong data types
 * - Invalid org_id
 * - Missing property_id reference
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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
// Tests: Empty required fields (Requirement 3.1)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Validation Edge Cases: empty string tenant_name produces required error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const row = {
        tenant_name: "   ", // whitespace-only
        start_date: "2024-01-01",
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
        .select("validation_errors")
        .eq("id", fileRecord.id)
        .single();

      const errors: any[] = updatedRecord?.validation_errors ?? [];
      const tenantError = errors.find((e: any) => e.field === "tenant_name");
      assertExists(tenantError, "Whitespace-only tenant_name must produce a validation error");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

Deno.test({
  name: "Validation Edge Cases: null required fields produce required errors",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const row = {
        tenant_name: null,
        start_date: null,
        end_date: null,
        monthly_rent: null,
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
        .select("validation_errors, status")
        .eq("id", fileRecord.id)
        .single();

      const errors: any[] = updatedRecord?.validation_errors ?? [];
      const requiredFields = ["tenant_name", "start_date", "end_date", "monthly_rent"];

      for (const field of requiredFields) {
        const fieldError = errors.find((e: any) => e.field === field && e.type === "required");
        assertExists(fieldError, `Null '${field}' must produce a required error`);
      }

      assertEquals(updatedRecord?.status, "failed", "All-null row should result in failed status");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

// ---------------------------------------------------------------------------
// Tests: Wrong data types (Requirement 3.2)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Validation Edge Cases: string 'abc' for monthly_rent produces type error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const row = {
        tenant_name: "Tenant A",
        start_date: "2024-01-01",
        end_date: "2025-12-31",
        monthly_rent: "abc",
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
        .select("validation_errors")
        .eq("id", fileRecord.id)
        .single();

      const errors: any[] = updatedRecord?.validation_errors ?? [];
      const typeError = errors.find(
        (e: any) => e.field === "monthly_rent" && (e.type === "type" || e.type === "format"),
      );
      assertExists(typeError, "Non-numeric monthly_rent must produce a type error");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

Deno.test({
  name: "Validation Edge Cases: invalid date '2024/01/01' produces format error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const row = {
        tenant_name: "Tenant A",
        start_date: "2024/01/01", // slash-separated YYYY/MM/DD — not supported
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
        .select("validation_errors")
        .eq("id", fileRecord.id)
        .single();

      const errors: any[] = updatedRecord?.validation_errors ?? [];
      const formatError = errors.find(
        (e: any) => e.field === "start_date" && (e.type === "format" || e.type === "type"),
      );
      assertExists(formatError, "YYYY/MM/DD date format must produce a format error");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

// ---------------------------------------------------------------------------
// Tests: Invalid org_id (Requirement 3.7)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Validation Edge Cases: request without auth token returns error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const response = await fetch(VALIDATE_DATA_URL, {
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
  name: "Validation Edge Cases: file from different org is not accessible",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org1 = await createTestOrg(adminClient, `Org1 ${Date.now()}`);
    const org2 = await createTestOrg(adminClient, `Org2 ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);
      await createTestUser(adminClient, `user2-${Date.now()}@test.com`, org2.id);

      // Create file belonging to org2
      const row = { tenant_name: "Tenant A", start_date: "2024-01-01", end_date: "2025-12-31", monthly_rent: 1500 };
      const fileRecord = await createParsedFile(adminClient, org2.id, "leases", [row]);
      fileIds.push(fileRecord.id);

      // User from org1 tries to validate org2's file
      const response = await fetch(VALIDATE_DATA_URL, {
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

// ---------------------------------------------------------------------------
// Tests: Missing property_id reference (Requirement 3.8)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Validation Edge Cases: non-existent property_id produces referential error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);

      const fakePropertyId = crypto.randomUUID();
      const row = {
        tenant_name: "Tenant A",
        start_date: "2024-01-01",
        end_date: "2025-12-31",
        monthly_rent: 1500,
        property_id: fakePropertyId,
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
        .select("validation_errors, valid_data")
        .eq("id", fileRecord.id)
        .single();

      const errors: any[] = updatedRecord?.validation_errors ?? [];
      const refError = errors.find(
        (e: any) => e.field === "property_id" && e.type === "referential",
      );
      assertExists(refError, "Non-existent property_id must produce a referential error");

      const validData: any[] = updatedRecord?.valid_data ?? [];
      assertEquals(validData.length, 0, "Row with invalid property_id must not be in valid_data");
    } finally {
      await cleanup(adminClient, org.id, "", fileIds);
    }
  },
});

Deno.test({
  name: "Validation Edge Cases: property_id from different org produces referential error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org1 = await createTestOrg(adminClient, `Org1 ${Date.now()}`);
    const org2 = await createTestOrg(adminClient, `Org2 ${Date.now()}`);
    const fileIds: string[] = [];

    try {
      const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);

      // Create property in org2
      const { data: property } = await adminClient
        .from("properties")
        .insert({ org_id: org2.id, name: "Org2 Property", status: "active" })
        .select()
        .single();

      // Lease in org1 referencing org2's property
      const row = {
        tenant_name: "Tenant A",
        start_date: "2024-01-01",
        end_date: "2025-12-31",
        monthly_rent: 1500,
        property_id: property.id,
      };

      const fileRecord = await createParsedFile(adminClient, org1.id, "leases", [row]);
      fileIds.push(fileRecord.id);

      await fetch(VALIDATE_DATA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user1.accessToken}`,
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
      const refError = errors.find(
        (e: any) => e.field === "property_id" && e.type === "referential",
      );
      assertExists(
        refError,
        "Cross-org property_id must produce a referential error (org isolation)",
      );

      // Cleanup
      await adminClient.from("properties").delete().eq("id", property.id);
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
