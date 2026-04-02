// @ts-nocheck
/**
 * Unit Tests: Upload Handler Edge Function
 * Feature: backend-driven-pipeline, Task 2.1
 * 
 * **Validates: Requirements 1.1, 1.2, 1.4, 1.6**
 * 
 * Tests the upload-handler Edge Function which:
 * - Accepts file uploads (CSV/Excel) with file_type parameter
 * - Stores files in Supabase Storage at financial-uploads/{org_id}/{file_id}
 * - Creates uploaded_files record with status='uploaded'
 * - Enforces 50MB file size limit
 * - Returns file_id and storage_path
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Test configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:54321';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const UPLOAD_HANDLER_URL = `${SUPABASE_URL}/functions/v1/upload-handler`;

/**
 * Creates a Supabase client with service role (admin) access
 */
function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/**
 * Test helper: Create a test organization
 */
async function createTestOrg(adminClient: any, orgName: string) {
  const { data, error } = await adminClient
    .from('organizations')
    .insert({ name: orgName, status: 'active' })
    .select()
    .single();
  
  if (error) throw new Error(`Failed to create org: ${error.message}`);
  return data;
}

/**
 * Test helper: Create a test user and membership
 */
async function createTestUser(adminClient: any, email: string, orgId: string) {
  // Create auth user
  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
    email,
    password: 'test-password-123',
    email_confirm: true
  });
  
  if (authError) throw new Error(`Failed to create user: ${authError.message}`);
  
  // Create membership
  const { error: membershipError } = await adminClient
    .from('memberships')
    .insert({
      user_id: authData.user.id,
      org_id: orgId,
      role: 'member',
      status: 'active'
    });
  
  if (membershipError) throw new Error(`Failed to create membership: ${membershipError.message}`);
  
  // Get access token
  const { data: sessionData, error: sessionError } = await adminClient.auth.signInWithPassword({
    email,
    password: 'test-password-123'
  });
  
  if (sessionError) throw new Error(`Failed to sign in: ${sessionError.message}`);
  
  return {
    userId: authData.user.id,
    accessToken: sessionData.session.access_token
  };
}

/**
 * Test helper: Create a test CSV file
 */
function createTestCSVFile(filename: string, sizeInBytes?: number): File {
  let content = 'tenant_name,start_date,end_date,monthly_rent\n';
  content += 'Test Tenant,2024-01-01,2025-12-31,1000\n';
  
  // If size is specified, pad the content to reach that size
  if (sizeInBytes) {
    const currentSize = new Blob([content]).size;
    if (sizeInBytes > currentSize) {
      const padding = 'x'.repeat(sizeInBytes - currentSize);
      content += padding;
    }
  }
  
  return new File([content], filename, { type: 'text/csv' });
}

/**
 * Test helper: Cleanup test data
 */
async function cleanupTestData(adminClient: any, orgIds: string[], fileIds: string[]) {
  // Delete uploaded files
  for (const fileId of fileIds) {
    await adminClient.from('uploaded_files').delete().eq('id', fileId);
    // Try to delete from storage (may not exist if test failed)
    try {
      const { data: files } = await adminClient.storage
        .from('financial-uploads')
        .list();
      
      if (files) {
        for (const file of files) {
          if (file.name.includes(fileId)) {
            await adminClient.storage
              .from('financial-uploads')
              .remove([file.name]);
          }
        }
      }
    } catch (e) {
      // Ignore storage cleanup errors
    }
  }
  
  // Delete organizations
  for (const orgId of orgIds) {
    await adminClient.from('memberships').delete().eq('org_id', orgId);
    await adminClient.from('organizations').delete().eq('id', orgId);
  }
}

// ============================================================
// UNIT TESTS
// ============================================================

