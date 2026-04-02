// @ts-nocheck
/**
 * Integration Tests: Lease Parser with Parse File Function
 * Feature: backend-driven-pipeline, Task 3.2
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Tests the integration of lease parser with parse-file Edge Function:
 * - Maps column variations to standardized field names
 * - Converts dates to ISO 8601 format
 * - Converts currency strings to numeric
 * - Preserves row numbers for error reporting
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
  
  const { error: uploadError } = await adminClient
    .storage
    .from('financial-uploads')
    .upload(storagePath, new Blob([csvContent], { type: 'text/csv' }), {
      contentType: 'text/csv',
      upsert: false
    });
  
  if (uploadError) throw new Error(`Failed to upload file: ${uploadError.message}`);
  
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
  for (const fileId of fileIds) {
    await adminClient.from('uploaded_files').delete().eq('id', fileId);
    await adminClient.storage.from('financial-uploads').remove([`${orgId}/${fileId}`]);
  }
  
  await adminClient.from('memberships').delete().eq('user_id', userId);
  await adminClient.auth.admin.deleteUser(userId);
  await adminClient.from('organizations').delete().eq('id', orgId);
}

const testFileIds: string[] = [];

Deno.test({
  name: "Lease Parser Integration: Maps tenant column variations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with 'tenant' instead of 'tenant_name'
      const csvContent = 'tenant,start_date,monthly_rent\nAcme Corp,2024-01-01,1000\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].tenant_name, 'Acme Corp', 'Should map tenant to tenant_name');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Lease Parser Integration: Converts dates to ISO 8601",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with MM/DD/YYYY date format
      const csvContent = 'tenant_name,start_date,end_date\nAcme Corp,01/15/2024,12/31/2025\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].start_date, '2024-01-15', 'Should convert to ISO 8601');
      assertEquals(result.parsed_data[0].end_date, '2025-12-31', 'Should convert to ISO 8601');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Lease Parser Integration: Converts currency to numeric",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with currency format
      const csvContent = 'tenant_name,monthly_rent\nAcme Corp,"$2,500.00"\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].monthly_rent, 2500, 'Should convert currency to numeric');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Lease Parser Integration: Preserves row numbers",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      const csvContent = 'tenant_name,monthly_rent\nTenant 1,1000\nTenant 2,1500\nTenant 3,2000\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0]._row_number, 2, 'First data row should be row 2');
      assertEquals(result.parsed_data[1]._row_number, 3, 'Second data row should be row 3');
      assertEquals(result.parsed_data[2]._row_number, 4, 'Third data row should be row 4');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Lease Parser Integration: Complete lease with all field mappings",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with various column name variations
      const csvContent = 'lessee,lease_start,expiration_date,base_rent,sqft,type,escalation,escalation_pct\nAcme Corp,01/01/2024,12/31/2026,"$2,500.00","1,500",triple_net,fixed,3.5\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      
      const lease = result.parsed_data[0];
      assertEquals(lease.tenant_name, 'Acme Corp');
      assertEquals(lease.start_date, '2024-01-01');
      assertEquals(lease.end_date, '2026-12-31');
      assertEquals(lease.monthly_rent, 2500);
      assertEquals(lease.square_footage, 1500);
      assertEquals(lease.lease_type, 'triple_net');
      assertEquals(lease.escalation_type, 'fixed');
      assertEquals(lease.escalation_rate, 3.5);
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Lease Parser Integration: Handles missing values as null",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with missing values
      const csvContent = 'tenant_name,start_date,end_date,monthly_rent\nAcme Corp,01/01/2024,,\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].tenant_name, 'Acme Corp');
      assertEquals(result.parsed_data[0].start_date, '2024-01-01');
      assertEquals(result.parsed_data[0].end_date, null, 'Missing end_date should be null');
      assertEquals(result.parsed_data[0].monthly_rent, null, 'Missing monthly_rent should be null');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});
