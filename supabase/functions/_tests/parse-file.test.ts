// @ts-nocheck
/**
 * Unit Tests: Parse File Edge Function
 * Feature: backend-driven-pipeline, Task 3.1
 * 
 * **Validates: Requirements 2.1, 2.3, 2.4, 2.5, 2.6**
 * 
 * Tests the parse-file Edge Function which:
 * - Reads file from Supabase Storage by file_id
 * - Parses CSV into structured JSON with column headers
 * - Handles missing values as null
 * - Updates processing_status to 'parsed' or 'failed'
 * - Stores parsed_data in uploaded_files table
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Test configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PARSE_FILE_URL = `${SUPABASE_URL}/functions/v1/parse-file`;

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
  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
    email,
    password: 'test-password-123',
    email_confirm: true
  });
  
  if (authError) throw new Error(`Failed to create user: ${authError.message}`);
  
  const { error: membershipError } = await adminClient
    .from('memberships')
    .insert({
      user_id: authData.user.id,
      org_id: orgId,
      role: 'member',
      status: 'active'
    });
  
  if (membershipError) throw new Error(`Failed to create membership: ${membershipError.message}`);
  
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
 * Test helper: Upload a CSV file to storage and create uploaded_files record
 */
async function uploadTestFile(adminClient: any, orgId: string, csvContent: string, fileName: string = 'test.csv') {
  const fileId = crypto.randomUUID();
  const storagePath = `${orgId}/${fileId}`;
  
  // Upload to storage
  const { error: uploadError } = await adminClient
    .storage
    .from('financial-uploads')
    .upload(storagePath, new Blob([csvContent], { type: 'text/csv' }), {
      contentType: 'text/csv',
      upsert: false
    });
  
  if (uploadError) throw new Error(`Failed to upload file: ${uploadError.message}`);
  
  // Create uploaded_files record
  const { data: fileRecord, error: insertError } = await adminClient
    .from('uploaded_files')
    .insert({
      id: fileId,
      org_id: orgId,
      module_type: 'leases',
      file_name: fileName,
      file_url: `${SUPABASE_URL}/storage/v1/object/public/financial-uploads/${storagePath}`,
      file_size: new Blob([csvContent]).size,
      mime_type: 'text/csv',
      status: 'uploaded'
    })
    .select()
    .single();
  
  if (insertError) throw new Error(`Failed to create file record: ${insertError.message}`);
  
  return fileRecord;
}

/**
 * Test helper: Cleanup test data
 */
async function cleanup(adminClient: any, orgId: string, userId: string, fileIds: string[]) {
  // Delete uploaded files
  for (const fileId of fileIds) {
    await adminClient.from('uploaded_files').delete().eq('id', fileId);
    await adminClient.storage.from('financial-uploads').remove([`${orgId}/${fileId}`]);
  }
  
  // Delete membership
  await adminClient.from('memberships').delete().eq('user_id', userId);
  
  // Delete user
  await adminClient.auth.admin.deleteUser(userId);
  
  // Delete org
  await adminClient.from('organizations').delete().eq('id', orgId);
}

// Track test data for cleanup
const testFileIds: string[] = [];