Deno.test({
  name: "Upload Handler: Successfully uploads a valid CSV file",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create test file
      const testFile = createTestCSVFile('test-leases.csv');
      
      // Create form data
      const formData = new FormData();
      formData.append('file', testFile);
      formData.append('file_type', 'leases');
      
      // Call upload-handler
      const response = await fetch(UPLOAD_HANDLER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`
        },
        body: formData
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 200, 'Should return 200 status');
      assertEquals(result.error, false, 'Should not have error');
      assertExists(result.file_id, 'Should return file_id');
      assertExists(result.storage_path, 'Should return storage_path');
      assertEquals(result.processing_status, 'uploaded', 'Status should be uploaded');
      assertEquals(result.file_name, 'test-leases.csv', 'Should return correct filename');
      
      testFileIds.push(result.file_id);
      
      // Verify database record
      const { data: uploadRecord, error: dbError } = await adminClient
        .from('uploaded_files')
        .select('*')
        .eq('id', result.file_id)
        .single();
      
      assertEquals(dbError, null, 'Should create database record');
      assertExists(uploadRecord, 'Upload record should exist');
      assertEquals(uploadRecord.org_id, org.id, 'Should have correct org_id');
      assertEquals(uploadRecord.module_type, 'leases', 'Should have correct module_type');
      assertEquals(uploadRecord.status, 'uploaded', 'Should have uploaded status');
      assertEquals(uploadRecord.file_name, 'test-leases.csv', 'Should have correct filename');
      
      // Verify storage path format
      assertEquals(
        result.storage_path.startsWith(`financial-uploads/${org.id}/`),
        true,
        'Storage path should follow correct format'
      );
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Handler: Rejects file exceeding 50MB limit",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create test file larger than 50MB
      const largeFile = createTestCSVFile('large-file.csv', 51 * 1024 * 1024);
      
      // Create form data
      const formData = new FormData();
      formData.append('file', largeFile);
      formData.append('file_type', 'leases');
      
      // Call upload-handler
      const response = await fetch(UPLOAD_HANDLER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`
        },
        body: formData
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 413, 'Should return 413 Payload Too Large');
      assertEquals(result.error, true, 'Should have error');
      assertExists(result.message, 'Should have error message');
      assertEquals(
        result.message.includes('50MB'),
        true,
        'Error message should mention 50MB limit'
      );
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Handler: Rejects missing file parameter",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create form data without file
      const formData = new FormData();
      formData.append('file_type', 'leases');
      
      // Call upload-handler
      const response = await fetch(UPLOAD_HANDLER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`
        },
        body: formData
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 400, 'Should return 400 Bad Request');
      assertEquals(result.error, true, 'Should have error');
      assertEquals(result.message, 'Missing file parameter', 'Should have correct error message');
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Handler: Rejects missing file_type parameter",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create test file
      const testFile = createTestCSVFile('test-leases.csv');
      
      // Create form data without file_type
      const formData = new FormData();
      formData.append('file', testFile);
      
      // Call upload-handler
      const response = await fetch(UPLOAD_HANDLER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`
        },
        body: formData
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 400, 'Should return 400 Bad Request');
      assertEquals(result.error, true, 'Should have error');
      assertEquals(result.message, 'Missing file_type parameter', 'Should have correct error message');
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Handler: Rejects invalid file_type",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create test file
      const testFile = createTestCSVFile('test-file.csv');
      
      // Create form data with invalid file_type
      const formData = new FormData();
      formData.append('file', testFile);
      formData.append('file_type', 'invalid_type');
      
      // Call upload-handler
      const response = await fetch(UPLOAD_HANDLER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`
        },
        body: formData
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 400, 'Should return 400 Bad Request');
      assertEquals(result.error, true, 'Should have error');
      assertEquals(
        result.message.includes('Invalid file_type'),
        true,
        'Error message should mention invalid file_type'
      );
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Handler: Rejects unsupported file format",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create test file with unsupported format
      const testFile = new File(['test content'], 'test.txt', { type: 'text/plain' });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', testFile);
      formData.append('file_type', 'leases');
      
      // Call upload-handler
      const response = await fetch(UPLOAD_HANDLER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`
        },
        body: formData
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 400, 'Should return 400 Bad Request');
      assertEquals(result.error, true, 'Should have error');
      assertEquals(
        result.message.includes('Unsupported file format'),
        true,
        'Error message should mention unsupported format'
      );
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Handler: Rejects unauthorized requests",
  fn: async () => {
    const testFileIds: string[] = [];
    
    try {
      // Create test file
      const testFile = createTestCSVFile('test-leases.csv');
      
      // Create form data
      const formData = new FormData();
      formData.append('file', testFile);
      formData.append('file_type', 'leases');
      
      // Call upload-handler without authorization
      const response = await fetch(UPLOAD_HANDLER_URL, {
        method: 'POST',
        body: formData
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 400, 'Should return 400 Bad Request');
      assertEquals(result.error, true, 'Should have error');
      assertEquals(
        result.message.includes('Authorization'),
        true,
        'Error message should mention authorization'
      );
      
    } finally {
      // No cleanup needed as no data was created
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Handler: Supports all valid file types",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      const validFileTypes = ['leases', 'expenses', 'properties', 'revenue', 'cam', 'budgets'];
      
      for (const fileType of validFileTypes) {
        // Create test file
        const testFile = createTestCSVFile(`test-${fileType}.csv`);
        
        // Create form data
        const formData = new FormData();
        formData.append('file', testFile);
        formData.append('file_type', fileType);
        
        // Call upload-handler
        const response = await fetch(UPLOAD_HANDLER_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${user.accessToken}`
          },
          body: formData
        });
        
        const result = await response.json();
        
        // Assertions
        assertEquals(response.status, 200, `Should accept ${fileType} file type`);
        assertEquals(result.error, false, `Should not have error for ${fileType}`);
        assertExists(result.file_id, `Should return file_id for ${fileType}`);
        
        testFileIds.push(result.file_id);
        
        // Verify database record
        const { data: uploadRecord } = await adminClient
          .from('uploaded_files')
          .select('*')
          .eq('id', result.file_id)
          .single();
        
        assertEquals(uploadRecord.module_type, fileType, `Should have correct module_type for ${fileType}`);
      }
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});
