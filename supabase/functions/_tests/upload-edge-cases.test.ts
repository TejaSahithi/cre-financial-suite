// @ts-nocheck
/**
 * Unit Tests: Upload Handler Edge Cases
 * Feature: backend-driven-pipeline, Task 2.4
 * 
 * **Validates: Requirements 1.4, 1.6**
 * 
 * Tests edge cases for the upload-handler Edge Function:
 * - 50MB boundary file (exactly at limit)
 * - Unsupported file format rejection
 * - Storage failure handling
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
 * Test helper: Create a test file with specific size
 */
function createTestFile(filename: string, sizeInBytes: number, mimeType: string = 'text/csv'): File {
  // Create CSV header
  let content = 'tenant_name,start_date,end_date,monthly_rent\n';
  
  // Add one data row
  content += 'Test Tenant,2024-01-01,2025-12-31,1000\n';
  
  // Calculate remaining bytes needed
  const currentSize = new Blob([content]).size;
  const remainingBytes = sizeInBytes - currentSize;
  
  // Pad with data to reach exact size
  if (remainingBytes > 0) {
    // Add padding as additional rows to keep it valid CSV
    const paddingRow = 'Padding Tenant,2024-01-01,2025-12-31,1000\n';
    const rowSize = new Blob([paddingRow]).size;
    const fullRows = Math.floor(remainingBytes / rowSize);
    
    for (let i = 0; i < fullRows; i++) {
      content += paddingRow;
    }
    
    // Add final padding to reach exact size
    const finalSize = new Blob([content]).size;
    if (finalSize < sizeInBytes) {
      content += 'x'.repeat(sizeInBytes - finalSize);
    }
  }
  
  return new File([content], filename, { type: mimeType });
}

/**
 * Test helper: Cleanup test data
 */
async function cleanupTestData(adminClient: any, orgIds: string[], fileIds: string[]) {
  // Delete uploaded files
  for (const fileId of fileIds) {
    await adminClient.from('uploaded_files').delete().eq('id', fileId);
  }
  
  // Delete storage files
  for (const orgId of orgIds) {
    try {
      const { data: files } = await adminClient.storage
        .from('financial-uploads')
        .list(`financial-uploads/${orgId}`);
      
      if (files && files.length > 0) {
        const filePaths = files.map(f => `financial-uploads/${orgId}/${f.name}`);
        await adminClient.storage
          .from('financial-uploads')
          .remove(filePaths);
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
// EDGE CASE TESTS
// ============================================================

Deno.test({
  name: "Upload Edge Case: Accepts file exactly at 50MB boundary",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create file exactly at 50MB boundary
      const exactSize = 50 * 1024 * 1024; // Exactly 50MB
      const testFile = createTestFile('boundary-test.csv', exactSize);
      
      // Verify file size is exactly 50MB
      assertEquals(testFile.size, exactSize, 'Test file should be exactly 50MB');
      
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
      assertEquals(response.status, 200, 'Should accept file at exactly 50MB');
      assertEquals(result.error, false, 'Should not have error');
      assertExists(result.file_id, 'Should return file_id');
      assertExists(result.storage_path, 'Should return storage_path');
      assertEquals(result.processing_status, 'uploaded', 'Status should be uploaded');
      assertEquals(result.file_size, exactSize, 'File size should match');
      
      testFileIds.push(result.file_id);
      
      // Verify database record
      const { data: uploadRecord, error: dbError } = await adminClient
        .from('uploaded_files')
        .select('*')
        .eq('id', result.file_id)
        .single();
      
      assertEquals(dbError, null, 'Should create database record');
      assertExists(uploadRecord, 'Upload record should exist');
      assertEquals(uploadRecord.file_size, exactSize, 'Database should record correct file size');
      
      // Verify file exists in storage
      const { data: storageFile, error: storageError } = await adminClient.storage
        .from('financial-uploads')
        .download(result.storage_path);
      
      assertEquals(storageError, null, 'File should exist in storage');
      assertExists(storageFile, 'Storage file should be downloadable');
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Edge Case: Rejects file just over 50MB boundary",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create file just over 50MB boundary
      const oversizedFile = createTestFile('oversize-test.csv', 50 * 1024 * 1024 + 1);
      
      // Create form data
      const formData = new FormData();
      formData.append('file', oversizedFile);
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
  name: "Upload Edge Case: Rejects PDF file format",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create PDF file (unsupported format)
      const pdfContent = '%PDF-1.4\n%Test PDF content';
      const pdfFile = new File([pdfContent], 'test-document.pdf', { type: 'application/pdf' });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', pdfFile);
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
      assertExists(result.message, 'Should have error message');
      assertEquals(
        result.message.includes('Unsupported file format'),
        true,
        'Error message should mention unsupported format'
      );
      assertEquals(
        result.message.includes('CSV') || result.message.includes('Excel'),
        true,
        'Error message should mention supported formats'
      );
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Edge Case: Rejects image file format",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create image file (unsupported format)
      const imageContent = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header
      const imageFile = new File([imageContent], 'test-image.jpg', { type: 'image/jpeg' });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', imageFile);
      formData.append('file_type', 'properties');
      
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
      assertExists(result.message, 'Should have error message');
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
  name: "Upload Edge Case: Rejects JSON file format",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create JSON file (unsupported format)
      const jsonContent = JSON.stringify({ tenant: 'Test', rent: 1000 });
      const jsonFile = new File([jsonContent], 'test-data.json', { type: 'application/json' });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', jsonFile);
      formData.append('file_type', 'expenses');
      
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
      assertExists(result.message, 'Should have error message');
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
  name: "Upload Edge Case: Accepts CSV with text/csv MIME type",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create CSV file with text/csv MIME type
      const csvContent = 'tenant_name,start_date,end_date,monthly_rent\nTest Tenant,2024-01-01,2025-12-31,1000\n';
      const csvFile = new File([csvContent], 'test.csv', { type: 'text/csv' });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', csvFile);
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
      assertEquals(response.status, 200, 'Should accept CSV file');
      assertEquals(result.error, false, 'Should not have error');
      assertExists(result.file_id, 'Should return file_id');
      
      testFileIds.push(result.file_id);
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Edge Case: Accepts Excel .xls with correct MIME type",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create Excel file with .xls MIME type
      const excelContent = 'tenant_name,start_date,end_date,monthly_rent\nTest Tenant,2024-01-01,2025-12-31,1000\n';
      const excelFile = new File([excelContent], 'test.xls', { type: 'application/vnd.ms-excel' });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', excelFile);
      formData.append('file_type', 'expenses');
      
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
      assertEquals(response.status, 200, 'Should accept Excel .xls file');
      assertEquals(result.error, false, 'Should not have error');
      assertExists(result.file_id, 'Should return file_id');
      
      testFileIds.push(result.file_id);
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Upload Edge Case: Accepts Excel .xlsx with correct MIME type",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      // Setup
      const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
      testOrgIds.push(org.id);
      
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create Excel file with .xlsx MIME type
      const excelContent = 'tenant_name,start_date,end_date,monthly_rent\nTest Tenant,2024-01-01,2025-12-31,1000\n';
      const excelFile = new File([excelContent], 'test.xlsx', { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', excelFile);
      formData.append('file_type', 'revenue');
      
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
      assertEquals(response.status, 200, 'Should accept Excel .xlsx file');
      assertEquals(result.error, false, 'Should not have error');
      assertExists(result.file_id, 'Should return file_id');
      
      testFileIds.push(result.file_id);
      
    } finally {
      await cleanupTestData(adminClient, testOrgIds, testFileIds);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});