Deno.test({
  name: "Parse File: Successfully parses a valid CSV file",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create test CSV file
      const csvContent = 'tenant_name,start_date,end_date,monthly_rent\nTest Tenant,2024-01-01,2025-12-31,1000\nAnother Tenant,2024-06-01,2026-05-31,1500\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      // Call parse-file function
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 200, 'Should return 200 status');
      assertEquals(result.error, false, 'Should not have error');
      assertEquals(result.processing_status, 'parsed', 'Status should be parsed');
      assertEquals(result.row_count, 2, 'Should have 2 rows');
      assertExists(result.parsed_data, 'Should return parsed_data');
      assertEquals(result.parsed_data.length, 2, 'Should have 2 parsed rows');
      
      // Verify parsed data structure
      assertEquals(result.parsed_data[0].tenant_name, 'Test Tenant');
      assertEquals(result.parsed_data[0].start_date, '2024-01-01');
      assertEquals(result.parsed_data[0].monthly_rent, '1000');
      
      // Verify database record was updated
      const { data: updatedRecord } = await adminClient
        .from('uploaded_files')
        .select('*')
        .eq('id', fileRecord.id)
        .single();
      
      assertEquals(updatedRecord.status, 'parsed', 'Database status should be parsed');
      assertEquals(updatedRecord.row_count, 2, 'Database should have row_count');
      assertExists(updatedRecord.parsed_data, 'Database should have parsed_data');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Parse File: Handles missing values as null",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create CSV with missing values
      const csvContent = 'tenant_name,start_date,end_date,monthly_rent\nTest Tenant,2024-01-01,,1000\n,2024-06-01,2026-05-31,\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      // Call parse-file function
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 200, 'Should return 200 status');
      assertEquals(result.error, false, 'Should not have error');
      assertEquals(result.parsed_data[0].end_date, null, 'Missing end_date should be null');
      assertEquals(result.parsed_data[1].tenant_name, null, 'Missing tenant_name should be null');
      assertEquals(result.parsed_data[1].monthly_rent, null, 'Missing monthly_rent should be null');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Parse File: Preserves column headers",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create CSV with specific headers
      const csvContent = 'property_name,address,city,state,zip_code\nTest Property,123 Main St,New York,NY,10001\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      // Call parse-file function
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 200, 'Should return 200 status');
      assertExists(result.headers, 'Should return headers');
      assertEquals(result.headers.length, 5, 'Should have 5 headers');
      assertEquals(result.headers[0], 'property_name', 'Should preserve property_name header');
      assertEquals(result.headers[4], 'zip_code', 'Should preserve zip_code header');
      
      // Verify parsed data has all headers as keys
      const row = result.parsed_data[0];
      assertExists(row.property_name, 'Should have property_name key');
      assertExists(row.address, 'Should have address key');
      assertExists(row.zip_code, 'Should have zip_code key');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Parse File: Handles quoted values with commas",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create CSV with quoted values containing commas
      const csvContent = 'tenant_name,address,monthly_rent\n"Smith, John","123 Main St, Apt 4",1000\n"Doe, Jane","456 Oak Ave, Suite 200",1500\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      // Call parse-file function
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(response.status, 200, 'Should return 200 status');
      assertEquals(result.parsed_data[0].tenant_name, 'Smith, John', 'Should preserve comma in quoted value');
      assertEquals(result.parsed_data[0].address, '123 Main St, Apt 4', 'Should preserve comma in address');
      assertEquals(result.parsed_data[1].tenant_name, 'Doe, Jane', 'Should handle multiple quoted values');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Parse File: Fails with descriptive error for empty file",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // Create empty CSV file
      const csvContent = '';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      // Call parse-file function
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(result.error, true, 'Should have error');
      assertExists(result.message, 'Should have error message');
      assertEquals(result.message.includes('empty'), true, 'Error should mention empty file');
      
      // Verify database record was updated to failed
      const { data: updatedRecord } = await adminClient
        .from('uploaded_files')
        .select('*')
        .eq('id', fileRecord.id)
        .single();
      
      assertEquals(updatedRecord.status, 'failed', 'Database status should be failed');
      assertExists(updatedRecord.error_message, 'Database should have error_message');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Parse File: Rejects file from different org_id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org1 = await createTestOrg(adminClient, `Test Org 1 ${Date.now()}`);
    const org2 = await createTestOrg(adminClient, `Test Org 2 ${Date.now()}`);
    
    try {
      const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);
      
      // Create file for org2
      const csvContent = 'tenant_name,monthly_rent\nTest Tenant,1000\n';
      const fileRecord = await uploadTestFile(adminClient, org2.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      // Try to parse with user1 (from org1)
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user1.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      // Assertions
      assertEquals(result.error, true, 'Should have error');
      assertExists(result.message, 'Should have error message');
      assertEquals(result.message.includes('not found'), true, 'Error should indicate file not found');
      
      await cleanup(adminClient, org1.id, user1.userId, []);
      await cleanup(adminClient, org2.id, '', testFileIds);
      await adminClient.from('organizations').delete().eq('id', org2.id);
    } catch (error) {
      await cleanup(adminClient, org1.id, '', []);
      await cleanup(adminClient, org2.id, '', testFileIds);
      throw error;
    }
  }
});
